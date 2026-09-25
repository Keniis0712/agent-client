export type AgentKind = "claude";

export interface DeviceInfo {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  arch: string;
  daemonVersion: string;
}

export interface AgentInfo {
  id: AgentKind;
  available: boolean;
  version?: string;
  capabilities: ProviderCapabilities;
}

export interface ProviderCapabilities {
  streaming: boolean;
  approvals: boolean;
  clarifyQuestions: boolean;
  nativeGoal: boolean;
  steerCurrentTurn: boolean;
  queueMessages: boolean;
  interrupt: boolean;
  switchModelNextTurn: boolean;
  changePermissionLive: boolean;
  mutateToolInput: boolean;
  resumeSession: boolean;
}

export interface RuntimeProfileInput {
  id?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol?: "anthropic";
  modelProvider?: string;
  reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  extraHeaders?: Record<string, string>;
  options?: Record<string, unknown>;
}

export type AgentRole = "orchestrator" | "project";

export interface ControlContext {
  consoleBaseUrl: string;
  role: AgentRole;
  orchestratorSessionId: string;
  projectId?: string;
  projectRunId?: string;
}

export interface SkillBundleInput {
  id: string;
  version: string;
  sha256?: string;
  files: Record<string, string>;
}

export interface AgentBootstrapInput {
  instructionsVersion: string;
  instructions: string;
  skillBundles?: SkillBundleInput[];
}

export type SessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "waiting_approval"
  | "interrupting"
  | "switching_profile"
  | "credentials_required"
  | "failed"
  | "closed";

export interface SessionRecord {
  id: string;
  deviceId: string;
  agent: AgentKind;
  workingDirectory: string;
  nativeSessionId?: string;
  nativeThreadId?: string;
  runtimeId?: string;
  profileFingerprint?: string;
  role?: AgentRole;
  orchestratorSessionId?: string;
  projectId?: string;
  projectRunId?: string;
  effectiveModel?: string;
  effectiveModelProvider?: string;
  status: SessionStatus;
  revision: number;
  activeTurnId?: string;
  lastSequence: number;
  createdAt: string;
  updatedAt: string;
}

export type MessageDelivery = "auto" | "steer" | "queue" | "interrupt";

export type PermissionMode = "plan" | "prompt" | "accept_edits" | "full";

export interface PermissionPolicy {
  mode: PermissionMode;
  allowedTools?: string[];
  disallowedTools?: string[];
  approvalPolicy?: string;
  sandboxMode?: string;
}

export type GoalStatus =
  | "active"
  | "paused"
  | "blocked"
  | "usageLimited"
  | "budgetLimited"
  | "complete";

export interface NativeGoal {
  threadId: string;
  objective: string;
  status: GoalStatus | string;
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface SessionHistoryMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  nativeTurnId?: string;
  createdAt?: string;
  hidden?: boolean;
}

export interface SessionHistory {
  source: "native";
  messages: SessionHistoryMessage[];
}

export type ApprovalKind =
  | "command"
  | "file_change"
  | "network"
  | "permission"
  | "question";

export interface Approval {
  id: string;
  sessionId: string;
  nativeRequestId: string | number;
  nativeTurnId?: string;
  nativeToolCallId?: string;
  kind: ApprovalKind;
  status: "pending" | "approved" | "denied" | "cancelled" | "expired";
  title: string;
  reason?: string;
  toolName?: string;
  input?: unknown;
  diff?: string;
  availableDecisions: string[];
}

export type SessionCommandType =
  | "message.send"
  | "turn.interrupt"
  | "approval.resolve"
  | "model.change"
  | "profile.change"
  | "permission.change"
  | "goal.set"
  | "goal.get"
  | "goal.clear"
  | "session.compact"
  | "session.close";

export interface SessionCommand<T = unknown> {
  commandId: string;
  idempotencyKey: string;
  expectedRevision?: number;
  type: SessionCommandType;
  payload: T;
}

export interface CreateSessionRequest {
  sessionId?: string;
  deviceId: string;
  agent: AgentKind;
  workingDirectory?: string;
  runtimeProfile?: RuntimeProfileInput;
  controlContext?: ControlContext;
  bootstrap?: AgentBootstrapInput;
  prompt?: string;
  permissionPolicy?: PermissionPolicy;
}

export interface AgentEvent<T = unknown> {
  eventId: string;
  sequence: number;
  timestamp: string;
  deviceId: string;
  sessionId: string;
  sessionRevision: number;
  nativeThreadId?: string;
  nativeTurnId?: string;
  type: string;
  payload: T;
}

export interface DeviceRegistration {
  device: DeviceInfo;
  agents: AgentInfo[];
}

export type ControlToDeviceMessage =
  | { type: "session.create"; requestId: string; payload: CreateSessionRequest }
  | { type: "session.command"; requestId: string; sessionId: string; payload: SessionCommand }
  | { type: "session.history"; requestId: string; sessionId: string }
  | { type: "events.ack"; sessionId: string; throughSequence: number }
  | { type: "device.ping"; timestamp: string };

export type DeviceToControlMessage =
  | { type: "device.register"; requestId: string; payload: DeviceRegistration }
  | { type: "device.heartbeat"; deviceId: string; timestamp: string }
  | { type: "agent.event"; payload: AgentEvent }
  | { type: "command.result"; requestId: string; ok: boolean; payload?: unknown; error?: SerializedError };

export interface SerializedError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}
