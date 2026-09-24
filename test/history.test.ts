import assert from "node:assert/strict";
import test from "node:test";
import type { Thread } from "../generated/codex/v2/Thread.js";
import { normalizeClaudeHistory, normalizeCodexHistory, normalizeCodexRollout } from "../src/providers/history.js";

test("normalizes Codex native thread messages", () => {
  const thread = {
    turns: [{
      id: "turn-1",
      startedAt: 1_700_000_000,
      items: [
        { type: "userMessage", id: "u1", clientId: null, content: [{ type: "text", text: "hello", text_elements: [] }] },
        { type: "reasoning", id: "r1", summary: [], content: ["private"] },
        { type: "agentMessage", id: "a1", text: "hi", phase: "final_answer", memoryCitation: null, delivery: null, questions: null },
      ],
    }],
  } as unknown as Thread;
  const history = normalizeCodexHistory(thread);
  assert.equal(history.source, "native");
  assert.deepEqual(history.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ]);
  assert.equal(history.messages[0]!.nativeTurnId, "turn-1");
});

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

test("normalizes Codex native rollout fallback", () => {
  const history = normalizeCodexRollout([
    JSON.stringify({ timestamp: "2026-09-23T08:00:00Z", ordinal: 1, type: "event_msg", payload: { type: "task_started", turn_id: "t1" } }),
    JSON.stringify({ timestamp: "2026-09-23T08:00:01Z", ordinal: 2, type: "response_item", payload: { type: "message", id: "injected", role: "user", content: [{ type: "input_text", text: "<environment_context>hidden</environment_context>" }] } }),
    JSON.stringify({ timestamp: "2026-09-23T08:00:02Z", ordinal: 3, type: "response_item", payload: { type: "message", id: "u1", role: "user", content: [{ type: "input_text", text: "hello" }] } }),
    "not-json",
    JSON.stringify({ timestamp: "2026-09-23T08:00:03Z", ordinal: 4, type: "response_item", payload: { type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "hi" }] } }),
  ].join("\n"));
  assert.equal(history.messages.length, 3);
  assert.equal(history.messages[0]!.hidden, true);
  assert.deepEqual(history.messages.slice(1).map(({ role, content, nativeTurnId }) => ({ role, content, nativeTurnId })), [
    { role: "user", content: "hello", nativeTurnId: "t1" },
    { role: "assistant", content: "hi", nativeTurnId: "t1" },
  ]);
});
