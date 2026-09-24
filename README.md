# Agent Gateway

面向个人内网多设备的 Codex / Claude Agent 聚合服务。

## 快速开始

```powershell
npm install
Copy-Item device.config.example.json device.config.local.json
npm run server
```

The example stores Codex state and temporary runtime profiles under
`.data/device/codex-home`. Remove `codexHome` from the device config if the daemon
should instead reuse the interactive user's existing `CODEX_HOME` and login.

另开一个终端：

```powershell
$env:AGENT_DEVICE_CONFIG = "device.config.local.json"
npm run device
```

浏览器打开 `http://127.0.0.1:8080`，或者通过 HTTP API 创建会话。

完整设计见 [docs/implementation-design.md](docs/implementation-design.md)。

## 创建会话

```http
POST /v1/sessions
Content-Type: application/json

{
  "deviceId": "my-device",
  "agent": "codex",
  "workspaceId": "agent-client",
  "runtimeProfile": {
    "baseUrl": "https://api.example.com/v1",
    "apiKey": "sk-example",
    "model": "example-model",
    "protocol": "responses"
  },
  "prompt": "检查项目并说明结构"
}
```

如果要使用本机现有 Codex 登录和配置，可以省略 `runtimeProfile`。
