import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteClaudeSessionStore } from "../src/providers/claude/sqlite-session-store.js";

test("Claude session store persists ordered transcripts and deduplicates UUIDs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-gateway-claude-store-"));
  const path = join(directory, "sessions.sqlite");
  const key = { projectKey: "project", sessionId: "session" };
  const store = new SqliteClaudeSessionStore(path);
  try {
    await store.append(key, [
      { type: "user", uuid: "u1", value: 1 },
      { type: "assistant", uuid: "u2", value: 2 },
    ]);
    await store.append(key, [
      { type: "assistant", uuid: "u2", value: 2 },
      { type: "system", value: 3 },
    ]);
    assert.deepEqual(await store.load(key), [
      { type: "user", uuid: "u1", value: 1 },
      { type: "assistant", uuid: "u2", value: 2 },
      { type: "system", value: 3 },
    ]);
    assert.deepEqual(await store.loadSessionEntries("session"), [
      { type: "user", uuid: "u1", value: 1 },
      { type: "assistant", uuid: "u2", value: 2 },
      { type: "system", value: 3 },
    ]);
    const sessions = await store.listSessions("project");
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]!.sessionId, "session");
    assert.equal(Number.isInteger(sessions[0]!.mtime), true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
