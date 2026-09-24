# Agent Gateway

面向个人多设备环境的 Claude Code 网络代理。设备端 Daemon 通过反向 WebSocket 连接控制服务，把本机 Claude Agent SDK 的会话、流式输出、审批、中断、模型切换、Profile、Goal 和 MCP 能力暴露给上层 Console。

当前版本仅支持 Claude Code。删除前的 Codex/Claude 双平台实现保存在 Git 标签 `pre-claude-only-2026-09-25`。

## 快速开始

要求 Node.js 22 或更高版本，并确保当前用户可以运行 `claude --version`。

```powershell
npm install
Copy-Item device.config.example.json device.config.local.json
npm run server
```

另开一个终端启动设备 Daemon：

```powershell
$env:AGENT_DEVICE_CONFIG = "device.config.local.json"
npm run device
```

浏览器打开 `http://127.0.0.1:8080`，也可以直接通过 HTTP API 创建会话。

## 创建 Claude 会话

```http
POST /v1/sessions
Content-Type: application/json

{
  "deviceId": "my-device",
  "agent": "claude",
  "workspaceId": "agent-client",
  "runtimeProfile": {
    "baseUrl": "https://api.example.com",
    "apiKey": "sk-example",
    "model": "claude-sonnet-4-5",
    "protocol": "anthropic"
  },
  "prompt": "检查项目并说明结构"
}
```

省略 `runtimeProfile` 时，Daemon 使用当前用户的默认 Claude Code 配置。

完整接口见 [API 文档](docs/api.md)，运行时设计见 [实现设计](docs/implementation-design.md)。
