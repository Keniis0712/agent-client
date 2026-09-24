import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  SessionKey,
  SessionStore,
  SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

/** Durable, provider-opaque transcript storage used by the Claude Agent SDK. */
export class SqliteClaudeSessionStore implements SessionStore {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS claude_session_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_key TEXT NOT NULL,
        session_id TEXT NOT NULL,
        subpath TEXT NOT NULL DEFAULT '',
        uuid TEXT,
        entry_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS claude_session_entry_uuid
        ON claude_session_entries(project_key, session_id, subpath, uuid)
        WHERE uuid IS NOT NULL;
      CREATE INDEX IF NOT EXISTS claude_session_lookup
        ON claude_session_entries(project_key, session_id, subpath, id);
    `);
  }

  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const insert = this.database.prepare(`
      INSERT OR IGNORE INTO claude_session_entries
        (project_key, session_id, subpath, uuid, entry_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const now = Date.now();
      for (const entry of entries) {
        insert.run(
          key.projectKey,
          key.sessionId,
          key.subpath ?? "",
          entry.uuid ?? null,
          JSON.stringify(entry),
          now,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    const rows = this.database
      .prepare(`
        SELECT entry_json
        FROM claude_session_entries
        WHERE project_key = ? AND session_id = ? AND subpath = ?
        ORDER BY id
      `)
      .all(key.projectKey, key.sessionId, key.subpath ?? "") as Array<{ entry_json: string }>;
    if (!rows.length) return null;
    return rows.map((row) => JSON.parse(row.entry_json) as SessionStoreEntry);
  }

  async loadSessionEntries(sessionId: string): Promise<SessionStoreEntry[]> {
    const rows = this.database
      .prepare(`
        SELECT entry_json
        FROM claude_session_entries
        WHERE session_id = ? AND subpath = ''
        ORDER BY id
      `)
      .all(sessionId) as Array<{ entry_json: string }>;
    return rows.map((row) => JSON.parse(row.entry_json) as SessionStoreEntry);
  }

  async listSessions(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>> {
    const rows = this.database
      .prepare(`
        SELECT session_id, MAX(created_at) AS mtime
        FROM claude_session_entries
        WHERE project_key = ? AND subpath = ''
        GROUP BY session_id
        ORDER BY mtime DESC
      `)
      .all(projectKey) as Array<{ session_id: string; mtime: number }>;
    return rows.map((row) => ({ sessionId: row.session_id, mtime: row.mtime }));
  }

  async listSubkeys(key: { projectKey: string; sessionId: string }): Promise<string[]> {
    const rows = this.database
      .prepare(`
        SELECT DISTINCT subpath
        FROM claude_session_entries
        WHERE project_key = ? AND session_id = ? AND subpath <> ''
        ORDER BY subpath
      `)
      .all(key.projectKey, key.sessionId) as Array<{ subpath: string }>;
    return rows.map((row) => row.subpath);
  }

  async delete(key: SessionKey): Promise<void> {
    this.database
      .prepare(`
        DELETE FROM claude_session_entries
        WHERE project_key = ? AND session_id = ? AND subpath = ?
      `)
      .run(key.projectKey, key.sessionId, key.subpath ?? "");
  }

  close(): void {
    this.database.close();
  }
}
