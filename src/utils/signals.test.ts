import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { armSignal, waitForSignal } from "./signals.js";

test("armSignal: an already true condition or an already delivered cancellation resolves without listening", async () => {
  const emitter = new EventEmitter();
  const stop = new AbortController();
  stop.abort("The hunt yielded during its first drop observation.");
  const cancelled = armSignal(emitter, "update", () => null, { context: { signal: stop.signal } });
  try {
    assert.equal(emitter.listenerCount("update"), 0, "a cancelled scope must not install another wait");
    assert.deepEqual(await cancelled.promise, { kind: "cancelled" });
  } finally {
    cancelled.cancel();
  }

  const ready = armSignal(emitter, "update", () => "ready", { timeoutMs: 1000 });
  assert.deepEqual(await ready.promise, { kind: "signalled", value: "ready" });
  assert.equal(emitter.listenerCount("update"), 0);
});

test("armSignal: resolves on event emission and cleans up listeners", async () => {
  const emitter = new EventEmitter();
  let value = 0;
  const signal = armSignal(emitter, "update", () => (value === 42 ? "found" : null), { timeoutMs: 1000 });
  assert.equal(emitter.listenerCount("update"), 1);

  value = 42;
  emitter.emit("update");
  assert.deepEqual(await signal.promise, { kind: "signalled", value: "found" });
  assert.equal(emitter.listenerCount("update"), 0);
});

/**
 * A signal that gave up and a signal that observed its event are different
 * facts. Reporting both as one value let a lapsed pickup budget be read as a
 * completed pickup, so the distinction is pinned here.
 */
test("armSignal: neither a timeout nor a cancellation is a sighting, and both release the listener", async () => {
  const emitter = new EventEmitter();
  const timed = armSignal(emitter, "update", () => null, { timeoutMs: 20 });
  assert.equal(emitter.listenerCount("update"), 1);
  assert.deepEqual(await timed.promise, { kind: "timeout" });
  assert.equal(emitter.listenerCount("update"), 0);

  const stopped = armSignal(emitter, "update", () => null, { timeoutMs: 1000 });
  assert.equal(emitter.listenerCount("update"), 1);
  stopped.cancel();
  assert.deepEqual(await stopped.promise, { kind: "cancelled" });
  assert.equal(emitter.listenerCount("update"), 0);
});

test("armSignal: an unbounded signal listens until its caller stops it", async () => {
  const emitter = new EventEmitter();
  let ready = false;
  const signal = armSignal(emitter, "update", () => (ready ? "late" : null), {});
  assert.equal(emitter.listenerCount("update"), 1);

  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(emitter.listenerCount("update"), 1, "no deadline may retire an unbounded signal");

  ready = true;
  emitter.emit("update");
  assert.deepEqual(await signal.promise, { kind: "signalled", value: "late" });
  assert.equal(emitter.listenerCount("update"), 0);
});

test("waitForSignal: waits for one of multiple events", async () => {
  const emitter = new EventEmitter();
  let fired = false;
  const waitPromise = waitForSignal(() => (fired ? "done" : null), emitter, ["eventA", "eventB"], { timeoutMs: 1000 });
  assert.equal(emitter.listenerCount("eventA"), 1);
  assert.equal(emitter.listenerCount("eventB"), 1);

  fired = true;
  emitter.emit("eventB");
  const result = await waitPromise;
  assert.equal(result, "done");
  assert.equal(emitter.listenerCount("eventA"), 0);
  assert.equal(emitter.listenerCount("eventB"), 0);
});
