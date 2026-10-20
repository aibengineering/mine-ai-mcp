import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitForClientTicks } from "./client-ticks.ts";

/** Settle pending promise callbacks, so a resolution is observed before the next assertion. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

test("a hold counts the client's own ticks, however slowly they arrive", async () => {
  // Mineflayer's own wait gave a hundred ticks ten seconds and failed a
  // fortress trial at ninety-one: under load the client ran below twenty a
  // second. Only ticks end this wait.
  const client = new EventEmitter();
  let held = false;
  const hold = waitForClientTicks(client, 100, new AbortController().signal).then(() => { held = true; });
  for (let tick = 0; tick < 99; tick++) client.emit("physicsTick");
  await settle();
  assert.equal(held, false);
  client.emit("physicsTick");
  await hold;
  assert.equal(client.listenerCount("physicsTick"), 0);
});

test("cancelling the trial releases a hold whose ticks stopped", async () => {
  const client = new EventEmitter();
  const cancel = new AbortController();
  const hold = waitForClientTicks(client, 100, cancel.signal);
  cancel.abort(new Error("trial stopped"));
  await assert.rejects(hold, /trial stopped/);
  assert.equal(client.listenerCount("physicsTick"), 0);
});
