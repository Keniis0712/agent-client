import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { GatewayError } from "../../shared/errors.js";
import { log } from "../../shared/log.js";

interface RpcResponse {
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface RpcRequest {
  id: string | number;
  method: string;
  params?: any;
}

export interface RpcNotification {
  method: string;
  params?: any;
}

export class JsonRpcPeer extends EventEmitter {
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (reason: unknown) => void; timer: NodeJS.Timeout }
  >();

  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    super();
    const lines = createInterface({ input: process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    process.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) log("debug", "codex app-server stderr", { text });
    });
    process.once("exit", (code, signal) => this.handleExit(code, signal));
    process.once("error", (error) => this.handleExit(null, null, error));
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "agent-gateway-device", title: "Agent Gateway Device", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    this.notify("initialized", {});
  }

  request<T = any>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new GatewayError("PROVIDER_PROCESS_EXITED", "App Server is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayError("PROVIDER_PROTOCOL_ERROR", `RPC ${method} timed out`, true));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.write({ method, id, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) });
  }

  respond(id: string | number, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: string | number, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  private write(message: unknown): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let message: any;
    try {
      message = JSON.parse(line);
    } catch (error) {
      log("warn", "Ignoring invalid App Server JSON", { line, error: String(error) });
      return;
    }

    if (message.id !== undefined && ("result" in message || "error" in message) && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      const response = message as RpcResponse;
      if (response.error) {
        pending.reject(
          new GatewayError("PROVIDER_PROTOCOL_ERROR", response.error.message, false, response.error),
        );
      } else {
        pending.resolve(response.result);
      }
      return;
    }

    if (message.id !== undefined && message.method) this.emit("request", message as RpcRequest);
    else if (message.method) this.emit("notification", message as RpcNotification);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const cause = new GatewayError(
      "PROVIDER_PROCESS_EXITED",
      error?.message ?? `App Server exited (code=${String(code)}, signal=${String(signal)})`,
      true,
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
    }
    this.pending.clear();
    this.emit("exit", cause);
  }
}

