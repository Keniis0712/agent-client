import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DeviceStore } from "../src/device/event-store.js";

test("DeviceStore persists and acknowledges ordered events", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agent-gateway-store-"));
  const store = new DeviceStore(join(directory, "store.sqlite"));
  try {
    for (const sequence of [2, 1, 3]) {
      store.appendEvent({
        eventId: `e${sequence}`,
        sequence,
        timestamp: new Date().toISOString(),
        deviceId: "d1",
        sessionId: "s1",
        sessionRevision: 0,
        type: "test",
        payload: { sequence },
      });
    }
    assert.deepEqual(
      store.pendingEvents("s1").map((event) => event.sequence),
      [1, 2, 3],
    );
    store.acknowledge("s1", 2);
    assert.deepEqual(
      store.pendingEvents("s1").map((event) => event.sequence),
      [3],
    );
    store.recordCommand("idem", "cmd", { ok: true });
    assert.equal(store.hasCommand("idem"), true);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});
