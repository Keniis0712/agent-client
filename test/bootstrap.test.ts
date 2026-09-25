import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createSessionSchema } from "../src/protocol/schemas.js";
import {
  bootstrapFingerprint,
  compileBootstrapInstructions,
  controlContextFingerprint,
  materializeSkillBundles,
} from "../src/device/runtime-bootstrap.js";
import { projectConsoleMcp } from "../src/mcp/runtime-config.js";

const context = {
  consoleBaseUrl: "http://console.internal:8765",
  role: "project" as const,
  orchestratorSessionId: "main-1",
  projectId: "project-1",
  projectRunId: "run-1",
};

test("project control context requires project and run ids", () => {
  assert.throws(() => createSessionSchema.parse({
    deviceId: "device",
    agent: "claude",
    controlContext: {
      consoleBaseUrl: "http://console.internal:8765",
      role: "project",
      orchestratorSessionId: "main-1",
    },
  }));
  const parsed = createSessionSchema.parse({
    deviceId: "device",
    agent: "claude",
    workingDirectory: "D:/project",
    controlContext: context,
  });
  assert.equal(parsed.controlContext?.projectRunId, "run-1");
});

test("session schema only accepts Claude", () => {
  assert.equal(createSessionSchema.parse({
    deviceId: "device",
    agent: "claude",
    workingDirectory: "D:/project",
  }).agent, "claude");
  assert.throws(() => createSessionSchema.parse({
    deviceId: "device",
    agent: "codex",
    workingDirectory: "D:/project",
  }));
});

test("bootstrap bundles are materialized under the runtime overlay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-bootstrap-"));
  try {
    const bootstrap = {
      instructionsVersion: "project-v1",
      instructions: "Own the project.",
      skillBundles: [{
        id: "project-agent",
        version: "1.0.0",
        files: { "SKILL.md": "# Project Agent", "refs/reporting.md": "Report sparingly." },
      }],
    };
    const plugin = await materializeSkillBundles(directory, bootstrap);
    assert.deepEqual(plugin?.skillNames, ["agent-project-console-runtime:project-agent"]);
    assert.match(
      await readFile(join(directory, "claude-plugin", "skills", "project-agent", "SKILL.md"), "utf8"),
      /^---\nname: project-agent\ndescription:/,
    );
    const manifest = JSON.parse(await readFile(
      join(directory, "claude-plugin", ".claude-plugin", "plugin.json"),
      "utf8",
    ));
    assert.equal(manifest.name, "agent-project-console-runtime");
    const instructions = compileBootstrapInstructions(bootstrap, context) ?? "";
    assert.match(instructions, /Role: project/);
    assert.match(instructions, /Own the project/);
    assert.doesNotMatch(instructions, /Report sparingly/);
    assert.notEqual(
      bootstrapFingerprint(bootstrap),
      bootstrapFingerprint({ ...bootstrap, skillBundles: [{ ...bootstrap.skillBundles[0]!, version: "1.0.1" }] }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime MCP bridge is scoped by control context", () => {
  const server = projectConsoleMcp(context);
  assert.ok(server);
  assert.equal(server.env.APC_AGENT_ROLE, "project");
  assert.equal(server.env.APC_PROJECT_RUN_ID, "run-1");
  assert.equal(controlContextFingerprint(context), controlContextFingerprint({ ...context }));
  assert.notEqual(controlContextFingerprint(context), controlContextFingerprint({ ...context, projectRunId: "run-2" }));
});
