import type {
  AgentEvent,
  CreateSessionRequest,
  MessageDelivery,
  PermissionPolicy,
  RuntimeProfileInput,
  SessionCommand,
  SessionRecord,
} from "../protocol/types.js";
import type {
  AgentAdapter,
  ApprovalDecision,
  NativeSession,
  ProviderEvent,
  RuntimeHandle,
} from "../providers/types.js";
import { GatewayError, serializeError } from "../shared/errors.js";
import { createId } from "../shared/ids.js";
import { DeviceStore } from "./event-store.js";
import { RuntimeManager } from "./runtime-manager.js";

interface QueuedMessage {
  content: string;
  model?: string;
}

export class SessionActor {
  readonly session: SessionRecord;
  private nativeSession!: NativeSession;
  private runtime!: RuntimeHandle;
  private unsubscribe?: () => void;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly queuedMessages: QueuedMessage[] = [];
  private turnEndWaiters: Array<() => void> = [];
  private pendingProfile?: { profile: RuntimeProfileInput; apply: "after_turn" | "interrupt" };
  private permissionPolicy: PermissionPolicy;
  private hasStartedTurn = false;

  private constructor(
    private readonly deviceId: string,
    private readonly request: CreateSessionRequest,
    private readonly runtimes: RuntimeManager,
    private readonly store: DeviceStore,
    private readonly publish: (event: AgentEvent) => void,
  ) {
    const now = new Date().toISOString();
    this.permissionPolicy = request.permissionPolicy ?? { mode: "prompt" };
    this.session = {
      id: request.sessionId ?? createId("ses"),
      deviceId,
      agent: request.agent,
      workingDirectory: request.workingDirectory!,
      status: "starting",
      revision: 0,
      lastSequence: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  static async create(
    deviceId: string,
    request: CreateSessionRequest,
    runtimes: RuntimeManager,
    store: DeviceStore,
    publish: (event: AgentEvent) => void,
  ): Promise<SessionActor> {
    const actor = new SessionActor(deviceId, request, runtimes, store, publish);
    try {
      await actor.initialize();
      return actor;
    } catch (error) {
      actor.unsubscribe?.();
      await actor.runtime?.release();
      throw error;
    }
  }

  dispatch(command: SessionCommand): Promise<unknown> {
    const operation = this.serial.then(() => this.execute(command));
    this.serial = operation.catch(() => undefined);
    return operation;
  }

  getHistory(): Promise<import("../protocol/types.js").SessionHistory> {
    return this.runtime.adapter.getHistory(this.nativeSession);
  }

  async close(): Promise<void> {
    this.unsubscribe?.();
    if (this.nativeSession && this.runtime) await this.runtime.adapter.detachSession(this.nativeSession);
    await this.runtime?.release();
    this.setStatus("closed");
  }

  private async initialize(): Promise<void> {
    this.runtime = await this.runtimes.acquire(
      this.request.workingDirectory!,
      this.request.runtimeProfile,
      this.request.controlContext,
      this.request.bootstrap,
    );
    this.bindAdapter(this.runtime.adapter);
    this.nativeSession = await this.runtime.adapter.createSession({
      cwd: this.request.workingDirectory!,
      ...(this.request.runtimeProfile?.model ? { model: this.request.runtimeProfile.model } : {}),
      permissionPolicy: this.permissionPolicy,
      ...(this.request.bootstrap || this.request.controlContext
        ? {
            instructions: this.runtime.instructions,
            controlContext: this.request.controlContext,
            mcpServer: this.runtime.mcpServer,
          }
        : {}),
    });
    this.update({
      nativeSessionId: this.nativeSession.id,
      nativeThreadId: this.nativeSession.threadId,
      runtimeId: this.runtime.id,
      profileFingerprint: this.runtime.fingerprint,
      ...(this.request.controlContext
        ? {
            role: this.request.controlContext.role,
            orchestratorSessionId: this.request.controlContext.orchestratorSessionId,
            projectId: this.request.controlContext.projectId,
            projectRunId: this.request.controlContext.projectRunId,
          }
        : {}),
      ...(this.nativeSession.model ? { effectiveModel: this.nativeSession.model } : {}),
      ...(this.nativeSession.modelProvider
        ? { effectiveModelProvider: this.nativeSession.modelProvider }
        : {}),
      status: "idle",
    });
    this.emit("session.started", { session: this.session });
    if (this.request.prompt) await this.startTurn(this.request.prompt);
  }

  private async execute(command: SessionCommand): Promise<unknown> {
    if (this.store.hasCommand(command.idempotencyKey)) return { deduplicated: true };
    try {
      if (command.expectedRevision !== undefined && command.expectedRevision !== this.session.revision) {
        throw new GatewayError(
          "SESSION_REVISION_CONFLICT",
          `Expected revision ${command.expectedRevision}, current revision is ${this.session.revision}`,
        );
      }
      const result = await this.applyCommand(command);
      this.store.recordCommand(command.idempotencyKey, command.commandId, result);
      this.emit("command.applied", { commandId: command.commandId, result });
      return result;
    } catch (error) {
      this.emit("command.failed", { commandId: command.commandId, error: serializeError(error) });
      throw error;
    }
  }

  private async applyCommand(command: SessionCommand): Promise<unknown> {
    const payload = (command.payload ?? {}) as any;
    switch (command.type) {
      case "message.send":
        return this.sendMessage(String(payload.content ?? ""), payload.delivery ?? "auto");
      case "turn.interrupt":
        return this.interruptTurn();
      case "approval.resolve":
        return this.runtime.adapter.resolveApproval(
          String(payload.approvalId),
          payload.decision as ApprovalDecision,
        );
      case "model.change":
        return this.changeModel(String(payload.model), payload.apply ?? "next_turn");
      case "profile.change":
        return this.changeProfile(payload.runtimeProfile, payload.apply ?? "after_turn");
      case "permission.change":
        return this.changePermissions(payload.policy, payload.apply ?? "next_turn");
      case "goal.set": {
        const goal = await this.runtime.adapter.setGoal(this.nativeSession, payload);
        this.emit("goal.updated", { goal });
        return goal;
      }
      case "goal.get":
        return this.runtime.adapter.getGoal(this.nativeSession);
      case "goal.clear": {
        const cleared = await this.runtime.adapter.clearGoal(this.nativeSession);
        if (cleared) this.emit("goal.cleared", {});
        return { cleared };
      }
      case "session.compact":
        await this.runtime.adapter.compact(this.nativeSession);
        return {};
      case "session.close":
        await this.close();
        return {};
      default:
        throw new GatewayError("COMMAND_UNSUPPORTED", `Unsupported command: ${String(command.type)}`);
    }
  }

  private async sendMessage(content: string, delivery: MessageDelivery): Promise<unknown> {
    if (!content.trim()) throw new GatewayError("INVALID_MESSAGE", "Message content is empty");
    if (delivery === "interrupt" && this.session.activeTurnId) {
      await this.interruptTurn();
      await this.startTurn(content);
      return { actualDelivery: "interrupt" };
    }
    if (delivery === "queue" && this.session.activeTurnId) {
      this.queuedMessages.push({ content });
      this.emit("message.accepted", { requestedDelivery: delivery, actualDelivery: "queue" });
      return { actualDelivery: "queue" };
    }
    const result = await this.runtime.adapter.sendMessage(
      this.nativeSession,
      this.session.activeTurnId,
      content,
      delivery,
    );
    if (result.turn) {
      this.hasStartedTurn = true;
      this.setActiveTurn(result.turn.id);
    }
    this.emit("message.accepted", { requestedDelivery: delivery, actualDelivery: result.actualDelivery });
    return result;
  }

  private async startTurn(prompt: string): Promise<void> {
    if (this.session.activeTurnId) throw new GatewayError("TURN_ALREADY_ACTIVE", "A turn is already active");
    const turn = await this.runtime.adapter.startTurn(
      this.nativeSession,
      prompt,
      this.session.effectiveModel,
    );
    this.hasStartedTurn = true;
    this.setActiveTurn(turn.id);
  }

  private async interruptTurn(): Promise<void> {
    if (!this.session.activeTurnId) throw new GatewayError("TURN_NOT_ACTIVE", "There is no active turn");
    const turnId = this.session.activeTurnId;
    this.setStatus("interrupting");
    const completion = this.waitForTurnEnd(30_000);
    await this.runtime.adapter.interrupt(this.nativeSession, turnId);
    await completion;
  }

  private async changeModel(model: string, apply: "next_turn" | "interrupt"): Promise<unknown> {
    if (!model) throw new GatewayError("MODEL_NOT_AVAILABLE", "Model is required");
    if (apply === "interrupt" && this.session.activeTurnId) await this.interruptTurn();
    const result = await this.runtime.adapter.changeModel(this.nativeSession, model);
    this.update({ effectiveModel: model });
    this.emit("model.changed", { model, effectiveAt: result.effectiveAt });
    return result;
  }

  private async changePermissions(
    policy: PermissionPolicy,
    apply: "next_turn" | "interrupt" | "next_tool_call",
  ): Promise<unknown> {
    if (apply === "interrupt" && this.session.activeTurnId) await this.interruptTurn();
    const result = await this.runtime.adapter.changePermissions(this.nativeSession, policy);
    this.permissionPolicy = policy;
    this.emit("permission.changed", { policy, effectiveAt: result.effectiveAt });
    return result;
  }

  private async changeProfile(
    profile: RuntimeProfileInput,
    apply: "after_turn" | "interrupt",
  ): Promise<unknown> {
    if (!profile) throw new GatewayError("RUNTIME_PROFILE_INVALID", "runtimeProfile is required");
    if (apply === "after_turn" && this.session.activeTurnId) {
      this.pendingProfile = { profile, apply };
      this.emit("profile.change.requested", { apply, pending: true });
      return { effectiveAt: "after_turn" };
    }
    if (apply === "interrupt" && this.session.activeTurnId) await this.interruptTurn();
    return this.switchProfile(profile);
  }

  private async switchProfile(profile: RuntimeProfileInput): Promise<unknown> {
    const previous = this.runtime;
    this.setStatus("switching_profile");
    this.emit("profile.switching", { from: previous.fingerprint });
    const target = await this.runtimes.acquire(
      this.request.workingDirectory!,
      profile,
      this.request.controlContext,
      this.request.bootstrap,
    );
    let resumed: NativeSession | undefined;
    let detached = false;
    try {
      if (this.hasStartedTurn) {
        await previous.adapter.detachSession(this.nativeSession);
        detached = true;
        resumed = await target.adapter.resumeSession({
          threadId: this.nativeSession.threadId,
          cwd: this.request.workingDirectory!,
          model: profile.model,
          permissionPolicy: this.permissionPolicy,
        });
      } else {
        resumed = await target.adapter.createSession({
          cwd: this.request.workingDirectory!,
          model: profile.model,
          permissionPolicy: this.permissionPolicy,
        });
      }
      if (!detached) {
        await previous.adapter.detachSession(this.nativeSession);
        detached = true;
      }
    } catch (error) {
      if (resumed) await target.adapter.detachSession(resumed).catch(() => undefined);
      await target.release();
      try {
        if (detached) {
          this.nativeSession = this.hasStartedTurn
            ? await previous.adapter.resumeSession({
                threadId: this.nativeSession.threadId,
                cwd: this.request.workingDirectory!,
                model: this.session.effectiveModel,
                modelProvider: this.session.effectiveModelProvider,
                permissionPolicy: this.permissionPolicy,
              })
            : await previous.adapter.createSession({
                cwd: this.request.workingDirectory!,
                model: this.session.effectiveModel,
                permissionPolicy: this.permissionPolicy,
              });
        }
        this.setStatus("idle");
      } catch (rollbackError) {
        this.setStatus("failed");
        this.emit("profile.rollback.failed", { error: serializeError(rollbackError) });
      }
      this.emit("profile.change.failed", { error: serializeError(error) });
      throw new GatewayError("PROFILE_SWITCH_FAILED", "Failed to switch runtime profile", false, error);
    }

    if (!resumed) throw new GatewayError("PROFILE_SWITCH_FAILED", "Target runtime did not resume the session");

    // Commit only after the target worker has proved that it can resume the thread.
    this.unsubscribe?.();
    this.runtime = target;
    this.nativeSession = resumed;
    this.bindAdapter(target.adapter);
    this.update({
      runtimeId: target.id,
      profileFingerprint: target.fingerprint,
      nativeSessionId: resumed.id,
      nativeThreadId: resumed.threadId,
      effectiveModel: resumed.model ?? profile.model,
      ...(resumed.modelProvider ? { effectiveModelProvider: resumed.modelProvider } : {}),
      status: "idle",
    });
    await previous.release();

    if (target.adapter.capabilities.nativeGoal) {
      try {
        const goal = await target.adapter.getGoal(resumed);
        if (goal) this.emit("goal.updated", { goal });
      } catch (error) {
        this.emit("goal.refresh.failed", { error: serializeError(error) });
      }
    }
    const result = {
      runtimeId: target.id,
      profileFingerprint: target.fingerprint,
      nativeSessionId: resumed.id,
      nativeThreadId: resumed.threadId,
      model: this.session.effectiveModel,
      modelProvider: this.session.effectiveModelProvider,
    };
    this.emit("profile.changed", result);
    return result;
  }

  private bindAdapter(adapter: AgentAdapter): void {
    this.unsubscribe = adapter.onEvent((event) => this.onProviderEvent(event));
  }

  private onProviderEvent(event: ProviderEvent): void {
    if (
      event.nativeThreadId &&
      this.nativeSession?.threadId &&
      event.nativeThreadId !== this.nativeSession.threadId
    ) {
      return;
    }
    if (event.type === "session.started" && event.nativeThreadId) {
      const payload = event.payload as any;
      this.update({
        nativeSessionId: event.nativeThreadId,
        nativeThreadId: event.nativeThreadId,
        ...(payload.model ? { effectiveModel: payload.model } : {}),
      });
    } else if (event.type === "turn.started") {
      this.hasStartedTurn = true;
      const payload = event.payload as any;
      const turnId = event.nativeTurnId ?? payload.turn?.id ?? payload.turnId;
      if (turnId) this.setActiveTurn(turnId);
    } else if (event.type === "turn.completed") {
      this.update({ status: "idle", activeTurnId: undefined });
      for (const resolve of this.turnEndWaiters.splice(0)) resolve();
      void this.serialAfterTurn();
    } else if (event.type === "approval.required") {
      this.setStatus("waiting_approval");
      const approval = event.payload as any;
      approval.sessionId = this.session.id;
    } else if (event.type === "approval.resolved") {
      this.setStatus(this.session.activeTurnId ? "running" : "idle");
    }
    this.emit(event.type, event.payload, event.nativeTurnId);
  }

  private async serialAfterTurn(): Promise<void> {
    this.serial = this.serial
      .then(async () => {
        if (this.pendingProfile) {
          const pending = this.pendingProfile;
          this.pendingProfile = undefined;
          await this.switchProfile(pending.profile);
        }
        const next = this.queuedMessages.shift();
        if (next) await this.startTurn(next.content);
      })
      .catch((error) => this.emit("provider.error", { error: serializeError(error) }));
    await this.serial;
  }

  private waitForTurnEnd(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new GatewayError("TURN_INTERRUPT_TIMEOUT", "Turn did not stop")), timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      this.turnEndWaiters.push(done);
    });
  }

  private setActiveTurn(turnId: string): void {
    this.update({ activeTurnId: turnId, status: "running" });
  }

  private setStatus(status: SessionRecord["status"]): void {
    this.update({ status });
    this.emit("session.status.changed", { status });
  }

  private update(patch: Partial<SessionRecord>): void {
    Object.assign(this.session, patch, {
      revision: this.session.revision + 1,
      updatedAt: new Date().toISOString(),
    });
    if (patch.activeTurnId === undefined && "activeTurnId" in patch) delete this.session.activeTurnId;
    this.store.saveSession(this.session);
  }

  private emit(type: string, payload: unknown, nativeTurnId?: string): void {
    const event: AgentEvent = {
      eventId: createId("evt"),
      sequence: ++this.session.lastSequence,
      timestamp: new Date().toISOString(),
      deviceId: this.deviceId,
      sessionId: this.session.id,
      sessionRevision: this.session.revision,
      ...(this.session.nativeThreadId ? { nativeThreadId: this.session.nativeThreadId } : {}),
      ...(nativeTurnId ?? this.session.activeTurnId
        ? { nativeTurnId: nativeTurnId ?? this.session.activeTurnId }
        : {}),
      type,
      payload,
    };
    this.store.appendEvent(event);
    this.store.saveSession(this.session);
    this.publish(event);
  }
}
