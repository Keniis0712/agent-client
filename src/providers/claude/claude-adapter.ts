import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  query,
  type PermissionMode as ClaudePermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  Approval,
  MessageDelivery,
  NativeGoal,
  PermissionPolicy,
  ProviderCapabilities,
  RuntimeProfileInput,
  SessionHistory,
} from "../../protocol/types.js";
import type {
  AgentAdapter,
  ApprovalDecision,
  NativeSession,
  NativeTurn,
  ProviderEvent,
  ResumeSessionOptions,
  StartSessionOptions,
} from "../types.js";
import { AsyncQueue } from "../../shared/async-queue.js";
import { createId } from "../../shared/ids.js";
import { GatewayError } from "../../shared/errors.js";
import { normalizeClaudeHistory } from "../history.js";
import { toolPermissionDecision } from "../tool-permissions.js";

interface HistoryReadableSessionStore extends SessionStore {
  loadSessionEntries(sessionId: string): Promise<SessionStoreEntry[]>;
}

interface ClaudeSessionContext {
  native: NativeSession;
  input: AsyncQueue<SDKUserMessage>;
  query: Query;
  activeTurnId?: string;
  permissionPolicy: PermissionPolicy;
  activeGoal?: ClaudeGoalValue | null;
  goalWaiter?: ClaudeGoalWaiter;
}

interface ClaudeGoalValue {
  condition: string;
  iterations: number;
  set_at: number;
  tokens_at_start: number;
  last_reason?: string;
}

interface ClaudeGoalWaiter {
  operation: "get" | "set" | "clear";
  resolve: (goal: NativeGoal | null) => void;
  reject: (error: unknown) => void;
  timer: NodeJS.Timeout;
}

interface PendingClaudeApproval {
  resolve: (result: PermissionResult) => void;
  reject: (reason: unknown) => void;
  approval: Approval;
  input: Record<string, unknown>;
  suggestions?: unknown[];
}

export class ClaudeAdapter implements AgentAdapter {
  readonly capabilities: ProviderCapabilities = {
    streaming: true,
    approvals: true,
    clarifyQuestions: true,
    nativeGoal: true,
    steerCurrentTurn: false,
    queueMessages: true,
    interrupt: true,
    switchModelNextTurn: true,
    changePermissionLive: true,
    mutateToolInput: true,
    resumeSession: true,
  };

  private readonly events = new EventEmitter();
  private readonly sessions = new Map<string, ClaudeSessionContext>();
  private readonly approvals = new Map<string, PendingClaudeApproval>();

  constructor(
    public readonly runtimeId: string,
    private readonly cwd: string,
    private readonly profile?: RuntimeProfileInput,
    private readonly sessionStore?: SessionStore,
    private readonly profileConfigDir?: string,
    private readonly instructions?: string,
    private readonly mcpServer?: StartSessionOptions["mcpServer"],
    private readonly skillPlugin?: { path: string; skillNames: string[] },
    private readonly builtInTools?: string[],
  ) {}

  onEvent(listener: (event: ProviderEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  async createSession(options: StartSessionOptions): Promise<NativeSession> {
    return this.openSession(options);
  }

  async resumeSession(options: ResumeSessionOptions): Promise<NativeSession> {
    return this.openSession(options, options.threadId);
  }

  async startTurn(session: NativeSession, prompt: string, model?: string): Promise<NativeTurn> {
    const context = this.context(session);
    if (model ?? context.native.model) await context.query.setModel(model ?? context.native.model);
    const turnId = createId("claude_turn");
    context.activeTurnId = turnId;
    context.input.push(this.userMessage(prompt, turnId, context.native.threadId));
    this.emit({ type: "turn.started", nativeThreadId: session.threadId, nativeTurnId: turnId, payload: {} });
    return { id: turnId, status: "inProgress" };
  }

  async sendMessage(
    session: NativeSession,
    activeTurnId: string | undefined,
    content: string,
    delivery: MessageDelivery,
  ): Promise<{ actualDelivery: MessageDelivery; turn?: NativeTurn }> {
    const context = this.context(session);
    const actual = delivery === "auto" || delivery === "steer" ? "queue" : delivery;
    if (actual === "interrupt") {
      await context.query.interrupt();
      const turn = await this.startTurn(session, content);
      return { actualDelivery: "interrupt", turn };
    }
    if (!activeTurnId) return { actualDelivery: "queue", turn: await this.startTurn(session, content) };
    context.input.push(this.userMessage(content, createId("claude_msg"), context.native.threadId));
    return { actualDelivery: "queue" };
  }

  async getHistory(session: NativeSession): Promise<SessionHistory> {
    const store = this.sessionStore as HistoryReadableSessionStore | undefined;
    if (!store?.loadSessionEntries) {
      throw new GatewayError("NATIVE_HISTORY_UNAVAILABLE", "Claude native transcript store is unavailable");
    }
    return normalizeClaudeHistory(await store.loadSessionEntries(session.threadId));
  }

  async interrupt(session: NativeSession, _turnId: string): Promise<void> {
    await this.context(session).query.interrupt();
  }

  async detachSession(session: NativeSession): Promise<void> {
    const context = this.context(session);
    this.rejectGoalWaiter(context, new GatewayError("SESSION_CLOSED", "Claude session was detached"));
    context.input.close();
    context.query.close();
    this.sessions.delete(session.threadId);
    this.sessions.delete(session.id);
  }

  async resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.approvals.get(approvalId);
    if (!pending) throw new GatewayError("APPROVAL_NOT_PENDING", "Approval is not pending");
    if (!decision || !["allow_once", "allow_session", "allow_with_changes", "deny", "cancel"].includes(decision.type)) {
      throw new GatewayError("APPROVAL_DECISION_INVALID", "Approval decision requires a valid type");
    }
    if (decision.type === "allow_with_changes" && !decision.updatedInput) {
      throw new GatewayError("APPROVAL_DECISION_INVALID", "allow_with_changes requires updatedInput");
    }
    this.approvals.delete(approvalId);
    if (decision.type === "allow_once" || decision.type === "allow_with_changes" || decision.type === "allow_session") {
      pending.resolve({
        behavior: "allow",
        updatedInput: decision.updatedInput ?? pending.input,
        ...(decision.type === "allow_session" && pending.suggestions
          ? { updatedPermissions: pending.suggestions as any }
          : {}),
      });
    } else {
      pending.resolve({ behavior: "deny", message: decision.message ?? "User denied this action" });
    }
    this.emit({ type: "approval.resolved", payload: { approvalId, decision: decision.type } });
  }

  async changeModel(session: NativeSession, model: string): Promise<{ effectiveAt: "next_turn" }> {
    const context = this.context(session);
    context.native.model = model;
    await context.query.setModel(model);
    return { effectiveAt: "next_turn" };
  }

  async changePermissions(
    session: NativeSession,
    policy: PermissionPolicy,
  ): Promise<{ effectiveAt: "next_tool_call" }> {
    const context = this.context(session);
    context.permissionPolicy = policy;
    await context.query.setPermissionMode(this.claudePermissionMode(policy));
    return { effectiveAt: "next_tool_call" };
  }

  async getGoal(session: NativeSession): Promise<NativeGoal | null> {
    const context = this.context(session);
    if (context.activeGoal !== undefined) return this.nativeGoal(context);
    return this.runGoalCommand(context, "get", "/goal");
  }

  async setGoal(
    session: NativeSession,
    goal: { objective?: string; status?: string; tokenBudget?: number | null },
  ): Promise<NativeGoal> {
    const objective = goal.objective?.trim().replace(/\s+/g, " ");
    if (!objective) throw new GatewayError("GOAL_INVALID", "Claude Goal requires an objective");
    if (goal.tokenBudget != null) {
      throw new GatewayError("GOAL_TOKEN_BUDGET_UNSUPPORTED", "Claude /goal does not accept a token budget");
    }
    if (goal.status && goal.status !== "active") {
      throw new GatewayError("GOAL_STATUS_UNSUPPORTED", "Claude /goal can only be set active or cleared");
    }
    const context = this.context(session);
    if (context.activeTurnId) await context.query.interrupt();
    const turnId = createId("claude_goal");
    context.activeTurnId = turnId;
    this.emit({ type: "turn.started", nativeThreadId: session.threadId, nativeTurnId: turnId, payload: { source: "goal" } });
    const result = await this.runGoalCommand(context, "set", `/goal ${objective}`);
    if (!result) throw new GatewayError("GOAL_SET_FAILED", "Claude did not return an active Goal");
    return result;
  }

  async clearGoal(session: NativeSession): Promise<boolean> {
    const context = this.context(session);
    const hadGoal = context.activeGoal !== null;
    if (context.activeTurnId) await context.query.interrupt();
    const result = await this.runGoalCommand(context, "clear", "/goal clear");
    return hadGoal && result === null;
  }

  async compact(session: NativeSession): Promise<void> {
    const context = this.context(session);
    context.input.push(this.userMessage("/compact", createId("claude_compact"), context.native.threadId));
  }

  async close(): Promise<void> {
    for (const context of this.sessions.values()) {
      context.input.close();
      context.query.close();
    }
    this.sessions.clear();
    for (const pending of this.approvals.values()) pending.reject(new Error("Claude runtime closed"));
    this.approvals.clear();
  }

  private async openSession(options: StartSessionOptions, resume?: string): Promise<NativeSession> {
    const provisionalId = resume ?? randomUUID();
    const native: NativeSession = {
      id: provisionalId,
      threadId: provisionalId,
      model: options.model ?? this.profile?.model,
      modelProvider: "anthropic",
    };
    const input = new AsyncQueue<SDKUserMessage>();
    const permissionPolicy = options.permissionPolicy ?? { mode: "prompt" };
    let context!: ClaudeSessionContext;
    const q = query({
      prompt: input,
      options: {
        cwd: options.cwd ?? this.cwd,
        ...(resume ? { resume } : {}),
        ...(!resume ? { sessionId: provisionalId } : {}),
        ...(native.model ? { model: native.model } : {}),
        ...(this.profile
          ? { settingSources: [] }
          : this.builtInTools !== undefined
            ? { settingSources: ["user" as const] }
            : {}),
        ...(this.builtInTools !== undefined
          ? { managedSettings: { disableBundledSkills: true } }
          : {}),
        persistSession: true,
        ...(this.sessionStore
          ? { sessionStore: this.sessionStore, sessionStoreFlush: "eager" as const }
          : {}),
        includePartialMessages: true,
        ...(this.builtInTools ? { tools: this.builtInTools } : {}),
        ...(this.skillPlugin
          ? {
              plugins: [{ type: "local" as const, path: this.skillPlugin.path, skipMcpDiscovery: true }],
              pluginDelivery: "initialize" as const,
              skills: this.skillPlugin.skillNames,
            }
          : {}),
        permissionMode: this.claudePermissionMode(permissionPolicy),
        ...(this.builtInTools === undefined ? { allowedTools: permissionPolicy.allowedTools } : {}),
        disallowedTools: permissionPolicy.disallowedTools,
        env: this.claudeEnv(),
        canUseTool: async (toolName, toolInput, control) =>
          this.waitForApproval(context, toolName, toolInput, control.signal, control.suggestions),
        ...((options.instructions ?? this.instructions)
          ? {
              systemPrompt: {
                type: "preset" as const,
                preset: "claude_code" as const,
                append: options.instructions ?? this.instructions,
                snapshot: true,
              },
            }
          : {}),
        ...((options.mcpServer ?? this.mcpServer)
          ? {
              mcpServers: {
                agent_project_console: {
                  type: "stdio" as const,
                  ...(options.mcpServer ?? this.mcpServer)!,
                  alwaysLoad: true,
                },
              },
            }
          : {}),
      },
    });
    context = { native, input, query: q, permissionPolicy };
    this.sessions.set(provisionalId, context);
    void this.consume(context);
    try {
      await q.initializationResult();
      return native;
    } catch (error) {
      input.close();
      q.close();
      this.sessions.delete(provisionalId);
      throw error;
    }
  }

  private async consume(context: ClaudeSessionContext): Promise<void> {
    try {
      for await (const message of context.query) this.handleMessage(context, message);
    } catch (error) {
      this.emit({
        type: "provider.error",
        nativeThreadId: context.native.threadId,
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private handleMessage(context: ClaudeSessionContext, message: SDKMessage): void {
    const anyMessage = message as any;
    if (message.type === "system" && anyMessage.subtype === "init") {
      const previous = context.native.threadId;
      context.native.id = anyMessage.session_id;
      context.native.threadId = anyMessage.session_id;
      context.native.model = anyMessage.model;
      if (previous !== anyMessage.session_id) {
        this.sessions.delete(previous);
        this.sessions.set(anyMessage.session_id, context);
      }
      this.emit({ type: "session.started", nativeThreadId: anyMessage.session_id, payload: anyMessage });
      return;
    }
    if (anyMessage.type === "active_goal") {
      context.activeGoal = anyMessage.value as ClaudeGoalValue | null;
      const goal = this.nativeGoal(context);
      this.emit({
        type: goal ? "goal.updated" : "goal.cleared",
        nativeThreadId: context.native.threadId,
        nativeTurnId: context.activeTurnId,
        payload: goal ? { goal } : {},
      });
      if (context.goalWaiter) this.resolveGoalWaiter(context, goal);
      return;
    }
    if (message.type === "stream_event") {
      const event = anyMessage.event;
      if (event?.type === "content_block_delta") {
        const delta = event.delta ?? {};
        if (delta.type === "text_delta") {
          this.emit({
            type: "assistant.delta",
            nativeThreadId: context.native.threadId,
            nativeTurnId: context.activeTurnId,
            payload: { delta: delta.text },
          });
        } else if (delta.type === "thinking_delta") {
          this.emit({
            type: "reasoning.delta",
            nativeThreadId: context.native.threadId,
            nativeTurnId: context.activeTurnId,
            payload: { delta: delta.thinking },
          });
        }
      }
      return;
    }
    if (message.type === "assistant") {
      if (anyMessage.local_command_run?.command === "goal") {
        this.handleGoalCommandOutput(context, anyMessage);
      }
      for (const block of anyMessage.message?.content ?? []) {
        if (block.type === "tool_use") {
          this.emit({
            type: "tool.started",
            nativeThreadId: context.native.threadId,
            nativeTurnId: context.activeTurnId,
            payload: block,
          });
        }
      }
      return;
    }
    if (message.type === "user") {
      for (const block of anyMessage.message?.content ?? []) {
        if (block.type === "tool_result") {
          this.emit({
            type: "tool.completed",
            nativeThreadId: context.native.threadId,
            nativeTurnId: context.activeTurnId,
            payload: block,
          });
        }
      }
      return;
    }
    if (message.type === "result") {
      this.emit({
        type: "turn.completed",
        nativeThreadId: context.native.threadId,
        nativeTurnId: context.activeTurnId,
        payload: anyMessage,
      });
      context.activeTurnId = undefined;
    }
  }

  private waitForApproval(
    context: ClaudeSessionContext,
    toolName: string,
    input: Record<string, unknown>,
    signal: AbortSignal,
    suggestions?: unknown[],
  ): Promise<PermissionResult> {
    const decision = toolPermissionDecision(context.permissionPolicy, toolName);
    if (decision === "allow") return Promise.resolve({ behavior: "allow", updatedInput: input });
    if (decision === "deny") return Promise.resolve({ behavior: "deny", message: `Tool ${toolName} is denied by the session policy` });
    const approvalId = createId("apr");
    const approval: Approval = {
      id: approvalId,
      sessionId: "",
      nativeRequestId: approvalId,
      ...(context.activeTurnId ? { nativeTurnId: context.activeTurnId } : {}),
      kind:
        toolName === "AskUserQuestion"
          ? "question"
          : ["Edit", "Write", "NotebookEdit"].includes(toolName)
            ? "file_change"
            : "command",
      status: "pending",
      title: toolName,
      toolName,
      input,
      availableDecisions: ["allow_once", "allow_session", "allow_with_changes", "deny", "cancel"],
    };
    return new Promise<PermissionResult>((resolve, reject) => {
      this.approvals.set(approvalId, {
        resolve,
        reject,
        approval,
        input,
        ...(suggestions ? { suggestions } : {}),
      });
      signal.addEventListener(
        "abort",
        () => {
          this.approvals.delete(approvalId);
          resolve({ behavior: "deny", message: "Turn interrupted" });
        },
        { once: true },
      );
      this.emit({
        type: "approval.required",
        nativeThreadId: context.native.threadId,
        nativeTurnId: context.activeTurnId,
        payload: approval,
      });
    });
  }

  private context(session: NativeSession): ClaudeSessionContext {
    const context = this.sessions.get(session.threadId) ?? this.sessions.get(session.id);
    if (!context) throw new GatewayError("SESSION_NOT_FOUND", "Claude session is not loaded");
    return context;
  }

  private runGoalCommand(
    context: ClaudeSessionContext,
    operation: ClaudeGoalWaiter["operation"],
    command: string,
  ): Promise<NativeGoal | null> {
    if (context.goalWaiter) throw new GatewayError("GOAL_COMMAND_PENDING", "Another Claude Goal command is pending");
    return new Promise<NativeGoal | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        context.goalWaiter = undefined;
        reject(new GatewayError("GOAL_COMMAND_TIMEOUT", `Claude ${operation} Goal command timed out`, true));
      }, 15_000);
      context.goalWaiter = { operation, resolve, reject, timer };
      context.input.push(this.userMessage(command, createId("claude_goal_cmd"), context.native.threadId));
    });
  }

  private handleGoalCommandOutput(context: ClaudeSessionContext, message: any): void {
    const waiter = context.goalWaiter;
    if (!waiter) return;
    const text = (message.message?.content ?? [])
      .filter((block: any) => block.type === "text")
      .map((block: any) => String(block.text ?? ""))
      .join("\n")
      .trim();
    const args = String(message.local_command_run?.args ?? "").trim();
    if (waiter.operation === "set" && /^Goal set:/i.test(text)) {
      context.activeGoal = {
        condition: args || text.replace(/^Goal set:\s*/i, ""),
        iterations: 0,
        set_at: Date.now(),
        tokens_at_start: 0,
      };
      this.resolveGoalWaiter(context, this.nativeGoal(context));
      return;
    }
    if (waiter.operation === "clear") {
      context.activeGoal = null;
      this.resolveGoalWaiter(context, null);
      return;
    }
    if (waiter.operation === "get") {
      if (/^No goal set\b/i.test(text)) context.activeGoal = null;
      const match = text.match(/^(?:Active|Current) goal:\s*(.+)$/im);
      if (match?.[1]) {
        context.activeGoal = {
          condition: match[1].trim(),
          iterations: 0,
          set_at: Date.now(),
          tokens_at_start: 0,
        };
      }
      this.resolveGoalWaiter(context, this.nativeGoal(context));
    }
  }

  private nativeGoal(context: ClaudeSessionContext): NativeGoal | null {
    const value = context.activeGoal;
    if (!value) return null;
    const setAtMs = value.set_at < 10_000_000_000 ? value.set_at * 1000 : value.set_at;
    return {
      threadId: context.native.threadId,
      objective: value.condition,
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: Math.max(0, Math.floor((Date.now() - setAtMs) / 1000)),
      createdAt: setAtMs,
      updatedAt: Date.now(),
      iterations: value.iterations,
      ...(value.last_reason ? { lastReason: value.last_reason } : {}),
    } as NativeGoal;
  }

  private resolveGoalWaiter(context: ClaudeSessionContext, goal: NativeGoal | null): void {
    const waiter = context.goalWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    context.goalWaiter = undefined;
    waiter.resolve(goal);
  }

  private rejectGoalWaiter(context: ClaudeSessionContext, error: unknown): void {
    const waiter = context.goalWaiter;
    if (!waiter) return;
    clearTimeout(waiter.timer);
    context.goalWaiter = undefined;
    waiter.reject(error);
  }

  private userMessage(content: string, uuid: string, sessionId: string): SDKUserMessage {
    return {
      type: "user",
      session_id: sessionId,
      message: { role: "user", content },
      parent_tool_use_id: null,
      uuid: uuid as any,
    };
  }

  private claudePermissionMode(policy: PermissionPolicy): ClaudePermissionMode {
    switch (policy.mode) {
      case "plan":
        return "plan";
      case "accept_edits":
        return "acceptEdits";
      case "full":
        return "bypassPermissions";
      default:
        return "default";
    }
  }

  private claudeEnv(): NodeJS.ProcessEnv {
    if (!this.profile) {
      return {
        ...process.env,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        ...(this.builtInTools !== undefined ? { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" } : {}),
        CLAUDE_AGENT_SDK_CLIENT_APP: "agent-gateway/0.1.0",
      };
    }
    return {
      ...process.env,
      // Claude Code's LLM-gateway mode accepts arbitrary gateway credentials
      // through ANTHROPIC_AUTH_TOKEN and sends them as Authorization. API_KEY
      // may be format-validated before a custom endpoint is contacted.
      ANTHROPIC_AUTH_TOKEN: this.profile.apiKey,
      ANTHROPIC_BASE_URL: this.profile.baseUrl.replace(/\/$/, ""),
      ...(this.profileConfigDir ? { CLAUDE_CONFIG_DIR: this.profileConfigDir } : {}),
      ...(this.builtInTools !== undefined ? { CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: "1" } : {}),
      CLAUDE_AGENT_SDK_CLIENT_APP: "agent-gateway/0.1.0",
    };
  }

  private emit(event: ProviderEvent): void {
    this.events.emit("event", event);
  }
}
