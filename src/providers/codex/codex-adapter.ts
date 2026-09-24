import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import type { ThreadStartResponse } from "../../../generated/codex/v2/ThreadStartResponse.js";
import type { ThreadResumeResponse } from "../../../generated/codex/v2/ThreadResumeResponse.js";
import type { TurnStartResponse } from "../../../generated/codex/v2/TurnStartResponse.js";
import type { ThreadGoalGetResponse } from "../../../generated/codex/v2/ThreadGoalGetResponse.js";
import type { ThreadGoalSetResponse } from "../../../generated/codex/v2/ThreadGoalSetResponse.js";
import type { ThreadGoalClearResponse } from "../../../generated/codex/v2/ThreadGoalClearResponse.js";
import type { ThreadReadResponse } from "../../../generated/codex/v2/ThreadReadResponse.js";
import type { AskForApproval } from "../../../generated/codex/v2/AskForApproval.js";
import type { SandboxMode } from "../../../generated/codex/v2/SandboxMode.js";
import type {
  AgentAdapter,
  ApprovalDecision,
  NativeSession,
  NativeTurn,
  ProviderEvent,
  ResumeSessionOptions,
  StartSessionOptions,
} from "../types.js";
import type {
  Approval,
  MessageDelivery,
  NativeGoal,
  PermissionPolicy,
  ProviderCapabilities,
  SessionHistory,
} from "../../protocol/types.js";
import { createId } from "../../shared/ids.js";
import { GatewayError } from "../../shared/errors.js";
import type { RpcNotification, RpcRequest } from "./json-rpc-peer.js";
import { CodexWorker } from "./codex-worker.js";
import { normalizeCodexHistory, normalizeCodexRollout } from "../history.js";
import { toolPermissionDecision } from "../tool-permissions.js";

interface PendingApproval {
  request: RpcRequest;
  approval: Approval;
}

export class CodexAdapter implements AgentAdapter {
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    approvals: true,
    clarifyQuestions: true,
    nativeGoal: true,
    steerCurrentTurn: true,
    queueMessages: true,
    interrupt: true,
    switchModelNextTurn: true,
    changePermissionLive: false,
    mutateToolInput: false,
    resumeSession: true,
  };

  readonly runtimeId: string;
  private readonly events = new EventEmitter();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly models = new Map<string, string>();
  private readonly permissionPolicies = new Map<string, PermissionPolicy>();

  constructor(
    private readonly worker: CodexWorker,
    private readonly instructions?: string,
    private readonly mcpServer?: StartSessionOptions["mcpServer"],
  ) {
    this.runtimeId = worker.options.id;
    worker.rpc.on("notification", (notification: RpcNotification) => this.handleNotification(notification));
    worker.rpc.on("request", (request: RpcRequest) => this.handleRequest(request));
    worker.rpc.on("exit", (error) => this.emit({ type: "provider.error", payload: error }));
  }

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async createSession(options: StartSessionOptions): Promise<NativeSession> {
    const policy = options.permissionPolicy ?? { mode: "prompt" };
    const response = await this.worker.rpc.request<ThreadStartResponse>("thread/start", {
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      approvalPolicy: this.codexApprovalPolicy(policy),
      sandbox: this.codexSandboxMode(policy),
      serviceName: "agent-gateway",
      ...(options.instructions ?? this.instructions
        ? { developerInstructions: options.instructions ?? this.instructions }
        : {}),
    });
    const session = {
      id: response.thread.sessionId,
      threadId: response.thread.id,
      model: response.model,
      modelProvider: response.modelProvider,
    };
    this.permissionPolicies.set(session.threadId, policy);
    if (options.model) this.models.set(session.threadId, options.model);
    return session;
  }

  async resumeSession(options: ResumeSessionOptions): Promise<NativeSession> {
    const policy = options.permissionPolicy ?? { mode: "prompt" };
    const response = await this.worker.rpc.request<ThreadResumeResponse>("thread/resume", {
      threadId: options.threadId,
      cwd: options.cwd,
      ...(options.model ? { model: options.model } : {}),
      ...(options.modelProvider ? { modelProvider: options.modelProvider } : {}),
      approvalPolicy: this.codexApprovalPolicy(policy),
      sandbox: this.codexSandboxMode(policy),
      excludeTurns: true,
      ...(options.instructions ?? this.instructions
        ? { developerInstructions: options.instructions ?? this.instructions }
        : {}),
    });
    const session = {
      id: response.thread.sessionId,
      threadId: response.thread.id,
      model: response.model,
      modelProvider: response.modelProvider,
    };
    this.permissionPolicies.set(session.threadId, policy);
    if (options.model) this.models.set(session.threadId, options.model);
    return session;
  }

  async startTurn(session: NativeSession, prompt: string, model?: string): Promise<NativeTurn> {
    const effectiveModel = model ?? this.models.get(session.threadId);
    const policy = this.permissionPolicies.get(session.threadId) ?? { mode: "prompt" };
    const response = await this.worker.rpc.request<TurnStartResponse>("turn/start", {
      threadId: session.threadId,
      input: [{ type: "text", text: prompt }],
      ...(effectiveModel ? { model: effectiveModel } : {}),
      approvalPolicy: this.codexApprovalPolicy(policy),
      sandboxPolicy: this.codexSandboxPolicy(policy),
    });
    return { id: response.turn.id, status: response.turn.status };
  }

  async sendMessage(
    session: NativeSession,
    activeTurnId: string | undefined,
    content: string,
    delivery: MessageDelivery,
  ): Promise<{ actualDelivery: MessageDelivery; turn?: NativeTurn }> {
    const actual = delivery === "auto" ? (activeTurnId ? "steer" : "queue") : delivery;
    if (actual === "steer") {
      if (!activeTurnId) throw new GatewayError("TURN_NOT_ACTIVE", "There is no active turn to steer");
      await this.worker.rpc.request("turn/steer", {
        threadId: session.threadId,
        expectedTurnId: activeTurnId,
        input: [{ type: "text", text: content }],
      });
      return { actualDelivery: "steer" };
    }
    if (actual === "interrupt") {
      if (activeTurnId) await this.interrupt(session, activeTurnId);
      return { actualDelivery: "interrupt" };
    }
    if (activeTurnId) return { actualDelivery: "queue" };
    return { actualDelivery: "queue", turn: await this.startTurn(session, content) };
  }

  async getHistory(session: NativeSession): Promise<SessionHistory> {
    try {
      const response = await this.worker.rpc.request<ThreadReadResponse>("thread/read", {
        threadId: session.threadId,
        includeTurns: true,
      });
      return normalizeCodexHistory(response.thread);
    } catch (error) {
      // Codex 0.155 exposes thread/read in its generated protocol but some
      // rollout backends reject its internal list_turns operation. Ask Codex
      // for the native rollout path and read that provider-owned transcript.
      if (!(error instanceof Error) || !error.message.includes("list_turns is not supported yet")) throw error;
      const response = await this.worker.rpc.request<ThreadReadResponse>("thread/read", {
        threadId: session.threadId,
        includeTurns: false,
      });
      if (!response.thread.path) return { source: "native", messages: [] };
      return normalizeCodexRollout(await readFile(response.thread.path, "utf8"));
    }
  }

  async interrupt(session: NativeSession, turnId: string): Promise<void> {
    await this.worker.rpc.request("turn/interrupt", { threadId: session.threadId, turnId });
  }

  async detachSession(session: NativeSession): Promise<void> {
    await this.worker.rpc.request("thread/unsubscribe", { threadId: session.threadId });
    this.models.delete(session.threadId);
    this.permissionPolicies.delete(session.threadId);
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new GatewayError("APPROVAL_NOT_PENDING", "Approval is not pending");
    const { request } = pending;
    let result: unknown;
    if (request.method === "item/tool/requestUserInput") {
      result = { answers: decision.answers ?? {} };
    } else if (request.method === "item/permissions/requestApproval") {
      result = {
        permissions: decision.type.startsWith("allow") ? (decision.permissions ?? request.params.permissions) : {},
        scope: decision.scope ?? "turn",
      };
    } else if (request.method === "mcpServer/elicitation/request") {
      result = decision.type.startsWith("allow")
        ? { action: "accept", content: decision.updatedInput ?? {} }
        : { action: decision.type === "cancel" ? "cancel" : "decline", content: null };
    } else {
      const mapped =
        decision.type === "allow_session"
          ? "acceptForSession"
          : decision.type === "allow_once" || decision.type === "allow_with_changes"
            ? "accept"
            : decision.type === "cancel"
              ? "cancel"
              : "decline";
      result = { decision: mapped };
    }
    this.worker.rpc.respond(request.id, result);
    this.approvals.delete(approvalId);
    this.emit({
      type: "approval.resolved",
      ...(request.params?.threadId ? { nativeThreadId: request.params.threadId as string } : {}),
      ...(pending.approval.nativeTurnId ? { nativeTurnId: pending.approval.nativeTurnId } : {}),
      payload: { approvalId, decision: decision.type },
    });
  }

  async changeModel(session: NativeSession, model: string): Promise<{ effectiveAt: "next_turn" }> {
    this.models.set(session.threadId, model);
    return { effectiveAt: "next_turn" };
  }

  async changePermissions(
    session: NativeSession,
    policy: PermissionPolicy,
  ): Promise<{ effectiveAt: "next_turn" }> {
    this.permissionPolicies.set(session.threadId, policy);
    return { effectiveAt: "next_turn" };
  }

  async getGoal(session: NativeSession): Promise<NativeGoal | null> {
    const response = await this.worker.rpc.request<ThreadGoalGetResponse>("thread/goal/get", {
      threadId: session.threadId,
    });
    return response.goal as NativeGoal | null;
  }

  async setGoal(
    session: NativeSession,
    goal: { objective?: string; status?: string; tokenBudget?: number | null },
  ): Promise<NativeGoal> {
    const response = await this.worker.rpc.request<ThreadGoalSetResponse>("thread/goal/set", {
      threadId: session.threadId,
      ...goal,
    });
    return response.goal as NativeGoal;
  }

  async clearGoal(session: NativeSession): Promise<boolean> {
    const response = await this.worker.rpc.request<ThreadGoalClearResponse>("thread/goal/clear", {
      threadId: session.threadId,
    });
    return response.cleared;
  }

  async compact(session: NativeSession): Promise<void> {
    await this.worker.rpc.request("thread/compact/start", { threadId: session.threadId });
  }

  async close(): Promise<void> {
    // The RuntimeManager owns the shared worker lifecycle.
  }

  private handleRequest(request: RpcRequest): void {
    const params = request.params ?? {};
    const toolName = String(params.toolName ?? params.name ?? params.tool ?? request.method);
    const approvalId = createId("apr");
    const kind = request.method.includes("commandExecution")
      ? "command"
      : request.method.includes("fileChange")
        ? "file_change"
        : request.method.includes("permissions")
          ? "permission"
          : request.method.includes("requestUserInput") || request.method.includes("elicitation")
            ? "question"
            : "permission";
    const approval: Approval = {
      id: approvalId,
      sessionId: "",
      nativeRequestId: request.id,
      ...(params.turnId ? { nativeTurnId: params.turnId } : {}),
      ...(params.itemId ? { nativeToolCallId: params.itemId } : {}),
      kind,
      status: "pending",
      title: params.reason ?? request.method,
      toolName,
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.command ? { input: { command: params.command, cwd: params.cwd } } : {}),
      ...(!params.command ? { input: params.questions ?? params.permissions ?? params } : {}),
      availableDecisions: params.availableDecisions ?? ["allow_once", "allow_session", "deny", "cancel"],
    };
    this.approvals.set(approvalId, { request, approval });
    const threadId = String(params.threadId ?? "");
    const policy = this.permissionPolicies.get(threadId);
    const decision = policy ? toolPermissionDecision(policy, toolName) : "prompt";
    if (decision !== "prompt") {
      void this.resolveApproval(approvalId, { type: decision === "allow" ? "allow_once" : "deny" });
      return;
    }
    this.emit({
      type: "approval.required",
      ...(params.threadId ? { nativeThreadId: params.threadId } : {}),
      ...(params.turnId ? { nativeTurnId: params.turnId } : {}),
      payload: approval,
    });
  }

  private handleNotification(notification: RpcNotification): void {
    const params = notification.params ?? {};
    const turnId = params.turnId ?? params.turn?.id;
    const base = {
      ...(params.threadId ? { nativeThreadId: params.threadId as string } : {}),
      ...(turnId ? { nativeTurnId: turnId as string } : {}),
    };
    const mappings: Record<string, string> = {
      "turn/started": "turn.started",
      "turn/completed": "turn.completed",
      "item/agentMessage/delta": "assistant.delta",
      "item/reasoning/textDelta": "reasoning.delta",
      "item/reasoning/summaryTextDelta": "reasoning.delta",
      "item/commandExecution/outputDelta": "tool.output.delta",
      "item/started": "tool.started",
      "item/completed": "tool.completed",
      "thread/goal/updated": "goal.updated",
      "thread/goal/cleared": "goal.cleared",
      error: "provider.error",
    };
    const type = mappings[notification.method] ?? `provider.${notification.method.replaceAll("/", ".")}`;
    this.emit({ type, ...base, payload: params });
  }

  private emit(event: ProviderEvent): void {
    this.events.emit("event", event);
  }

  private codexApprovalPolicy(policy: PermissionPolicy): AskForApproval {
    if (policy.approvalPolicy) return policy.approvalPolicy as AskForApproval;
    return policy.mode === "full" ? "never" : "on-request";
  }

  private codexSandboxMode(policy: PermissionPolicy): SandboxMode {
    if (policy.sandboxMode) return policy.sandboxMode as SandboxMode;
    if (policy.mode === "plan") return "read-only";
    if (policy.mode === "full") return "danger-full-access";
    return "workspace-write";
  }

  private codexSandboxPolicy(policy: PermissionPolicy): Record<string, unknown> {
    const mode = this.codexSandboxMode(policy);
    if (mode === "read-only") return { type: "readOnly" };
    if (mode === "danger-full-access") return { type: "dangerFullAccess" };
    return { type: "workspaceWrite", networkAccess: true };
  }
}
