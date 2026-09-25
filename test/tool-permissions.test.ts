import assert from "node:assert/strict";
import test from "node:test";

import { toolPermissionDecision } from "../src/providers/tool-permissions.js";

test("tool permissions support exact and prefix rules while reserving APC access", () => {
  const policy = {
    mode: "prompt" as const,
    allowedTools: ["mcp__agent_project_console__*", "Read"],
    disallowedTools: ["mcp__agent_project_console__delete_*"],
  };
  assert.equal(toolPermissionDecision(policy, "mcp__agent_project_console__list_projects"), "allow");
  assert.equal(toolPermissionDecision(policy, "mcp__agent_project_console__delete_project"), "allow");
  assert.equal(toolPermissionDecision(policy, "Read"), "allow");
  assert.equal(toolPermissionDecision(policy, "Bash"), "prompt");
});

test("full mode allows tools unless explicitly denied", () => {
  assert.equal(toolPermissionDecision({ mode: "full" }, "Bash"), "allow");
  assert.equal(toolPermissionDecision({ mode: "full", disallowedTools: ["Bash"] }, "Bash"), "deny");
});

test("APC control-plane tools are always allowed", () => {
  assert.equal(
    toolPermissionDecision(
      { mode: "prompt", disallowedTools: ["*", "mcp__agent_project_console__report_to_main"] },
      "mcp__agent_project_console__report_to_main",
    ),
    "allow",
  );
});
