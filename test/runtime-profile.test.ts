import assert from "node:assert/strict";
import test from "node:test";
import { profileFingerprint } from "../src/device/runtime-profile.js";

test("profile fingerprint changes with credentials without exposing them", () => {
  const a = profileFingerprint({
    baseUrl: "https://example.test/v1",
    apiKey: "a",
    model: "m",
  });
  const b = profileFingerprint({
    baseUrl: "https://example.test/v1",
    apiKey: "b",
    model: "m",
  });
  assert.notEqual(a, b);
  assert.equal(a.length, 64);
  assert.equal(b.length, 64);
});
