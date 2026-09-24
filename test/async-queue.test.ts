import assert from "node:assert/strict";
import test from "node:test";
import { AsyncQueue } from "../src/shared/async-queue.js";

test("AsyncQueue preserves order and closes", async () => {
  const queue = new AsyncQueue<number>();
  queue.push(1);
  queue.push(2);
  queue.close();
  const values: number[] = [];
  for await (const value of queue) values.push(value);
  assert.deepEqual(values, [1, 2]);
});

test("AsyncQueue wakes a pending consumer", async () => {
  const queue = new AsyncQueue<string>();
  const iterator = queue[Symbol.asyncIterator]();
  const pending = iterator.next();
  queue.push("hello");
  assert.deepEqual(await pending, { value: "hello", done: false });
});

