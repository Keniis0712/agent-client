# Agent Gateway API

本文档描述当前实现的内网 Control Server API，供 Agent 聚合终端及其他上层服务接入。

## 1. 基本约定

- 默认 HTTP 地址：`http://127.0.0.1:8080`
- 终端事件流：`ws://127.0.0.1:8080/v1/terminal`
- API 版本：`v1`
- 请求与响应编码：`application/json; charset=utf-8`
- 时间格式：ISO 8601 UTC，例如 `2026-09-21T10:32:44.712Z`
- 当前版本面向可信内网，不包含认证、授权和 TLS。
- HTTP body 上限为 2 MiB。

创建会话和执行命令都是异步操作。HTTP `202 Accepted` 只表示请求已进入设备命令队列，
不表示 Provider 已执行成功。最终结果必须通过 WebSocket 或事件查询接口确认：

- 成功：`command.applied`
- 失败：`command.failed`
- Turn 完成：`turn.completed`

推荐客户端同时使用 HTTP 发命令、WebSocket 收实时事件，并用事件查询接口补偿断线期间的事件。

## 2. 数据模型

### 2.1 Device

`GET /v1/devices` 返回设备注册信息：

```json
{
  "device": {
    "id": "my-device",
    "name": "My development device",
    "platform": "win32",
    "arch": "x64",
    "daemonVersion": "0.1.0"
  },
  "agents": [
    {
      "id": "claude",
      "available": true,
      "version": "2.1.278 (Claude Code)",
      "capabilities": {
        "streaming": true,
        "approvals": true,
        "clarifyQuestions": true,
        "nativeGoal": true,
        "steerCurrentTurn": false,
        "queueMessages": true,
        "interrupt": true,
        "switchModelNextTurn": true,
        "changePermissionLive": true,
        "mutateToolInput": true,
        "resumeSession": true
      }
    }
  ],
  "workspaces": [
    {
      "id": "agent-client",
      "name": "Agent Client",
      "path": "D:\\project\\agent-client"
    }
  ],
  "status": "online",
  "lastSeenAt": "2026-09-21T10:32:20.266Z"
}
```

`status` 为 `online` 或 `offline`。只有在线设备能够创建新会话或执行命令。

### 2.2 ProviderCapabilities

| 字段 | 含义 |
|---|---|
| `streaming` | 支持流式文本/事件 |
| `approvals` | 支持远程工具审批 |
| `clarifyQuestions` | 支持 Agent 向用户提问 |
| `nativeGoal` | 支持 Provider 原生 Goal |
| `steerCurrentTurn` | 支持不终止当前 Turn 的实时 steer |
| `queueMessages` | 支持消息排队 |
| `interrupt` | 支持中断当前 Turn |
| `switchModelNextTurn` | 支持运行时切换模型 |
| `changePermissionLive` | 支持会话内修改工具权限 |
| `mutateToolInput` | 审批时可以修改工具输入 |
| `resumeSession` | 支持恢复原生 Thread/Session |

上层必须根据这里的能力动态展示操作。例如 Claude 的 `steerCurrentTurn=false`，`steer`
请求会退化为排队。

### 2.3 SessionRecord

```json
{
  "id": "ses_123",
  "deviceId": "my-device",
  "agent": "claude",
  "workspaceId": "agent-client",
  "nativeSessionId": "dd1804c7-5c21-4986-b518-e974f03a20d7",
  "nativeThreadId": "dd1804c7-5c21-4986-b518-e974f03a20d7",
  "runtimeId": "run_123",
  "profileFingerprint": "sha256-value",
  "effectiveModel": "claude-sonnet-4-5",
  "effectiveModelProvider": "anthropic",
  "status": "idle",
  "revision": 5,
  "lastSequence": 18,
  "createdAt": "2026-09-21T10:30:00.000Z",
  "updatedAt": "2026-09-21T10:32:00.000Z"
}
```

会话状态：

- `starting`
- `idle`
- `running`
- `waiting_approval`
- `interrupting`
- `switching_profile`
- `credentials_required`
- `failed`
- `closed`

`revision` 是乐观并发控制版本。`lastSequence` 是该会话已投影的最新事件序号。

### 2.4 RuntimeProfile

```json
{
  "id": "optional-client-id",
  "baseUrl": "https://gateway.example.internal/v1",
  "apiKey": "secret",
  "model": "model-name",
  "protocol": "anthropic",
  "modelProvider": "optional-provider-name",
  "reasoningEffort": "high",
  "extraHeaders": {
    "X-Tenant": "personal"
  },
  "options": {}
}
```

约束：

- `baseUrl` 必须是合法 URL。
- `apiKey`、`model` 不可为空。
- 当前仅支持 `protocol: "anthropic"`。
- `reasoningEffort` 可选值：`minimal | low | medium | high | xhigh`。
- `extraHeaders` 是前向兼容保留字段，当前 Claude Adapter 暂未消费。
- `options` 是前向兼容保留字段，当前 Adapter 不消费。
- Profile 的 key 不应出现在日志或事件中；事件只返回不可逆的 `profileFingerprint`。

省略 `runtimeProfile` 时，Agent 使用运行 daemon 的当前用户默认配置和登录状态。

### 2.5 PermissionPolicy

```json
{
  "mode": "prompt",
  "allowedTools": ["Read", "Grep"],
  "disallowedTools": ["WebFetch"],
  "approvalPolicy": "on-request",
  "sandboxMode": "workspace-write"
}
```

`mode` 可选值：

- `plan`：计划/只读模式。
- `prompt`：需要时请求审批。
- `accept_edits`：自动接受编辑类操作。
- `full`：尽可能放开工具权限。

`approvalPolicy`、`sandboxMode` 是 Provider 相关高级覆盖项，上层通常只需要设置 `mode`。

## 3. HTTP API

### 3.1 健康检查

```http
GET /healthz
```

响应：

```json
{ "ok": true }
```

### 3.2 查询设备

```http
GET /v1/devices
```

响应：Device 数组，结构见 2.1。

### 3.3 查询会话列表

```http
GET /v1/sessions
```

响应：`SessionRecord[]`，按最近更新时间倒序排列。

### 3.4 查询单个会话

```http
GET /v1/sessions/{sessionId}
```

响应：`SessionRecord`。

不存在时：

```json
{
  "error": {
    "code": "SESSION_NOT_FOUND",
    "message": "ses_unknown",
    "retryable": false
  }
}
```

### 3.5 创建会话

```http
POST /v1/sessions
Content-Type: application/json
```

编排型会话还可以携带 `controlContext` 与 `bootstrap`。它们只作用于当前 Runtime，不会写入目标工作区或用户的全局 Claude 配置：

```json
{
  "controlContext": {
    "consoleBaseUrl": "https://apc.example.com",
    "role": "project",
    "orchestratorSessionId": "main-1",
    "projectId": "project-1",
    "projectRunId": "run-1"
  },
  "bootstrap": {
    "instructionsVersion": "project-agent-v1",
    "instructions": "角色契约",
    "skillBundles": [
      { "id": "project-agent", "version": "1.0.0", "files": { "SKILL.md": "# Workflow" } }
    ]
  }
}
```

设备将完整 `runtimeProfile` 和 Skill Bundle 物化到会话专属临时目录，并为该会话动态注入 Console MCP Bridge；Runtime 释放后临时目录会被删除。

`consoleBaseUrl` 是 Agent 终端主动访问的 APC 地址，不是终端自身地址。终端可以处于 NAT 后，无需公网 IP、入站端口或端口映射。

请求：

```json
{
  "sessionId": "optional-client-generated-id",
  "deviceId": "my-device",
  "agent": "claude",
  "workspaceId": "agent-client",
  "runtimeProfile": {
    "baseUrl": "https://gateway.example.internal",
    "apiKey": "secret",
    "model": "claude-sonnet-4-5",
    "protocol": "anthropic"
  },
  "permissionPolicy": {
    "mode": "prompt"
  },
  "prompt": "检查项目当前状态"
}
```

字段：

| 字段 | 必填 | 说明 |
|---|---:|---|
| `sessionId` | 否 | 省略时由服务生成 `ses_*` |
| `deviceId` | 是 | 目标在线设备 |
| `agent` | 是 | 固定为 `claude` |
| `workspaceId` | 是 | 来自设备注册信息的工作区 ID |
| `runtimeProfile` | 否 | 本次会话的 endpoint/key/model |
| `permissionPolicy` | 否 | 默认 `{ "mode": "prompt" }` |
| `prompt` | 否 | 创建完成后立即开始首个 Turn |

响应 `202`：

```json
{
  "sessionId": "ses_123",
  "status": "starting"
}
```

创建过程通过 `session.started` 或会话状态 `failed` 确认。不要把 HTTP `202` 当成创建成功。

### 3.6 执行会话命令

```http
POST /v1/sessions/{sessionId}/commands
Content-Type: application/json
```

通用请求结构：

```json
{
  "commandId": "cmd-client-001",
  "idempotencyKey": "terminal-01-action-001",
  "expectedRevision": 5,
  "type": "message.send",
  "payload": {
    "content": "继续执行并运行测试",
    "delivery": "auto"
  }
}
```

| 字段 | 必填 | 说明 |
|---|---:|---|
| `commandId` | 是 | 客户端生成，用于关联结果事件 |
| `idempotencyKey` | 是 | 重试时保持不变；设备只执行一次 |
| `expectedRevision` | 否 | 乐观锁；不匹配则产生 `SESSION_REVISION_CONFLICT` |
| `type` | 是 | 命令类型 |
| `payload` | 是 | 命令参数；无参数时传 `{}` |

响应 `202`：

```json
{
  "accepted": true,
  "commandId": "cmd-client-001"
}
```

最终事件：

```json
{
  "type": "command.applied",
  "payload": {
    "commandId": "cmd-client-001",
    "result": {
      "actualDelivery": "queue"
    }
  }
}
```

或者：

```json
{
  "type": "command.failed",
  "payload": {
    "commandId": "cmd-client-001",
    "error": {
      "code": "SESSION_REVISION_CONFLICT",
      "message": "Expected revision 5, current revision is 7",
      "retryable": false
    }
  }
}
```

### 3.7 查询历史事件

```http
GET /v1/sessions/{sessionId}/events?afterSequence=17
```

响应：`AgentEvent[]`，按 `sequence` 递增。

第一次同步使用 `afterSequence=0`。WebSocket 重连后使用客户端最后持久化的 sequence 补拉，
然后继续消费实时事件。客户端应以 `(sessionId, sequence)` 去重。

### 3.8 查询原生对话历史

```http
GET /v1/sessions/{sessionId}/history
```

该接口实时读取 Claude SDK SessionStore 保存的主 transcript，不从 Gateway 事件表重建聊天内容。响应示例：

```json
{
  "source": "native",
  "messages": [
    {
      "id": "message-id",
      "role": "user",
      "content": "请检查测试",
      "nativeTurnId": "turn-id",
      "createdAt": "2026-09-23T08:00:00.000Z"
    }
  ]
}
```

`role` 只包含 `user` 和 `assistant`。工具调用、推理和系统元数据不会作为聊天消息返回。
内部编排通知可能带有 `hidden: true`，UI 应默认隐藏。SessionActor 或设备服务重启后仍可读取历史：
设备根据持久化的会话元数据定位 Claude SDK SessionStore，不需要恢复执行 Runtime。

### 3.9 Goal 快捷 API

#### 查询投影

```http
GET /v1/sessions/{sessionId}/goal
```

返回当前中心投影或 JSON `null`：

```json
{
  "threadId": "native-thread-id",
  "objective": "所有测试通过",
  "status": "active",
  "tokenBudget": null,
  "tokensUsed": 0,
  "timeUsedSeconds": 12,
  "createdAt": 1789986764963,
  "updatedAt": 1789986777000,
  "iterations": 1,
  "lastReason": "Tests are still failing"
}
```

Claude `/goal` 支持 condition、iterations 和 last reason，不支持 token budget；
`tokenBudget` 因此为 `null`。

#### 设置 Goal

```http
PUT /v1/sessions/{sessionId}/goal
Content-Type: application/json

{
  "objective": "所有测试通过",
  "status": "active",
  "tokenBudget": null
}
```

响应 `202`：

```json
{
  "accepted": true,
  "commandId": "cmd_generated"
}
```

最终通过 `goal.updated` 和 `command.applied` 确认。

#### 清除 Goal

```http
DELETE /v1/sessions/{sessionId}/goal
```

最终通过 `goal.cleared` 确认。

`GET /goal` 读取中心投影，不主动调用 Provider。需要强制读取 Provider 当前状态时，发送
`goal.get` 命令并读取对应 `command.applied.payload.result`。

## 4. 命令参考

### 4.1 `message.send`

```json
{
  "content": "先不要改前端，优先修复后端测试",
  "delivery": "auto"
}
```

`delivery`：

- `auto`：由 Adapter 选择。无活动 Turn 时创建新 Turn。
- `steer`：优先插入当前 Turn；不支持 steer 的 Provider 会退化为 queue。
- `queue`：在当前 Turn 完成后开始。
- `interrupt`：中断当前 Turn，再以该消息开始新 Turn。

实际策略通过 `message.accepted.payload.actualDelivery` 返回。

### 4.2 `turn.interrupt`

```json
{}
```

没有活动 Turn 时失败并返回 `TURN_NOT_ACTIVE`。

### 4.3 `approval.resolve`

```json
{
  "approvalId": "apr_123",
  "decision": {
    "type": "allow_with_changes",
    "updatedInput": {
      "file_path": "D:\\project\\agent-client\\README.md",
      "content": "modified content"
    }
  }
}
```

Decision 类型：

- `allow_once`
- `allow_session`
- `allow_with_changes`
- `deny`
- `cancel`

拒绝示例：

```json
{
  "approvalId": "apr_123",
  "decision": {
    "type": "deny",
    "message": "不要修改该文件"
  }
}
```

提问类审批可附加：

```json
{
  "type": "allow_once",
  "answers": {
    "question-id": ["answer-a"]
  }
}
```

只发送 `approval.required.payload.availableDecisions` 中列出的选择。

### 4.4 `model.change`

```json
{
  "model": "claude-sonnet-4-5",
  "apply": "next_turn"
}
```

`apply`：`next_turn | interrupt`。成功后产生 `model.changed`。

### 4.5 `profile.change`

```json
{
  "runtimeProfile": {
    "baseUrl": "https://second-gateway.example.internal",
    "apiKey": "new-secret",
    "model": "new-model",
    "protocol": "anthropic"
  },
  "apply": "after_turn"
}
```

`apply`：

- `after_turn`：有活动 Turn 时等待边界切换。
- `interrupt`：先中断，再切换。

事件顺序通常为：

```text
profile.change.requested   # 仅延后切换时
session.status.changed     # switching_profile
profile.switching
profile.changed
command.applied
```

切换失败时产生 `profile.change.failed` 和 `command.failed`，实现会尝试恢复原 Runtime。

### 4.6 `permission.change`

```json
{
  "policy": {
    "mode": "plan",
    "allowedTools": ["Read", "Grep"]
  },
  "apply": "next_tool_call"
}
```

`apply`：`next_turn | interrupt | next_tool_call`。Provider 可能返回不同的实际生效时点，
以 `permission.changed.payload.effectiveAt` 为准。

### 4.7 `goal.set`

```json
{
  "objective": "完成迁移并保持所有测试通过",
  "status": "active",
  "tokenBudget": 50000
}
```

Claude 不接受非空 `tokenBudget`。成功后产生 `goal.updated`。

### 4.8 `goal.get`

```json
{}
```

Provider 返回值位于 `command.applied.payload.result`。

### 4.9 `goal.clear`

```json
{}
```

成功结果：`{ "cleared": true }`，并产生 `goal.cleared`。

### 4.10 `session.compact`

```json
{}
```

要求 Provider 压缩当前会话上下文。Claude 映射为 `/compact`。

### 4.11 `session.close`

```json
{}
```

关闭原生会话、释放 Runtime 引用，并把会话状态改为 `closed`。

## 5. WebSocket 实时事件

连接：

```text
ws://127.0.0.1:8080/v1/terminal
```

连接后默认接收所有会话事件。订阅特定会话：

```json
{
  "type": "subscribe",
  "sessionId": "ses_123"
}
```

取消：

```json
{
  "type": "unsubscribe",
  "sessionId": "ses_123"
}
```

注意：当前实现中订阅集合为空表示接收所有会话，而不是不接收事件。

服务端消息：

```json
{
  "type": "agent.event",
  "payload": {
    "eventId": "evt_123",
    "sequence": 18,
    "timestamp": "2026-09-21T10:32:48.501Z",
    "deviceId": "my-device",
    "sessionId": "ses_123",
    "sessionRevision": 5,
    "nativeThreadId": "native-thread-id",
    "nativeTurnId": "native-turn-id",
    "type": "assistant.delta",
    "payload": {
      "delta": "测试"
    }
  }
}
```

WebSocket 不负责历史补发。断线恢复必须调用 `/events?afterSequence=N`。

## 6. 事件参考

### 6.1 生命周期事件

| 事件 | 典型 payload |
|---|---|
| `session.started` | `{ "session": SessionRecord }` 或 Provider init 信息 |
| `session.status.changed` | `{ "status": "waiting_approval" }` |
| `turn.started` | Provider Turn 信息或 `{ "source": "goal" }` |
| `turn.completed` | Provider 原始完成结果、usage、cost、错误状态 |
| `message.accepted` | `{ "requestedDelivery": "steer", "actualDelivery": "queue" }` |
| `command.applied` | `{ "commandId": "...", "result": ... }` |
| `command.failed` | `{ "commandId": "...", "error": SerializedError }` |

### 6.2 流式输出事件

| 事件 | payload |
|---|---|
| `assistant.delta` | `{ "delta": "text fragment" }` |
| `reasoning.delta` | `{ "delta": "reasoning fragment" }` |
| `tool.started` | Provider 工具调用块，通常包含工具名、ID 和输入 |
| `tool.completed` | 工具结果，通常包含 tool ID、content、is_error |
| `provider.error` | `{ "message": "..." }` 或 `{ "error": SerializedError }` |

客户端应按事件顺序拼接同一 `nativeTurnId` 的 `assistant.delta.payload.delta`。

### 6.3 审批事件

`approval.required`：

```json
{
  "id": "apr_123",
  "sessionId": "ses_123",
  "nativeRequestId": "native-request-id",
  "nativeTurnId": "native-turn-id",
  "nativeToolCallId": "tool-call-id",
  "kind": "file_change",
  "status": "pending",
  "title": "Write",
  "toolName": "Write",
  "input": {
    "file_path": "D:\\project\\agent-client\\README.md",
    "content": "..."
  },
  "availableDecisions": [
    "allow_once",
    "allow_session",
    "allow_with_changes",
    "deny",
    "cancel"
  ]
}
```

`kind`：`command | file_change | network | permission | question`。

审批完成后产生：

```json
{
  "type": "approval.resolved",
  "payload": {
    "approvalId": "apr_123",
    "decision": "allow_once"
  }
}
```

### 6.4 配置事件

- `model.changed`
- `permission.changed`
- `profile.change.requested`
- `profile.switching`
- `profile.changed`
- `profile.change.failed`
- `profile.rollback.failed`

### 6.5 Goal 事件

`goal.updated`：

```json
{
  "goal": {
    "threadId": "native-thread-id",
    "objective": "所有测试通过",
    "status": "active",
    "tokenBudget": null,
    "tokensUsed": 0,
    "timeUsedSeconds": 5,
    "iterations": 1
  }
}
```

清除或 Claude Goal 达成后产生 `goal.cleared`。

## 7. 错误模型

同步 HTTP 错误：

```json
{
  "error": {
    "code": "DEVICE_OFFLINE",
    "message": "my-device",
    "retryable": true,
    "details": {}
  }
}
```

异步命令错误使用相同结构，位于 `command.failed.payload.error`。

常见错误码：

| code | 含义 |
|---|---|
| `INVALID_JSON` | body 不是合法 JSON |
| `BODY_TOO_LARGE` | body 超过 2 MiB |
| `NOT_FOUND` | HTTP 路由不存在 |
| `DEVICE_OFFLINE` | 设备未连接 |
| `DEVICE_TIMEOUT` | 设备命令响应超时 |
| `SESSION_NOT_FOUND` | 中心或设备找不到会话 |
| `SESSION_ALREADY_EXISTS` | session ID 已存在 |
| `WORKSPACE_NOT_FOUND` | workspace ID 不存在 |
| `SESSION_REVISION_CONFLICT` | `expectedRevision` 已过期 |
| `INVALID_MESSAGE` | 消息为空 |
| `TURN_ALREADY_ACTIVE` | 当前已有活动 Turn |
| `TURN_NOT_ACTIVE` | 没有可中断的 Turn |
| `TURN_INTERRUPT_TIMEOUT` | 中断等待超时 |
| `APPROVAL_NOT_PENDING` | 审批不存在或已处理 |
| `MODEL_NOT_AVAILABLE` | model 为空或不可用 |
| `RUNTIME_PROFILE_INVALID` | Profile 缺失或非法 |
| `RUNTIME_LIMIT_REACHED` | Runtime worker 达到上限 |
| `PROFILE_SWITCH_FAILED` | Profile 切换或回滚失败 |
| `PROFILE_RUNTIME_MISMATCH` | 目标 Runtime 未实际使用预期 Provider |
| `GOAL_INVALID` | Goal objective 为空 |
| `GOAL_TOKEN_BUDGET_UNSUPPORTED` | Provider 不支持 token budget |
| `GOAL_STATUS_UNSUPPORTED` | Provider 不支持指定 Goal 状态 |
| `GOAL_COMMAND_TIMEOUT` | 原生 Goal 命令超时 |
| `COMMAND_UNSUPPORTED` | Adapter 不支持该命令 |
| `INTERNAL_ERROR` | 未归类内部错误 |

Zod 请求校验错误当前也以 HTTP `400` 返回，但内容会被序列化为 `INTERNAL_ERROR`；客户端应
优先依据 HTTP 状态和 `error.message` 展示具体字段问题。

## 8. 客户端推荐流程

1. `GET /v1/devices`，选择 `online` 设备、Agent 和 workspace。
2. 检查目标 Agent 的 `capabilities`。
3. 建立 `/v1/terminal` WebSocket。
4. `POST /v1/sessions`，记录 `sessionId`。
5. 订阅会话，等待 `session.started`。
6. 发送命令时生成稳定的 `commandId` 和 `idempotencyKey`。
7. 保存每个会话最后处理的 `sequence`。
8. WebSocket 断线重连后，先通过 `/events?afterSequence=N` 补拉，再继续实时消费。
9. 收到 `approval.required` 时只展示 `availableDecisions` 中允许的操作。
10. 收到 `command.failed` 时按 `retryable` 决定自动重试或提示用户。

## 9. 完整交互示例

创建 Claude 会话：

```powershell
$body = @{
  deviceId = "my-device"
  agent = "claude"
  workspaceId = "agent-client"
  permissionPolicy = @{ mode = "prompt" }
  prompt = "检查项目并汇报测试状态"
} | ConvertTo-Json -Depth 8

$session = Invoke-RestMethod `
  -Method Post `
  -Uri http://127.0.0.1:8080/v1/sessions `
  -ContentType application/json `
  -Body $body
```

追加消息：

```powershell
$command = @{
  commandId = "cmd-001"
  idempotencyKey = "terminal-a-001"
  type = "message.send"
  payload = @{
    content = "修复失败的测试"
    delivery = "auto"
  }
} | ConvertTo-Json -Depth 8

Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8080/v1/sessions/$($session.sessionId)/commands" `
  -ContentType application/json `
  -Body $command
```

补拉事件：

```powershell
Invoke-RestMethod `
  -Uri "http://127.0.0.1:8080/v1/sessions/$($session.sessionId)/events?afterSequence=0"
```

## 10. 设备本地诊断 API

Device Daemon 默认监听 `127.0.0.1:9700`，只用于本机诊断：

```http
GET /healthz
GET /v1/sessions
```

它不提供完整控制能力。上层聚合终端应只连接 Control Server 的 `8080` 端口。
