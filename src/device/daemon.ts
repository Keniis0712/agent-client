import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import WebSocket from "ws";
import type {
  AgentEvent,
  ControlToDeviceMessage,
  CreateSessionRequest,
  DeviceToControlMessage,
  SessionCommand,
} from "../protocol/types.js";
import { createSessionSchema, sessionCommandSchema } from "../protocol/schemas.js";
import { createId } from "../shared/ids.js";
import { log } from "../shared/log.js";
import { serializeError, GatewayError } from "../shared/errors.js";
import type { DeviceConfig } from "./config.js";
import { DeviceStore } from "./event-store.js";
import { RuntimeManager } from "./runtime-manager.js";
import { SessionActor } from "./session-actor.js";
import { detectAgents } from "./detect.js";

export class DeviceDaemon {
  private readonly store: DeviceStore;
  private readonly runtimes: RuntimeManager;
  private readonly actors = new Map<string, SessionActor>();
  private socket?: WebSocket;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private localServer?: Server;
  private stopping = false;

  constructor(private readonly config: DeviceConfig) {
    this.store = new DeviceStore(join(config.dataDir, "device.sqlite"));
    this.runtimes = new RuntimeManager({
      maxWorkers: config.runtime.maxWorkers,
      workerIdleTimeoutSeconds: config.runtime.workerIdleTimeoutSeconds,
      claudeSessionStorePath: join(config.dataDir, "claude-sessions.sqlite"),
      runtimeRoot: join(config.dataDir, "runtimes"),
    });
  }

  async start(): Promise<void> {
    this.startLocalApi();
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.socket?.close();
    await Promise.allSettled([...this.actors.values()].map((actor) => actor.close()));
    await this.runtimes.close();
    if (this.localServer) {
      this.localServer.closeAllConnections();
      await new Promise<void>((resolve) => this.localServer!.close(() => resolve()));
    }
    this.store.close();
  }

  private async connect(): Promise<void> {
    if (this.stopping) return;
    const socket = new WebSocket(this.config.controlServerUrl);
    this.socket = socket;
    socket.on("open", async () => {
      log("info", "Connected to control server", { url: this.config.controlServerUrl });
      const agents = await detectAgents();
      this.send({
        type: "device.register",
        requestId: createId("req"),
        payload: {
          device: {
            id: this.config.device.id,
            name: this.config.device.name,
            platform: process.platform,
            arch: process.arch,
            daemonVersion: "0.1.0",
          },
          agents,
        },
      });
      for (const event of this.store.pendingEvents()) this.send({ type: "agent.event", payload: event });
      this.heartbeatTimer = setInterval(() => {
        this.send({
          type: "device.heartbeat",
          deviceId: this.config.device.id,
          timestamp: new Date().toISOString(),
        });
      }, 15_000);
      this.heartbeatTimer.unref();
    });
    socket.on("message", (data) => void this.handleMessage(String(data)));
    socket.on("error", (error) => log("warn", "Control WebSocket error", { error: error.message }));
    socket.on("close", () => {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      log("warn", "Disconnected from control server");
      if (!this.stopping) {
        this.reconnectTimer = setTimeout(() => void this.connect(), 2_000);
        this.reconnectTimer.unref();
      }
    });
  }

  private async handleMessage(raw: string): Promise<void> {
    let message: ControlToDeviceMessage;
    try {
      message = JSON.parse(raw) as ControlToDeviceMessage;
    } catch {
      return;
    }
    try {
      switch (message.type) {
        case "session.create": {
          const request = createSessionSchema.parse(message.payload) as CreateSessionRequest;
          const actor = await this.createSession(request);
          this.send({
            type: "command.result",
            requestId: message.requestId,
            ok: true,
            payload: { session: actor.session },
          });
          break;
        }
        case "session.command": {
          const actor = this.actors.get(message.sessionId);
          if (!actor) throw new GatewayError("SESSION_NOT_FOUND", `Session ${message.sessionId} is not active`);
          const command = sessionCommandSchema.parse(message.payload) as SessionCommand;
          const result = await actor.dispatch(command);
          this.send({ type: "command.result", requestId: message.requestId, ok: true, payload: result });
          break;
        }
        case "session.history": {
          const actor = this.actors.get(message.sessionId);
          const stored = actor ? undefined : this.store.getSession(message.sessionId);
          if (!actor && !stored) throw new GatewayError("SESSION_NOT_FOUND", `Session ${message.sessionId} is unknown to the device`);
          const history = actor
            ? await actor.getHistory()
            : await this.runtimes.getNativeHistory(stored!);
          this.send({ type: "command.result", requestId: message.requestId, ok: true, payload: history });
          break;
        }
        case "events.ack":
          this.store.acknowledge(message.sessionId, message.throughSequence);
          break;
        case "device.ping":
          this.send({
            type: "device.heartbeat",
            deviceId: this.config.device.id,
            timestamp: new Date().toISOString(),
          });
          break;
      }
    } catch (error) {
      if ("requestId" in message) {
        this.send({
          type: "command.result",
          requestId: message.requestId,
          ok: false,
          error: serializeError(error),
        });
      }
    }
  }

  private async createSession(request: CreateSessionRequest): Promise<SessionActor> {
    const sessionId = request.sessionId ?? createId("ses");
    if (this.actors.has(sessionId)) throw new GatewayError("SESSION_ALREADY_EXISTS", sessionId);
    if (request.workingDirectory && !isAbsolute(request.workingDirectory)) {
      throw new GatewayError("WORKING_DIRECTORY_INVALID", "workingDirectory must be an absolute path");
    }
    const workingDirectory = request.workingDirectory
      ? resolve(request.workingDirectory)
      : join(this.config.dataDir, "sessions", sessionId);
    if (request.workingDirectory) {
      let info;
      try {
        info = await stat(workingDirectory);
      } catch {
        throw new GatewayError("WORKING_DIRECTORY_NOT_FOUND", workingDirectory);
      }
      if (!info.isDirectory()) {
        throw new GatewayError("WORKING_DIRECTORY_NOT_FOUND", `${workingDirectory} is not a directory`);
      }
    } else {
      await mkdir(workingDirectory, { recursive: true });
    }
    const actor = await SessionActor.create(
      this.config.device.id,
      { ...request, sessionId, workingDirectory },
      this.runtimes,
      this.store,
      (event) => this.publish(event),
    );
    this.actors.set(sessionId, actor);
    return actor;
  }

  private publish(event: AgentEvent): void {
    this.send({ type: "agent.event", payload: event });
  }

  private send(message: DeviceToControlMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private startLocalApi(): void {
    const server = createServer((request, response) => this.handleLocalHttp(request, response));
    this.localServer = server;
    server.listen(this.config.localApi.port, this.config.localApi.host, () => {
      log("info", "Device local API listening", this.config.localApi);
    });
  }

  private handleLocalHttp(request: IncomingMessage, response: ServerResponse): void {
    response.setHeader("content-type", "application/json; charset=utf-8");
    if (request.url === "/healthz") {
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (request.url === "/v1/sessions") {
      response.end(JSON.stringify(this.store.listSessions()));
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not_found" }));
  }
}
