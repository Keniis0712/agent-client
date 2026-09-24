import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { AgentEvent, CreateSessionRequest, SessionCommand, SessionRecord } from "../protocol/types.js";
import { createSessionSchema, sessionCommandSchema } from "../protocol/schemas.js";
import { createId } from "../shared/ids.js";
import { serializeError, GatewayError } from "../shared/errors.js";
import { log } from "../shared/log.js";
import { ControlStore } from "./store.js";
import { DeviceHub } from "./device-hub.js";
import { webUi } from "./web-ui.js";

export interface ControlServerOptions {
  host: string;
  port: number;
  dataDir: string;
}

export class ControlServer {
  private readonly store: ControlStore;
  private readonly hub: DeviceHub;
  private readonly terminalClients = new Set<WebSocket>();
  private readonly subscriptions = new WeakMap<WebSocket, Set<string>>();

  constructor(private readonly options: ControlServerOptions) {
    this.store = new ControlStore(join(options.dataDir, "control.sqlite"));
    this.hub = new DeviceHub(this.store);
    this.hub.on("event", (event: AgentEvent) => this.broadcastEvent(event));
  }

  start(): void {
    const server = createServer((request, response) => void this.handleHttp(request, response));
    const deviceWs = new WebSocketServer({ noServer: true });
    const terminalWs = new WebSocketServer({ noServer: true });
    deviceWs.on("connection", (socket) => this.hub.attach(socket));
    terminalWs.on("connection", (socket) => this.attachTerminal(socket));
    server.on("upgrade", (request, socket, head) => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (path === "/v1/device/connect") {
        deviceWs.handleUpgrade(request, socket, head, (ws) => deviceWs.emit("connection", ws, request));
      } else if (path === "/v1/terminal") {
        terminalWs.handleUpgrade(request, socket, head, (ws) => terminalWs.emit("connection", ws, request));
      } else socket.destroy();
    });
    server.listen(this.options.port, this.options.host, () => {
      log("info", "Control server listening", { host: this.options.host, port: this.options.port });
    });
  }

  private attachTerminal(socket: WebSocket): void {
    this.terminalClients.add(socket);
    this.subscriptions.set(socket, new Set());
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(String(data));
        if (message.type === "subscribe" && typeof message.sessionId === "string") {
          this.subscriptions.get(socket)?.add(message.sessionId);
        }
        if (message.type === "unsubscribe" && typeof message.sessionId === "string") {
          this.subscriptions.get(socket)?.delete(message.sessionId);
        }
      } catch {}
    });
    socket.on("close", () => this.terminalClients.delete(socket));
  }

  private broadcastEvent(event: AgentEvent): void {
    const data = JSON.stringify({ type: "agent.event", payload: event });
    for (const socket of this.terminalClients) {
      const subscriptions = this.subscriptions.get(socket);
      if (
        socket.readyState === WebSocket.OPEN &&
        (!subscriptions?.size || subscriptions.has(event.sessionId))
      ) {
        socket.send(data);
      }
    }
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "GET" && url.pathname === "/") {
        response.statusCode = 200;
        response.setHeader("content-type", "text/html; charset=utf-8");
        response.end(webUi);
        return;
      }
      if (request.method === "GET" && url.pathname === "/healthz") return this.json(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/v1/devices") return this.json(response, 200, this.store.listDevices());
      if (request.method === "GET" && url.pathname === "/v1/sessions") return this.json(response, 200, this.store.listSessions());
      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const parsed = createSessionSchema.parse(await this.body(request));
        const payload: CreateSessionRequest = { ...parsed, sessionId: parsed.sessionId ?? createId("ses") };
        if (!this.hub.isOnline(payload.deviceId)) throw new GatewayError("DEVICE_OFFLINE", payload.deviceId, true);
        const now = new Date().toISOString();
        const initial: SessionRecord = {
          id: payload.sessionId!,
          deviceId: payload.deviceId,
          agent: payload.agent,
          workspaceId: payload.workspaceId,
          status: "starting",
          revision: 0,
          lastSequence: 0,
          createdAt: now,
          updatedAt: now,
        };
        this.store.upsertSession(initial);
        void this.hub
          .sendRequest(payload.deviceId, { type: "session.create", payload })
          .catch((error) => this.store.patchSession(payload.sessionId!, { status: "failed", error: serializeError(error) }));
        return this.json(response, 202, { sessionId: payload.sessionId, status: "starting" });
      }

      const commandMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/commands$/);
      if (request.method === "POST" && commandMatch) {
        const sessionId = decodeURIComponent(commandMatch[1]!);
        const session = this.requiredSession(sessionId);
        const command = sessionCommandSchema.parse(await this.body(request)) as SessionCommand;
        void this.hub.sendRequest(session.deviceId, {
          type: "session.command",
          sessionId,
          payload: command,
        }).catch((error) => log("error", "Session command failed", {
          sessionId,
          commandId: command.commandId,
          error: serializeError(error),
        }));
        return this.json(response, 202, { accepted: true, commandId: command.commandId });
      }

      const eventsMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/);
      if (request.method === "GET" && eventsMatch) {
        const sessionId = decodeURIComponent(eventsMatch[1]!);
        const after = Number(url.searchParams.get("afterSequence") ?? 0);
        return this.json(response, 200, this.store.listEvents(sessionId, Number.isFinite(after) ? after : 0));
      }

      const historyMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/history$/);
      if (request.method === "GET" && historyMatch) {
        const sessionId = decodeURIComponent(historyMatch[1]!);
        const session = this.requiredSession(sessionId);
        const history = await this.hub.sendRequest(session.deviceId, {
          type: "session.history",
          sessionId,
        });
        return this.json(response, 200, history);
      }

      const goalMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goal$/);
      if (goalMatch) {
        const sessionId = decodeURIComponent(goalMatch[1]!);
        if (request.method === "GET") return this.json(response, 200, this.store.getGoal(sessionId));
        const session = this.requiredSession(sessionId);
        const type = request.method === "DELETE" ? "goal.clear" : "goal.set";
        if (request.method === "DELETE" || request.method === "PUT") {
          const payload = request.method === "PUT" ? await this.body(request) : {};
          const command: SessionCommand = {
            commandId: createId("cmd"),
            idempotencyKey: createId("idem"),
            type,
            payload,
          };
          void this.hub.sendRequest(session.deviceId, {
            type: "session.command",
            sessionId,
            payload: command,
          }).catch((error) => log("error", "Goal command failed", {
            sessionId,
            commandId: command.commandId,
            error: serializeError(error),
          }));
          return this.json(response, 202, { accepted: true, commandId: command.commandId });
        }
      }

      const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (request.method === "GET" && sessionMatch) {
        return this.json(response, 200, this.requiredSession(decodeURIComponent(sessionMatch[1]!)));
      }
      this.json(response, 404, { error: { code: "NOT_FOUND", message: "Route not found" } });
    } catch (error) {
      const serialized = serializeError(error);
      const status = serialized.code === "SESSION_NOT_FOUND" ? 404 : serialized.code === "INTERNAL_ERROR" ? 500 : 400;
      this.json(response, status, { error: serialized });
    }
  }

  private requiredSession(sessionId: string): SessionRecord {
    const session = this.store.getSession(sessionId);
    if (!session) throw new GatewayError("SESSION_NOT_FOUND", sessionId);
    return session;
  }

  private body(request: IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let length = 0;
      request.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) {
          reject(new GatewayError("BODY_TOO_LARGE", "Request body exceeds 2 MiB"));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
        } catch {
          reject(new GatewayError("INVALID_JSON", "Request body is not valid JSON"));
        }
      });
      request.on("error", reject);
    });
  }

  private json(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(JSON.stringify(value));
  }
}
