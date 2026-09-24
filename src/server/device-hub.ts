import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
  AgentEvent,
  ControlToDeviceMessage,
  DeviceRegistration,
  DeviceToControlMessage,
} from "../protocol/types.js";
import { GatewayError } from "../shared/errors.js";
import { createId } from "../shared/ids.js";
import { log } from "../shared/log.js";
import { ControlStore } from "./store.js";

interface DeviceConnection {
  id: string;
  socket: WebSocket;
  registration: DeviceRegistration;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

export class DeviceHub extends EventEmitter {
  private readonly devices = new Map<string, DeviceConnection>();
  private readonly pending = new Map<string, PendingRequest>();

  constructor(private readonly store: ControlStore) {
    super();
  }

  attach(socket: WebSocket): void {
    let deviceId: string | undefined;
    socket.on("message", (data) => {
      let message: DeviceToControlMessage;
      try {
        message = JSON.parse(String(data)) as DeviceToControlMessage;
      } catch {
        return;
      }
      if (message.type === "device.register") {
        deviceId = message.payload.device.id;
        this.devices.set(deviceId, { id: deviceId, socket, registration: message.payload });
        this.store.upsertDevice(message.payload);
        log("info", "Device registered", { deviceId });
        this.emit("device", message.payload);
        return;
      }
      if (message.type === "device.heartbeat") {
        this.store.touchDevice(message.deviceId);
        return;
      }
      if (message.type === "agent.event") {
        this.store.appendEvent(message.payload);
        this.sendToDevice(message.payload.deviceId, {
          type: "events.ack",
          sessionId: message.payload.sessionId,
          throughSequence: message.payload.sequence,
        });
        this.emit("event", message.payload);
        return;
      }
      if (message.type === "command.result") {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.payload);
        else pending.reject(new GatewayError(message.error?.code ?? "DEVICE_ERROR", message.error?.message ?? "Device command failed", message.error?.retryable, message.error?.details));
      }
    });
    socket.on("close", () => {
      if (!deviceId) return;
      if (this.devices.get(deviceId)?.socket === socket) this.devices.delete(deviceId);
      this.store.markDeviceOffline(deviceId);
      this.emit("device.offline", deviceId);
    });
  }

  isOnline(deviceId: string): boolean {
    return this.devices.get(deviceId)?.socket.readyState === WebSocket.OPEN;
  }

  sendRequest(
    deviceId: string,
    message:
      | Omit<Extract<ControlToDeviceMessage, { type: "session.create" }>, "requestId">
      | Omit<Extract<ControlToDeviceMessage, { type: "session.command" }>, "requestId">
      | Omit<Extract<ControlToDeviceMessage, { type: "session.history" }>, "requestId">,
    timeoutMs = 120_000,
  ): Promise<unknown> {
    const requestId = createId("req");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new GatewayError("DEVICE_TIMEOUT", `Device ${deviceId} did not respond`, true));
      }, timeoutMs);
      timer.unref();
      this.pending.set(requestId, { resolve, reject, timer });
      try {
        this.sendToDevice(deviceId, { ...message, requestId } as ControlToDeviceMessage);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private sendToDevice(deviceId: string, message: ControlToDeviceMessage): void {
    const device = this.devices.get(deviceId);
    if (!device || device.socket.readyState !== WebSocket.OPEN) {
      throw new GatewayError("DEVICE_OFFLINE", `Device ${deviceId} is offline`, true);
    }
    device.socket.send(JSON.stringify(message));
  }
}
