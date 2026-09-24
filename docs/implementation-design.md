# Agent Gateway 实现设计

> 状态：Claude-only 版本  
> 更新：2026-09-25

## 1. 范围

系统面向单用户、多设备和内网控制场景。每台目标设备运行一个 Device Daemon，通过反向 WebSocket 主动连接可达的 Control Server，因此目标设备可以位于 NAT 后面。

当前只支持 Claude Code Agent SDK。此前的 Codex/Claude 双平台版本保存在 Git 标签 `pre-claude-only-2026-09-25`。

系统提供：

- 多设备注册、心跳和工作目录发现。
- Claude 会话创建、恢复和原生历史读取。
- 流式文本、工具事件和错误事件。
- 工具审批、澄清问题和审批结果回传。
- 消息排队、中断、模型切换和 Profile 切换。
- Claude 原生 `/goal` 的设置、查询和清除。
- 主 Agent、项目 Agent 与 Console MCP 的控制链路。
- Console 下发 endpoint、key、model、指令和 Skill bundle。

## 2. 组件

```text
Browser / Agent Project Console
              │ HTTP / SSE
              ▼
        Control Server
              ▲
              │ outbound WebSocket
              │
        Device Daemon
              │
              ├─ Session Actor
              ├─ Runtime Manager
              ├─ Claude Adapter
              ├─ Claude SessionStore (SQLite)
              └─ Console MCP Bridge
```

Control Server 不需要知道目标设备的可访问地址。Device Daemon 主动连接中心并保持心跳，中心通过该连接下发命令。

## 3. Claude Runtime

Claude Adapter 使用 Agent SDK 的 Streaming Input 模式，每个活动会话持有输入队列和长生命周期 `Query`：

- `createSession` 创建原生 Claude session。
- `resumeSession` 使用原生 session id 恢复。
- `sendMessage` 默认排队；Claude 不声明真正的当前 Turn steer。
- `interrupt` 调用 SDK 中断能力。
- `setModel` 在后续 Turn 生效。
- `setPermissionMode` 修改后续工具调用权限。
- `SessionStore` 持久化原生 transcript，Gateway 不从事件流重建历史。

默认 Profile 使用当前用户的 Claude 配置。上游下发 Profile 时，Runtime 使用隔离的临时 `CLAUDE_CONFIG_DIR`，并通过环境变量注入 endpoint、key 和 model，不修改设备全局配置。

Profile key 只参与不可逆指纹计算，不写入日志、事件或持久化配置文件。

## 4. Session Actor

每个会话由独立 Session Actor 串行处理所有会改变 Provider 状态的命令，避免以下竞争：

- Turn 启动与中断同时发生。
- 审批结果与权限策略切换交错。
- Profile 切换期间又收到消息。
- 模型切换与新 Turn 同时提交。

主要状态：

```text
starting → idle → running → idle
                 ├→ waiting_approval
                 ├→ interrupting
                 └→ switching_profile

任意状态 → failed / closed
```

Profile 切换在 Turn 边界执行。已有对话使用原生 session id 在新的 Claude Runtime 中恢复；切换失败时尝试恢复原 Runtime。

## 5. 主 Agent 与项目 Agent

主 Agent 的职责是理解用户自然语言、维护项目组合并调配项目 Agent。它不持续接收项目执行细节；项目 Agent 只在需要决策、审批、阻塞处理或阶段汇报时联系主 Agent。

项目 Agent 在自己的工作目录中执行任务，并可使用 Claude Code 自身提供的子 Agent 能力。

Console MCP Bridge 根据 `ControlContext` 注入不同工具：

- `role=orchestrator`：项目管理、排期、启动项目 Agent、查询状态和发送指令。
- `role=project`：项目状态汇报、询问主 Agent、请求审批和提交结果。

MCP 上下文包含主会话、项目和项目运行 ID，避免 Agent 自行拼接控制面身份。

## 6. Bootstrap 与 Skill

Console 是配置真源，目标设备不预存项目配置或密钥。创建会话时可下发：

```ts
interface AgentBootstrapInput {
  instructionsVersion: string;
  instructions: string;
  skillBundles?: Array<{
    id: string;
    version: string;
    sha256?: string;
    files: Record<string, string>;
  }>;
}
```

Device Daemon 将 bundle 写成 Runtime 临时 Claude Plugin，并通过 SDK 的 `plugins` 和 `skills` 选项作为原生 Skill 加载；Runtime 回收时临时目录一并删除。Skill 文件不再拼接进常驻 system prompt。角色硬约束仍放在始终生效的 system prompt。

## 7. 权限与审批

权限策略由 Console 保存并随会话下发：

```ts
interface PermissionPolicy {
  mode: "plan" | "prompt" | "accept_edits" | "full";
  allowedTools?: string[];
  disallowedTools?: string[];
}
```

规则支持精确工具名和后缀 `*` 前缀匹配，deny 优先。`allowedTools` 表示无需询问即可执行，并不等价于工具可见性白名单。主 Agent 在平台层只保留 Claude 的 `Skill` 内置工具和 Console MCP；Bash、Read、Write、Edit、Agent 等内置工具不会进入其工具上下文。项目 Agent 继续使用完整 Claude Code 工具集。

项目和全局策略负责自动允许只读 MCP、额外 allow/deny 工具。待处理审批由 Console 展示并通过原始会话连接回传。

## 8. Goal

Goal 使用 Claude Code 原生 `/goal` 命令和系统事件：

- `goal.set`：设置 condition。
- `goal.get`：读取当前 Goal。
- `goal.clear`：清除 Goal。

Claude Goal 不支持 token budget，统一返回中的 `tokenBudget` 为 `null`。Goal 命令与普通 Turn 共用会话，因此由 Session Actor 串行化。

## 9. 历史与事件

聊天历史直接读取 Claude SDK SessionStore，仅返回用户和助手消息。工具调用、系统消息和推理内容通过事件接口独立提供，不混入聊天气泡。

设备事件带单调递增 sequence。Device Daemon 在本地 SQLite 中保存尚未被中心确认的事件，断线重连后重发；Control Server 用 event id 和 sequence 去重。

## 10. 配置与运行

设备配置只包含：

- 设备 ID 和名称。
- Control Server WebSocket 地址。
- 本地诊断 API 地址。
- 数据目录。
- 工作目录列表。
- Runtime 数量与空闲回收时间。

Daemon 必须以实际登录用户运行，以访问 Claude Code 登录态、Git 凭据和项目目录。Windows 服务部署应使用该用户的计划任务或用户级服务。

## 11. 验证重点

- Claude CLI 探测和能力注册。
- 默认配置与上游 Profile 的真实调用。
- SessionStore 历史在 Daemon 重启后仍可读取。
- 流式完成、错误和中断事件完整。
- 审批在断线重连后仍能处理。
- Profile 切换后恢复同一原生会话。
- 主 Agent 仅获得设计允许的控制面工具。
- 临时 Profile、Skill 和凭据随 Runtime 回收。
