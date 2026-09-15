import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { waitForPhysicsTicks } from "./physics-ticks.js";

test("physics waits count observed ticks and release their listener", async () => {
  const source = new EventEmitter();
  const waiting = waitForPhysicsTicks(source, 2, new AbortController().signal);
  source.emit("physicsTick");
  assert.equal(source.listenerCount("physicsTick"), 1);
  source.emit("physicsTick");
  await waiting;
  assert.equal(source.listenerCount("physicsTick"), 0);
});

test("cancellation settles a physics wait when no further tick arrives", async () => {
  const source = new EventEmitter();
  const abort = new AbortController();
  const waiting = waitForPhysicsTicks(source, 20, abort.signal);
  abort.abort(new Error("connection ended"));
  await assert.rejects(waiting, /connection ended/);
  assert.equal(source.listenerCount("physicsTick"), 0);
  await assert.rejects(waitForPhysicsTicks(source, 1, abort.signal), /connection ended/);
  assert.equal(source.listenerCount("physicsTick"), 0);
});
