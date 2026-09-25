import type {
  Approval,
  MessageDelivery,
  NativeGoal,
  PermissionPolicy,
  ProviderCapabilities,
  RuntimeProfileInput,
  SessionHistory,
  ControlContext,
} from "../protocol/types.js";

export interface ProviderEvent {
  type: string;
  nativeThreadId?: string;
  nativeTurnId?: string;
  payload: unknown;
}

export interface NativeSession {
  id: string;
  threadId: string;
  model?: string;
  modelProvider?: string;
}

export interface NativeTurn {
  id: string;
  status?: string;
}

export interface StartSessionOptions {
  cwd: string;
  model?: string;
  permissionPolicy?: PermissionPolicy;
  instructions?: string;
  controlContext?: ControlContext;
  mcpServer?: {
    command: string;
    args: string[];
    env: Record<string, string>;
  };
}

export interface ResumeSessionOptions extends StartSessionOptions {
  threadId: string;
  modelProvider?: string;
}

export interface ApprovalDecision {
  type: "allow_once" | "allow_session" | "allow_with_changes" | "deny" | "cancel";
  updatedInput?: Record<string, unknown>;
  message?: string;
  answers?: Record<string, string | string[]>;
  permissions?: unknown;
  scope?: "turn" | "session";
}

export interface AgentAdapter {
  readonly capabilities: ProviderCapabilities;
  readonly runtimeId: string;

  onEvent(listener: (event: ProviderEvent) => void): () => void;
  createSession(options: StartSessionOptions): Promise<NativeSession>;
  resumeSession(options: ResumeSessionOptions): Promise<NativeSession>;
  startTurn(session: NativeSession, prompt: string, model?: string): Promise<NativeTurn>;
  sendMessage(
    session: NativeSession,
    activeTurnId: string | undefined,
    content: string,
    delivery: MessageDelivery,
  ): Promise<{ actualDelivery: MessageDelivery; turn?: NativeTurn }>;
  getHistory(session: NativeSession): Promise<SessionHistory>;
  interrupt(session: NativeSession, turnId: string): Promise<void>;
  detachSession(session: NativeSession): Promise<void>;
  resolveApproval(approvalId: string, decision: ApprovalDecision): Promise<void>;
  changeModel(session: NativeSession, model: string): Promise<{ effectiveAt: "immediate" | "next_turn" }>;
  changePermissions(session: NativeSession, policy: PermissionPolicy): Promise<{ effectiveAt: string }>;
  getGoal(session: NativeSession): Promise<NativeGoal | null>;
  setGoal(
    session: NativeSession,
    goal: { objective?: string; status?: string; tokenBudget?: number | null },
  ): Promise<NativeGoal>;
  clearGoal(session: NativeSession): Promise<boolean>;
  compact(session: NativeSession): Promise<void>;
  close(): Promise<void>;
}

export interface RuntimeHandle {
  id: string;
  fingerprint: string;
  profile?: RuntimeProfileInput;
  instructions?: string;
  mcpServer?: StartSessionOptions["mcpServer"];
  adapter: AgentAdapter;
  release(): Promise<void>;
}

export interface ApprovalProviderEvent extends ProviderEvent {
  type: "approval.required";
  payload: Approval;
}
