# 多设备 Agent Gateway 实现设计

> 状态：Draft v1  
> 日期：2026-09-21  
> 适用范围：个人内网多设备、Codex 与 Claude Agent 的集中控制

## 1. 目标

在每台个人设备上运行一个常驻 Device Daemon，由中心 Control Server 和聚合终端统一控制不同设备上的 Codex、Claude Agent。

系统需要支持：

- 发现设备、工作区、Agent 和可用模型。
- 创建、恢复和终止 Agent 会话。
- 实时输出文本、工具调用、命令输出和状态变化。
- 远程处理工具审批与 Agent 澄清问题。
- 在运行中追加消息、引导或中断当前 Turn。
- 更改模型。
- 通过上游临时下发的 API endpoint、API key 等参数创建运行时 Profile，并在会话中切换 Profile。
- 使用 Agent 原生 Goal 能力；平台只保存其投影。
- 修改审批模式与工具调用权限，并明确变更的生效边界。
- 设备或中心短暂断线后补传事件并恢复展示。

本阶段假设运行于可信个人内网，不建设完整的多租户、OAuth、计费、容器沙箱和公网安全体系。

## 2. 核心决策

### 2.1 Codex 使用 App Server

设备端启动 Codex CLI 自带的 App Server：

```text
codex app-server -c <profile-key=value> ...
```

Device Daemon 使用 stdin/stdout 上的 JSONL JSON-RPC 与其通信，不操作交互式 TUI，不解析 ANSI 终端文本。

注意：Codex CLI 0.155.0 的 `app-server` 会拒绝全局 `--profile` 参数。因此 Daemon
仍会物化临时 Profile 文件，但启动 App Server 时将文件中的同一组配置转换成其原生支持的
`-c key=value` 进程级覆盖项。配置作用域仍然是单个 Worker，不会修改用户的基础配置。

选择 App Server 而不是 Codex SDK，是因为本项目需要完整的客户端能力：审批、Thread 历史、流式事件、`turn/steer`、`turn/interrupt` 和原生 Goal。

### 2.2 Claude 使用 Agent SDK Streaming Input

Claude Adapter 使用 TypeScript Agent SDK 的长生命周期 Streaming Input 模式，利用 SDK 提供的多轮消息、排队、中断、权限回调和流式事件能力。不以一次性 `claude -p` 作为主实现。

### 2.3 Goal 原生优先

Codex Goal 直接映射：

```text
thread/goal/set
thread/goal/get
thread/goal/clear
thread/goal/updated
```

Control Server 中的数据只是查询投影，不是 Goal 的事实源。没有原生 Goal 能力的 Adapter 上报 `nativeGoal=false`，第一版不模拟 Goal。

### 2.4 Profile 是运行时配置，不是 Agent 切换

`profile.change` 表示在同一个 Agent 内切换 API endpoint、key、model、model provider 等运行配置，不表示 Codex 与 Claude 之间迁移。

Codex Profile 在进程启动时加载，因此不同 Profile 由不同 Runtime Worker 承载。Profile 切换发生在 Turn 边界，通过新 Worker 恢复同一个原生 Thread。

### 2.5 每个 Session Actor 串行处理变更

每个逻辑会话由一个 Session Actor 管理。所有用户命令、Provider 事件、审批响应和切换操作都进入该 Actor 的串行队列，避免并发竞态。

## 3. 总体架构

```text
┌─────────────────────────────────────────────────────────┐
│                    Agent 聚合终端                        │
│  设备列表 / 会话终端 / Goal / 审批 / Profile / 权限      │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTP + WebSocket
                           ▼
┌─────────────────────────────────────────────────────────┐
│                    Control Server                       │
│ Device Registry │ Session Index │ Event Store │ WS Hub  │
└──────────────────────────┬──────────────────────────────┘
                           │ 设备主动建立 WebSocket
             ┌─────────────┴──────────────┐
             ▼                            ▼
┌────────────────────────┐   ┌────────────────────────────┐
│ Windows Device Daemon  │   │ macOS/Linux Device Daemon │
│ Session Actors         │   │ Session Actors             │
│ Runtime Worker Pool    │   │ Runtime Worker Pool        │
│ Codex / Claude Adapter │   │ Codex / Claude Adapter     │
└───────────┬────────────┘   └──────────────┬─────────────┘
            │                                │
     ┌──────┴──────┐                  ┌──────┴──────┐
     ▼             ▼                  ▼             ▼
 Codex          Claude             Codex          Claude
 App Server     Agent SDK          App Server     Agent SDK
```

设备主动连接中心，避免中心处理局域网 IP 变化和设备入站连接问题。Daemon 可额外监听 `127.0.0.1` HTTP 端口用于本地诊断。

## 4. 技术栈与工程结构

推荐使用 TypeScript Monorepo：

```text
packages/
  protocol/                 # HTTP、WebSocket、事件与命令类型
  provider-core/            # Adapter 接口、能力模型、通用错误
  provider-codex/           # App Server JSON-RPC Adapter
  provider-claude/          # Claude Agent SDK Adapter
  runtime-manager/          # 临时 Profile、Worker Pool、子进程
  session-engine/           # Session Actor、状态机、命令调度
  device-daemon/            # 设备连接、本地存储、工作区注册
  control-server/           # 设备注册、API、事件投影
  web-terminal/             # 聚合终端 UI
apps/
  device/
  server/
  web/
docs/
```

建议依赖：

- Node.js 20 LTS 或更高版本。
- Fastify：Control Server 和本地诊断 API。
- `ws`：设备与中心 WebSocket。
- SQLite：设备端事件缓冲、中心端 MVP 数据库。
- Pino：结构化日志。
- Zod：协议运行时校验。
- OpenTelemetry：后续指标与链路追踪。

## 5. 领域模型

### 5.1 Device

```ts
interface Device {
  id: string;
  name: string;
  platform: "win32" | "darwin" | "linux";
  arch: string;
  daemonVersion: string;
  status: "online" | "offline";
  lastSeenAt: string;
}
```

### 5.2 LogicalSession

聚合终端看到的稳定会话。它不因 App Server 子进程重启或 Profile 切换而改变 ID。

```ts
interface LogicalSession {
  id: string;
  deviceId: string;
  agent: "codex" | "claude";
  workspaceId: string;

  nativeSessionId?: string;
  nativeThreadId?: string;

  runtimeId: string;
  profileFingerprint: string;
  effectiveModel?: string;
  effectiveModelProvider?: string;

  status: SessionStatus;
  revision: number;
  activeTurnId?: string;
  lastSequence: number;
}
```

### 5.3 SessionStatus

```ts
type SessionStatus =
  | "starting"
  | "idle"
  | "running"
  | "waiting_approval"
  | "interrupting"
  | "switching_profile"
  | "credentials_required"
  | "failed"
  | "closed";
```

### 5.4 RuntimeProfile

```ts
interface RuntimeProfileInput {
  id?: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  protocol?: "responses" | "anthropic";
  modelProvider?: string;
  reasoningEffort?: string;
  extraHeaders?: Record<string, string>;
  options?: Record<string, unknown>;
}
```

`apiKey` 只在中心到设备的命令和 Device Daemon 内存中存在。事件、日志和状态查询只暴露 `keyFingerprint`。

### 5.5 GoalProjection

```ts
interface GoalProjection {
  sessionId: string;
  nativeThreadId: string;
  objective: string;
  status: string;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  updatedAt: string;
}
```

## 6. Provider Adapter 接口

```ts
interface AgentAdapter {
  readonly agent: "codex" | "claude";

  detect(): Promise<AgentInstallation>;
  capabilities(runtime: RuntimeHandle): Promise<ProviderCapabilities>;

  createSession(input: CreateNativeSessionInput): Promise<NativeSession>;
  resumeSession(input: ResumeNativeSessionInput): Promise<NativeSession>;
  closeSession(session: NativeSession): Promise<void>;

  startTurn(input: StartTurnInput): Promise<NativeTurn>;
  sendMessage(input: SendMessageInput): Promise<MessageDeliveryResult>;
  interrupt(input: InterruptInput): Promise<void>;

  resolveApproval(input: ResolveApprovalInput): Promise<void>;
  changeModel(input: ChangeModelInput): Promise<ChangeResult>;
  changePermissions(input: ChangePermissionsInput): Promise<ChangeResult>;

  getGoal?(session: NativeSession): Promise<NativeGoal | null>;
  setGoal?(session: NativeSession, goal: SetGoalInput): Promise<NativeGoal>;
  clearGoal?(session: NativeSession): Promise<void>;

  events(session: NativeSession): AsyncIterable<ProviderEvent>;
}
```

能力上报：

```ts
interface ProviderCapabilities {
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
```

UI 必须依据能力显示控制项，不假设两个 Adapter 语义完全相同。

## 7. 中心 HTTP API

### 7.1 设备和能力

```http
GET /v1/devices
GET /v1/devices/{deviceId}
GET /v1/devices/{deviceId}/workspaces
GET /v1/devices/{deviceId}/agents
GET /v1/devices/{deviceId}/agents/{agent}/capabilities
```

### 7.2 创建 Session

```http
POST /v1/sessions
```

```json
{
  "deviceId": "ken-pc",
  "agent": "codex",
  "workspaceId": "agent-client",
  "runtimeProfile": {
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-example",
    "model": "example-model",
    "protocol": "responses",
    "reasoningEffort": "high"
  },
  "prompt": "检查测试失败并修复"
}
```

返回 `202 Accepted`：

```json
{
  "sessionId": "ses_01J...",
  "status": "starting"
}
```

创建过程和最终结果通过事件流返回。

### 7.3 会话命令

```http
POST /v1/sessions/{sessionId}/commands
```

```ts
interface SessionCommand<T = unknown> {
  commandId: string;
  idempotencyKey: string;
  expectedRevision?: number;
  type: SessionCommandType;
  payload: T;
}
```

```ts
type SessionCommandType =
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
```

命令响应只表示已进入 Session Actor 队列：

```json
{
  "accepted": true,
  "commandId": "cmd_01J..."
}
```

最终通过 `command.applied` 或 `command.failed` 事件报告。

### 7.4 Goal 快捷 API

```http
PUT    /v1/sessions/{sessionId}/goal
GET    /v1/sessions/{sessionId}/goal
DELETE /v1/sessions/{sessionId}/goal
```

这些接口内部仍转换为 Session Command，以保证串行化。

## 8. WebSocket 协议

### 8.1 设备连接

```text
WS /v1/device/connect
```

设备连接后发送：

```json
{
  "type": "device.register",
  "requestId": "req_01J...",
  "payload": {
    "device": {
      "id": "ken-pc",
      "name": "Office Windows",
      "platform": "win32",
      "arch": "x64",
      "daemonVersion": "0.1.0"
    },
    "agents": [],
    "workspaces": []
  }
}
```

### 8.2 统一事件 Envelope

```ts
interface AgentEvent<T = unknown> {
  eventId: string;
  sequence: number;
  timestamp: string;

  deviceId: string;
  sessionId: string;
  sessionRevision: number;
  nativeThreadId?: string;
  nativeTurnId?: string;

  type: AgentEventType;
  payload: T;
}
```

主要事件：

```text
session.started
session.resumed
session.status.changed

turn.started
turn.completed
turn.interrupted

message.accepted
assistant.delta
assistant.completed
reasoning.delta

tool.started
tool.output.delta
tool.completed

approval.required
approval.resolved

model.changed
profile.change.requested
profile.switching
profile.changed
profile.change.failed

permission.changed
goal.updated
goal.cleared

command.applied
command.failed
provider.error
```

### 8.3 ACK 与补传

设备为每个 Session 单调递增 `sequence`。中心累计确认：

```json
{
  "type": "events.ack",
  "sessionId": "ses_01J...",
  "throughSequence": 1088
}
```

设备把尚未 ACK 的结构化事件写入本地 SQLite。重连后从中心确认的位置继续补传。

`assistant.delta` 与 `tool.output.delta` 在设备端按 20 至 50 毫秒或 4 KiB 合并，不为每个 token 单独写数据库。

## 9. Session Actor

每个 Session Actor 维护：

```ts
interface SessionActorState {
  session: LogicalSession;
  runtime: RuntimeHandle;
  nativeSession: NativeSession;
  pendingCommands: SessionCommand[];
  pendingApprovals: Map<string, PendingApproval>;
  queuedMessages: QueuedMessage[];
}
```

Actor 的输入有两类：

```text
用户命令：HTTP/WS -> Control Server -> Device Daemon
Provider 事件：Codex App Server / Claude SDK -> Adapter -> Session Actor
```

优先级建议：

1. `session.close`、`turn.interrupt`。
2. `approval.resolve`。
3. `profile.change`、`permission.change`。
4. `message.send`。
5. 普通状态和查询命令。

同一 Session 同时只执行一个会改变 Provider 状态的 Actor action。

## 10. Codex Runtime Profile

### 10.1 Profile 文件与 App Server 配置层

为每个 Runtime Worker 创建唯一 Profile：

```text
$CODEX_HOME/agw_<runtime-id>.config.toml
```

示例：

```toml
model = "example-model"
model_provider = "gateway_runtime"
model_reasoning_effort = "high"

[model_providers.gateway_runtime]
name = "Agent Gateway Runtime"
base_url = "https://api.example.com/v1"
env_key = "AGENT_RUNTIME_API_KEY"
wire_api = "responses"
```

Codex 自定义 Provider 当前只支持 `responses` wire API；如果上游 endpoint 只兼容 Chat Completions，Codex Adapter 应在创建 Runtime 前返回 `RUNTIME_PROFILE_INVALID`，不能假定它可以直接使用。

真实 key 不写入文件，而是注入子进程环境：

```ts
spawn("codex", [
  "app-server",
  ...profileConfig.flatMap(value => ["-c", value]),
], {
  cwd: workspacePath,
  env: {
    ...process.env,
    AGENT_RUNTIME_API_KEY: runtimeProfile.apiKey,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
```

Profile 文件在 Worker 整个生命周期内保留；Worker 退出后删除。不能在初始化后立即删除，因为恢复、重载或诊断仍可能读取配置。

`profileConfig` 由该临时文件对应的配置生成，例如 `model=...`、
`model_provider="gateway_runtime"` 和 `model_providers.gateway_runtime.*`。这是 App Server
当前支持的 Profile 注入路径；如果未来版本允许 `app-server --profile`，可在 Adapter 内部切回
文件参数，而无需改变上游协议。

### 10.2 Profile 指纹

```text
SHA-256(
  agent + baseUrl + keyFingerprint + model + protocol +
  reasoningEffort + normalizedOptions
)
```

指纹相同则允许复用 Worker。原始 key 不进入 Worker key、日志或事件。

### 10.3 Worker Pool

```ts
interface RuntimeWorker {
  id: string;
  key: string;
  profileName: string;
  profilePath: string;
  process: ChildProcess;
  rpc: JsonRpcPeer;
  state: "starting" | "ready" | "draining" | "stopped" | "failed";
  activeThreads: Set<string>;
  lastUsedAt: number;
}
```

Worker 生命周期：

```text
不存在 -> 创建 Profile -> spawn -> initialize -> ready
ready -> 空闲超时 -> draining -> shutdown -> 删除 Profile -> stopped
异常退出 -> failed -> Session 标记 credentials_required 或 failed
```

第一版建议：

- 最大 Worker 数：8。
- 单 Worker 最大活跃 Thread 数：8。
- 空闲回收时间：30 分钟。
- 启动超时：20 秒。
- 优雅退出超时：5 秒，超时后终止进程树。

### 10.4 App Server 初始化

Daemon 启动进程后发送：

```json
{
  "method": "initialize",
  "id": 1,
  "params": {
    "clientInfo": {
      "name": "agent-gateway-device",
      "title": "Agent Gateway Device",
      "version": "0.1.0"
    },
    "capabilities": {
      "experimentalApi": false
    }
  }
}
```

收到成功响应后发送：

```json
{
  "method": "initialized",
  "params": {}
}
```

默认不启用实验性 API。某项功能确实依赖实验 API 时，通过 Adapter capability 单独声明。

## 11. Codex Session 与 Turn

### 11.1 创建 Thread

```json
{
  "method": "thread/start",
  "id": 10,
  "params": {
    "cwd": "D:\\project\\agent-client",
    "model": "example-model",
    "approvalPolicy": "on-request",
    "sandbox": "workspace-write",
    "serviceName": "agent-gateway"
  }
}
```

保存返回的 `thread.id` 和 `thread.sessionId`。

### 11.2 开始 Turn

```json
{
  "method": "turn/start",
  "id": 11,
  "params": {
    "threadId": "thr_123",
    "input": [
      {
        "type": "text",
        "text": "检查测试失败并修复"
      }
    ],
    "model": "example-model"
  }
}
```

Adapter 持续读取通知并转换为统一事件，直到收到 `turn/completed`。

### 11.3 流式映射

| Codex App Server | 统一事件 |
|---|---|
| `turn/started` | `turn.started` |
| `item/agentMessage/delta` | `assistant.delta` |
| `item/reasoning/textDelta` | `reasoning.delta` |
| `item/commandExecution/outputDelta` | `tool.output.delta` |
| `item/started` | `tool.started` 或内部 item 事件 |
| `item/completed` | `tool.completed` 或 `assistant.completed` |
| `turn/completed` | `turn.completed` |
| `error` | `provider.error` |

保留 Provider 原始 payload 到调试字段，但上层 UI 只依赖统一字段。

## 12. 中途消息与中断

```ts
type MessageDelivery = "auto" | "steer" | "queue" | "interrupt";
```

请求：

```json
{
  "type": "message.send",
  "payload": {
    "content": "先不要改前端，优先修复后端测试",
    "delivery": "auto"
  }
}
```

### Codex

- `steer`：调用 `turn/steer`，必须携带当前 `expectedTurnId`。
- `queue`：存入 Session Actor 队列，在当前 Turn 完成后调用新的 `turn/start`。
- `interrupt`：调用 `turn/interrupt`，等待 `turn/completed(status=interrupted)` 后启动新 Turn。
- `auto`：当前有活跃 Turn 时优先 `steer`，空闲时直接 `turn/start`。

### Claude

- 使用 Streaming Input Generator 发送后续用户消息。
- `queue` 为默认行为。
- `interrupt` 使用 SDK 的中断能力后重新发送消息。
- 如果当前 SDK 版本没有与 Codex `turn/steer` 等价的确定语义，能力上报 `steerCurrentTurn=false`，`auto` 映射为 `queue`。

必须回传实际使用的投递方式：

```json
{
  "type": "message.accepted",
  "payload": {
    "messageId": "msg_01J...",
    "requestedDelivery": "auto",
    "actualDelivery": "steer"
  }
}
```

## 13. 审批与澄清问题

### 13.1 统一 Approval

```ts
interface Approval {
  id: string;
  sessionId: string;
  nativeRequestId: string;
  nativeTurnId?: string;
  nativeToolCallId?: string;

  kind: "command" | "file_change" | "network" | "permission" | "question";
  status: "pending" | "approved" | "denied" | "cancelled" | "expired";

  title: string;
  reason?: string;
  toolName?: string;
  input?: unknown;
  diff?: string;
  availableDecisions: string[];
}
```

### 13.2 Codex 映射

App Server 发起的 JSON-RPC request 必须保持 pending，直到上游返回决定：

```text
item/commandExecution/requestApproval
item/fileChange/requestApproval
item/permissions/requestApproval
item/tool/requestUserInput
mcpServer/elicitation/request
```

决策映射：

```text
allow_once    -> accept
allow_session -> acceptForSession
deny          -> decline
cancel        -> cancel
```

如果 Provider 提供 `availableDecisions`，UI 以它为准。

### 13.3 Claude 映射

`canUseTool` 回调创建 Approval 并返回一个待完成的 Promise：

```ts
canUseTool: async (toolName, input, options) => {
  const decision = await approvalBroker.wait({
    toolName,
    input,
    signal: options.signal,
  });

  if (decision.type === "allow") {
    return {
      behavior: "allow",
      updatedInput: decision.updatedInput ?? input,
    };
  }

  return {
    behavior: "deny",
    message: decision.message ?? "User denied this action",
  };
};
```

澄清问题作为 `kind=question` 展示，不与普通聊天消息混合。

### 13.4 竞态规则

- `approval.resolve` 必须幂等。
- Turn 已完成或中断后，对应 pending Approval 自动取消。
- 已经 pending 的 Approval 不受后续权限策略修改影响。
- Device 与中心断线时，Daemon 保持 Provider 回调 pending。
- Daemon 重启后无法继续的内存回调标记为 `cancelled`，恢复 Thread 后让 Agent 重新决定。

## 14. 原生 Goal

### 14.1 设置 Goal

```json
{
  "method": "thread/goal/set",
  "id": 20,
  "params": {
    "threadId": "thr_123",
    "objective": "完成迁移并保持测试通过",
    "status": "active",
    "tokenBudget": 40000
  }
}
```

### 14.2 更新规则

- 新 objective 会替换 Goal 并重置使用量统计。
- objective 不变或省略时，可以更新状态或 token budget，并保留用量。
- Daemon 监听 `thread/goal/updated`，转换成 `goal.updated`。
- 中心数据库只更新 GoalProjection。
- Profile 切换成功后主动调用 `thread/goal/get`，校准中心投影。

### 14.3 清除 Goal

调用 `thread/goal/clear`，成功后发送 `goal.cleared`。

## 15. 模型更改

```json
{
  "type": "model.change",
  "payload": {
    "model": "another-model",
    "apply": "next_turn"
  }
}
```

支持：

```ts
type ModelChangeApply = "next_turn" | "interrupt";
```

Codex `turn/steer` 不能同时改变模型，因此：

- `next_turn`：保存 Session 级 model override，在下一个 `turn/start` 传入。
- `interrupt`：中断当前 Turn，再以新模型启动下一 Turn。

模型覆盖不改写临时 Profile 文件。Session 同时保存：

```ts
interface EffectiveModelState {
  profileModel: string;
  sessionModelOverride?: string;
  effectiveModel: string;
}
```

## 16. Profile 切换

### 16.1 请求

```json
{
  "type": "profile.change",
  "payload": {
    "runtimeProfile": {
      "baseUrl": "http://192.168.1.20:11434/v1",
      "apiKey": "runtime-key",
      "model": "qwen-coder",
      "protocol": "responses"
    },
    "apply": "after_turn"
  }
}
```

```ts
type ProfileChangeApply = "after_turn" | "interrupt";
```

### 16.2 切换算法

```text
1. 校验 RuntimeProfile
2. 获取或创建目标 Runtime Worker
3. 发出 profile.change.requested
4. 若当前 Turn 活跃：
   - after_turn：等待完成
   - interrupt：中断并等待 interrupted
5. 取消或完成所有 pending Approval
6. 从旧 Worker 取消 Thread 订阅
7. 在新 Worker 调用 thread/resume(nativeThreadId)
8. 验证返回的 modelProvider 与期望配置
9. 调用 thread/goal/get 校准 Goal
10. 原子更新 Session.runtimeId/profileFingerprint/revision
11. 发出 profile.changed
```

伪代码：

```ts
async function changeProfile(actor: SessionActor, command: ChangeProfileCommand) {
  const previous = actor.state.runtime;
  const target = await runtimeManager.getOrCreate(command.runtimeProfile);

  await actor.reachTurnBoundary(command.apply);
  actor.emit("profile.switching", { from: previous.id, to: target.id });

  try {
    const resumed = await target.adapter.resumeSession({
      nativeThreadId: actor.state.session.nativeThreadId!,
      workspacePath: actor.workspace.path,
    });

    await target.adapter.verifyRuntime(resumed, command.runtimeProfile);
    await actor.replaceRuntime(target, resumed);
    await actor.refreshNativeGoal();

    actor.emit("profile.changed", {
      runtimeId: target.id,
      model: resumed.model,
      modelProvider: resumed.modelProvider,
    });
  } catch (error) {
    await actor.restoreRuntime(previous);
    actor.emit("profile.change.failed", serializeError(error));
    throw error;
  }
}
```

切换失败时不创建隐式新 Thread，不修改原 Session 绑定，不伪造成功事件。

## 17. 权限修改

### 17.1 统一权限请求

```ts
interface PermissionPolicy {
  mode: "plan" | "prompt" | "accept_edits" | "full";
  allowedTools?: string[];
  disallowedTools?: string[];
  approvalPolicy?: string;
  sandboxMode?: string;
}
```

```json
{
  "type": "permission.change",
  "payload": {
    "policy": {
      "mode": "accept_edits",
      "disallowedTools": ["WebFetch"]
    },
    "apply": "next_tool_call"
  }
}
```

### 17.2 生效边界

Adapter 返回实际生效点：

```ts
interface ChangeResult {
  applied: boolean;
  effectiveAt: "immediate" | "next_tool_call" | "next_turn" | "session_restart";
  normalizedValue: unknown;
}
```

规则：

- Claude `setPermissionMode()` 可对后续工具请求动态生效。
- Claude `allowedTools`、`disallowedTools` 等若当前 SDK 不能热更新，则返回 `next_turn` 或 `session_restart`。
- Codex `approvalPolicy`、sandbox 相关配置默认在下一次 `turn/start` 生效。
- 需要立即收紧且 Provider 不支持热更新时，执行 interrupt，再以新策略启动 Turn。
- 权限变化不自动批准已经 pending 的工具调用。

## 18. Claude Adapter

### 18.1 RuntimeProfile 映射

统一 RuntimeProfile 由 Claude Adapter 转换为 SDK options 和子进程环境，不创建 Codex TOML：

```ts
interface ClaudeRuntime {
  options: Record<string, unknown>;
  env: Record<string, string>;
  fingerprint: string;
}
```

自定义 Profile 使用 `ANTHROPIC_BASE_URL`、`ANTHROPIC_AUTH_TOKEN` 注入 endpoint/key，
并为其分配隔离的 `CLAUDE_CONFIG_DIR`；默认 Profile 仍读取当前用户的 Claude 配置。
SDK 的 `settingSources: []` 防止用户级配置覆盖上游下发的临时 Profile。Adapter 不把
Provider 专用字段暴露到统一协议之外。

### 18.2 长期输入流

每个 Claude Session 使用一个 AsyncGenerator 输入队列：

```ts
class AsyncMessageQueue<T> {
  push(value: T): void;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterator<T>;
}
```

SDK `query()` 或客户端实例消费该队列，Adapter 同时消费流式输出并转换成统一事件。
每个新会话由 Adapter 预分配原生 UUID，所有 stream-json 用户帧显式携带
`session_id`，保证 CLI transcript 与会话绑定。

### 18.3 Profile 切换

Claude Profile 不是 Codex Profile 文件。切换时：

1. 到达 Turn 边界。
2. 关闭旧 SDK Runtime。
3. 使用新的 RuntimeProfile 创建 SDK Runtime。
4. transcript 由 SDK `SessionStore` 双写到设备侧 SQLite；新 Runtime 从该 Store
   物化会话后调用原生 Session resume。
5. 如果目标 SDK/后端不支持恢复，则返回 `profile.change.failed`，不静默创建新会话。

### 18.4 原生 Goal

Claude Code 的 Goal 原生入口不是 Agent SDK 的独立方法，而是会话内置命令和事件：

- `goal.set` → `/goal <condition>`
- `goal.get` → `/goal`，或读取当前 `active_goal` 状态
- `goal.clear` → `/goal clear`
- SDK `active_goal` → `goal.updated` / `goal.cleared`

Adapter 上报 `nativeGoal=true`。中心保存的仍是投影；`condition` 映射为统一协议的
`objective`，Claude 的 `iterations` 和 `last_reason` 作为扩展字段保留。Claude `/goal`
目前没有 token budget 参数，因此上游传入非空 `tokenBudget` 时返回明确的不支持错误。

## 19. 设备端持久化

SQLite 表建议：

```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  native_session_id TEXT,
  native_thread_id TEXT,
  runtime_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE pending_events (
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, sequence)
);

CREATE TABLE command_dedup (
  idempotency_key TEXT PRIMARY KEY,
  command_id TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL
);
```

API key 第一版不持久化。Daemon 重启后，有历史 Thread 但没有运行凭据的 Session 进入 `credentials_required`。

## 20. 重启与断线恢复

### 20.1 中心短暂断线

- Agent 继续运行。
- Device Daemon 把事件写入 `pending_events`。
- 中心重连后告知每个 Session 已确认的 sequence。
- Device 从下一个 sequence 补传。

### 20.2 Device Daemon 重启

```text
读取本地 Session
       │
       ├─ 没有 RuntimeProfile 凭据
       │     └─ credentials_required
       │
       └─ 中心重新下发 RuntimeProfile
             ├─ 重建 Worker
             ├─ thread/resume / Claude resume
             ├─ goal/get
             └─ session.resumed
```

中心收到：

```json
{
  "type": "runtime.credentials_required",
  "sessionId": "ses_01J...",
  "payload": {
    "profileFingerprint": "sha256:...",
    "baseUrl": "https://api.example.com/v1",
    "model": "example-model"
  }
}
```

中心重新发送完整 RuntimeProfile，不能依赖设备返回旧 key。

### 20.3 App Server 异常退出

- Worker 标记 `failed`。
- 所有绑定 Session 暂停接收新 Turn。
- 若 Daemon 仍持有 RuntimeProfile，可自动重建 Worker 并 `thread/resume`。
- 最多自动恢复 3 次，指数退避。
- 恢复失败后 Session 进入 `failed` 或 `credentials_required`。

## 21. 错误模型

```ts
interface GatewayError {
  code: string;
  message: string;
  retryable: boolean;
  provider?: "codex" | "claude";
  providerCode?: string;
  details?: unknown;
}
```

建议错误码：

```text
DEVICE_OFFLINE
AGENT_NOT_INSTALLED
WORKSPACE_NOT_FOUND
RUNTIME_PROFILE_INVALID
RUNTIME_START_FAILED
RUNTIME_CREDENTIALS_REQUIRED
SESSION_NOT_FOUND
SESSION_REVISION_CONFLICT
TURN_ALREADY_ACTIVE
TURN_NOT_ACTIVE
APPROVAL_NOT_PENDING
PROFILE_SWITCH_FAILED
PROFILE_RUNTIME_MISMATCH
MODEL_NOT_AVAILABLE
PERMISSION_CHANGE_UNSUPPORTED
NATIVE_GOAL_UNSUPPORTED
PROVIDER_PROTOCOL_ERROR
PROVIDER_PROCESS_EXITED
```

## 22. 可观测性

日志公共字段：

```text
deviceId
sessionId
nativeThreadId
nativeTurnId
runtimeId
profileFingerprint
commandId
eventSequence
provider
```

禁止记录：

- RuntimeProfile 原始 API key。
- Provider Authorization header。
- 未脱敏环境变量集合。

MVP 指标：

```text
gateway_devices_online
gateway_sessions_active
gateway_turn_duration_seconds
gateway_runtime_workers
gateway_runtime_start_failures_total
gateway_provider_errors_total
gateway_pending_approvals
gateway_event_backlog
gateway_profile_switch_duration_seconds
```

## 23. 跨平台进程管理

Daemon 必须以当前用户身份运行，以便访问用户的 Codex/Claude 配置、Git 凭据和工作区。

- Windows：登录用户的计划任务；子进程放入 Job Object，关闭 Worker 时终止整个进程树。
- macOS：LaunchAgent。
- Linux：`systemd --user`。

不要默认作为 Windows LocalSystem、macOS LaunchDaemon 或 Linux root service 运行。

## 24. 配置示例

Device Daemon：

```yaml
device:
  id: ken-pc
  name: Office Windows

controlServer:
  url: ws://192.168.1.10:8080/v1/device/connect

localApi:
  host: 127.0.0.1
  port: 9700

workspaces:
  - id: agent-client
    name: Agent Client
    path: D:\project\agent-client

runtime:
  maxWorkers: 8
  maxThreadsPerWorker: 8
  workerIdleTimeoutSeconds: 1800
  startupTimeoutSeconds: 20

events:
  flushIntervalMs: 30
  maxChunkBytes: 4096
```

## 25. 测试策略

### 25.1 单元测试

- Session Actor 命令排序。
- commandId/idempotencyKey 去重。
- Provider 事件映射。
- Approval 生命周期和重复响应。
- Profile 指纹规范化。
- Profile TOML 生成与特殊字符处理。
- 流式 delta 合并。
- 断线 ACK 与补传。

### 25.2 Contract Test

在 CI 或开发机中启动真实 App Server：

- `initialize` 握手。
- `thread/start`、`turn/start`、`thread/resume`。
- `turn/steer`、`turn/interrupt`。
- Approval request/response。
- Goal set/get/clear 和 updated 事件。
- 不同临时 Profile 之间恢复同一个 Thread。
- Profile 切换后 modelProvider 验证。

App Server schema 应通过当前安装的 Codex 生成并固定到测试 fixture：

```text
codex app-server generate-ts --out ./generated/codex
codex app-server generate-json-schema --out ./generated/codex-schema
```

升级 Codex 后重新生成并运行兼容性测试。

### 25.3 故障测试

- Turn 中途杀死 App Server。
- 审批等待时断开中心。
- Profile 切换时目标 endpoint 不可用。
- 中心重复发送同一 command。
- 事件发送后 ACK 丢失。
- Daemon 重启后中心重新下发 RuntimeProfile。
- Windows/macOS/Linux 路径与进程树终止。

## 26. 实施阶段

### Phase 1：单设备闭环

- Protocol package。
- Device Daemon 与中心 WebSocket。
- Codex App Server stdio Adapter。
- 临时 Profile 和 Worker Pool。
- Session 创建、Turn、流式事件。
- 简单 Web 终端。

验收：可从浏览器选择设备和工作区，使用上游下发 endpoint/key 启动 Codex 并实时看到输出。

### Phase 2：交互控制

- Approval。
- `message.send` 的 steer/queue/interrupt。
- 模型切换。
- 权限修改。
- 原生 Goal。

验收：运行中可插入消息、远程审批、更新 Goal，并在下一个 Turn 切换模型。

### Phase 3：Profile 与恢复

- Profile 运行中切换。
- Worker 复用与回收。
- 事件 ACK、补传和 SQLite。
- Daemon/App Server 重启恢复。

验收：切换 endpoint/key 后保持同一个 Codex Thread 和 Goal；短暂断线不丢事件。

### Phase 4：Claude Adapter

- Claude Agent SDK Streaming Input。
- Approval 与权限模式。
- 原生 Session 恢复。
- RuntimeProfile 映射。

验收：聚合终端使用相同命令和事件协议控制 Claude，会按能力差异禁用不支持的操作。

## 27. 必须先验证的技术假设

正式开发前完成以下 PoC：

1. 使用 Profile A 创建 Codex Thread，在 Profile B 的 App Server 中 `thread/resume`，确认后续请求实际使用 Profile B 的 `model_provider`。
2. 上述切换后调用 `thread/goal/get`，确认 Goal、token usage 和 time usage保持。
3. App Server 等待审批时中心断开 5 分钟，重连后仍能提交原 JSON-RPC response。
4. 当前 Claude Agent SDK 版本中断、恢复和运行时权限修改的准确行为。
5. Windows 上 Codex App Server 子进程和其命令子进程能通过 Job Object 一起终止。

如果第 1 项不成立，第一版 `profile.change` 应返回 `PROFILE_SWITCH_UNSUPPORTED_FOR_EXISTING_THREAD`，由 UI 提供显式“使用新 Profile 分叉会话”，不能静默创建新 Thread。

## 28. MVP 完成标准

- 三个平台至少各完成一次手动安装和连接测试。
- 同一中心可同时显示至少三台设备。
- 单设备至少并发两个 Session。
- Codex 流式文本和命令输出实时可见。
- Approval 可以跨中心和设备完整往返。
- Goal 使用原生 RPC，中心重启后可重新投影。
- 模型变更在声明的生效点生效。
- Profile 由上游 endpoint/key 临时创建，Worker 退出后文件被清理。
- Profile 切换成功时保持原生 Thread；失败时保持旧 Runtime。
- 中心断线重连后无事件丢失或乱序。
- 所有控制命令具备幂等性和 revision 冲突检测。

## 29. 官方参考

- [OpenAI Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [OpenAI Codex SDK](https://learn.chatgpt.com/docs/codex-sdk)
- [OpenAI Codex Advanced Configuration](https://learn.chatgpt.com/docs/config-file/config-advanced)
- [OpenAI Codex Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Claude Agent SDK Overview](https://code.claude.com/docs/en/agent-sdk/overview)
- [Claude Agent SDK Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- [Claude Agent SDK Approvals](https://code.claude.com/docs/en/agent-sdk/user-input)
- [Claude Agent SDK Permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
