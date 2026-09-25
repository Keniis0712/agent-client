import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClaudeHistory } from "../src/providers/history.js";

test("normalizes Claude transcript and hides internal project notifications", () => {
  const history = normalizeClaudeHistory([
    { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
    { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "hi" }, { type: "tool_use", id: "x" }] } },
    { type: "user", uuid: "u2", message: { role: "user", content: "[PROJECT_AGENT_MESSAGE] status" } },
    { type: "system", uuid: "s1", message: { role: "system", content: "ignore" } },
  ]);
  assert.deepEqual(history.messages.map(({ id, role, content, hidden }) => ({ id, role, content, hidden })), [
    { id: "u1", role: "user", content: "hello", hidden: undefined },
    { id: "a1", role: "assistant", content: "hi", hidden: undefined },
    { id: "u2", role: "user", content: "[PROJECT_AGENT_MESSAGE] status", hidden: true },
  ]);
});
