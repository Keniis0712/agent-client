import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { materializeCodexProfile, profileFingerprint } from "../src/device/runtime-profile.js";

test("materialized Codex profile references an environment key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-gateway-profile-"));
  try {
    const profile = {
      baseUrl: "https://example.test/v1/",
      apiKey: "top-secret",
      model: "test-model",
      protocol: "responses" as const,
      reasoningEffort: "high" as const,
    };
    const materialized = await materializeCodexProfile(directory, profile);
    const contents = await readFile(materialized.profilePath, "utf8");
    assert.match(contents, /model_provider = "gateway_runtime"/);
    assert.match(contents, /wire_api = "responses"/);
    assert.match(contents, /base_url = "https:\/\/example\.test\/v1"/);
    assert.doesNotMatch(contents, /top-secret/);
    assert.equal(materialized.env.AGENT_RUNTIME_API_KEY, "top-secret");
    await materialized.cleanup();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("profile fingerprint changes with credentials without exposing them", () => {
  const a = profileFingerprint("codex", {
    baseUrl: "https://example.test/v1",
    apiKey: "a",
    model: "m",
  });
  const b = profileFingerprint("codex", {
    baseUrl: "https://example.test/v1",
    apiKey: "b",
    model: "m",
  });
  assert.notEqual(a, b);
  assert.equal(a.length, 64);
  assert.equal(b.length, 64);
});
