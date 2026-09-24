import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AgentEvent,
  DeviceRegistration,
  NativeGoal,
  SessionRecord,
} from "../protocol/types.js";

export class ControlStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        status TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS goals (
        session_id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    // A process restart drops every live WebSocket. Persisted registrations
    // remain useful for inventory, but none is online until it reconnects.
    this.db.prepare("UPDATE devices SET status='offline'").run();
  }

  upsertDevice(registration: DeviceRegistration, status = "online"): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`
        INSERT INTO devices (id, json, status, last_seen_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json=excluded.json, status=excluded.status,
          last_seen_at=excluded.last_seen_at
      `)
      .run(registration.device.id, JSON.stringify(registration), status, now);
  }

  touchDevice(deviceId: string): void {
    this.db
      .prepare("UPDATE devices SET status='online', last_seen_at=? WHERE id=?")
      .run(new Date().toISOString(), deviceId);
  }

  markDeviceOffline(deviceId: string): void {
    this.db.prepare("UPDATE devices SET status='offline' WHERE id=?").run(deviceId);
  }

  listDevices(): unknown[] {
    const rows = this.db
      .prepare("SELECT json, status, last_seen_at FROM devices ORDER BY last_seen_at DESC")
      .all() as Array<{ json: string; status: string; last_seen_at: string }>;
    return rows.map((row) => ({
      ...(JSON.parse(row.json) as object),
      status: row.status,
      lastSeenAt: row.last_seen_at,
    }));
  }

  getDevice(deviceId: string): unknown | undefined {
    const row = this.db
      .prepare("SELECT json, status, last_seen_at FROM devices WHERE id=?")
      .get(deviceId) as { json: string; status: string; last_seen_at: string } | undefined;
    return row
      ? { ...(JSON.parse(row.json) as object), status: row.status, lastSeenAt: row.last_seen_at }
      : undefined;
  }

  upsertSession(session: SessionRecord): void {
    this.db
      .prepare(`
        INSERT INTO sessions (id, device_id, json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET device_id=excluded.device_id, json=excluded.json,
          updated_at=excluded.updated_at
      `)
      .run(session.id, session.deviceId, JSON.stringify(session), session.updatedAt);
  }

  patchSession(sessionId: string, patch: Record<string, unknown>): void {
    const current = this.getSession(sessionId);
    if (!current) return;
    this.upsertSession({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    } as SessionRecord);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT json FROM sessions WHERE id=?").get(sessionId) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as SessionRecord) : undefined;
  }

  listSessions(): SessionRecord[] {
    const rows = this.db.prepare("SELECT json FROM sessions ORDER BY updated_at DESC").all() as Array<{
      json: string;
    }>;
    return rows.map((row) => JSON.parse(row.json) as SessionRecord);
  }

  appendEvent(event: AgentEvent): void {
    this.db
      .prepare("INSERT OR IGNORE INTO events (session_id, sequence, json, created_at) VALUES (?, ?, ?, ?)")
      .run(event.sessionId, event.sequence, JSON.stringify(event), event.timestamp);
    const payload = event.payload as any;
    if (event.type === "session.started" && payload.session) this.upsertSession(payload.session);
    if (event.type === "session.started" && !payload.session && event.nativeThreadId) {
      this.patchSession(event.sessionId, {
        nativeSessionId: event.nativeThreadId,
        nativeThreadId: event.nativeThreadId,
        ...(payload.model ? { effectiveModel: payload.model } : {}),
      });
    }
    if (event.type === "session.status.changed") this.patchSession(event.sessionId, payload);
    if (event.type === "turn.started") {
      this.patchSession(event.sessionId, {
        status: "running",
        activeTurnId: event.nativeTurnId ?? payload.turn?.id,
      });
    }
    if (event.type === "turn.completed") {
      this.patchSession(event.sessionId, { status: "idle", activeTurnId: undefined });
    }
    if (event.type === "model.changed") {
      this.patchSession(event.sessionId, { effectiveModel: payload.model });
    }
    if (event.type === "profile.changed") {
      this.patchSession(event.sessionId, {
        status: "idle",
        runtimeId: payload.runtimeId,
        profileFingerprint: payload.profileFingerprint,
        nativeSessionId: payload.nativeSessionId,
        nativeThreadId: payload.nativeThreadId,
        effectiveModel: payload.model,
        effectiveModelProvider: payload.modelProvider,
      });
    }
    if (event.type === "goal.updated") {
      const goal = (payload.goal ?? payload) as NativeGoal;
      this.db
        .prepare(`
          INSERT INTO goals (session_id, json, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET json=excluded.json, updated_at=excluded.updated_at
        `)
        .run(event.sessionId, JSON.stringify(goal), event.timestamp);
    }
    if (event.type === "goal.cleared") this.db.prepare("DELETE FROM goals WHERE session_id=?").run(event.sessionId);
    const current = this.getSession(event.sessionId);
    if (current && (event.sequence > current.lastSequence || event.sessionRevision > current.revision)) {
      this.patchSession(event.sessionId, {
        lastSequence: Math.max(current.lastSequence, event.sequence),
        revision: Math.max(current.revision, event.sessionRevision),
      });
    }
  }

  listEvents(sessionId: string, afterSequence = 0): AgentEvent[] {
    const rows = this.db
      .prepare("SELECT json FROM events WHERE session_id=? AND sequence>? ORDER BY sequence ASC")
      .all(sessionId, afterSequence) as Array<{ json: string }>;
    return rows.map((row) => JSON.parse(row.json) as AgentEvent);
  }

  getGoal(sessionId: string): NativeGoal | null {
    const row = this.db.prepare("SELECT json FROM goals WHERE session_id=?").get(sessionId) as
      | { json: string }
      | undefined;
    return row ? (JSON.parse(row.json) as NativeGoal) : null;
  }
}
