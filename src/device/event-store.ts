import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentEvent, SessionRecord } from "../protocol/types.js";

export class DeviceStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pending_events (
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, sequence)
      );
      CREATE TABLE IF NOT EXISTS command_dedup (
        idempotency_key TEXT PRIMARY KEY,
        command_id TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  saveSession(session: SessionRecord): void {
    this.db
      .prepare(`
        INSERT INTO sessions (id, json, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
      `)
      .run(session.id, JSON.stringify(session), session.updatedAt);
  }

  listSessions(): SessionRecord[] {
    const rows = this.db.prepare("SELECT json FROM sessions ORDER BY updated_at DESC").all() as Array<{
      json: string;
    }>;
    return rows.map((row) => JSON.parse(row.json) as SessionRecord);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db.prepare("SELECT json FROM sessions WHERE id = ?").get(sessionId) as
      | { json: string }
      | undefined;
    return row ? JSON.parse(row.json) as SessionRecord : undefined;
  }

  appendEvent(event: AgentEvent): void {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO pending_events (session_id, sequence, json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(event.sessionId, event.sequence, JSON.stringify(event), event.timestamp);
  }

  pendingEvents(sessionId?: string, afterSequence = 0): AgentEvent[] {
    const rows = sessionId
      ? (this.db
          .prepare(
            "SELECT json FROM pending_events WHERE session_id = ? AND sequence > ? ORDER BY sequence ASC",
          )
          .all(sessionId, afterSequence) as Array<{ json: string }>)
      : (this.db
          .prepare("SELECT json FROM pending_events ORDER BY created_at ASC, sequence ASC")
          .all() as Array<{ json: string }>);
    return rows.map((row) => JSON.parse(row.json) as AgentEvent);
  }

  acknowledge(sessionId: string, throughSequence: number): void {
    this.db
      .prepare("DELETE FROM pending_events WHERE session_id = ? AND sequence <= ?")
      .run(sessionId, throughSequence);
  }

  hasCommand(idempotencyKey: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 AS found FROM command_dedup WHERE idempotency_key = ?")
        .get(idempotencyKey),
    );
  }

  recordCommand(idempotencyKey: string, commandId: string, result?: unknown): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO command_dedup (idempotency_key, command_id, result_json, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(
        idempotencyKey,
        commandId,
        result === undefined ? null : JSON.stringify(result),
        new Date().toISOString(),
      );
  }

  close(): void {
    this.db.close();
  }
}
