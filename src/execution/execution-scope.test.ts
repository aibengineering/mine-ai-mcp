import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutionScope, observeExecution, type ExecutionEvent } from "./execution-scope.js";

/** Every execution event, until the scope that declared it ends. */
function recordExecution() {
  const events: ExecutionEvent[] = [];
  const remove = observeExecution((event) => events.push(event));
  return { events, [Symbol.dispose]: remove };
}

test("resolved-promise decisions yield to timers and become cancellable", async () => {
  using record = recordExecution();
  using execution = new ExecutionScope({ bot: "CheckpointTest", operation: "spin", targetId: null });
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(new Error("operator cancellation")), 5);
  try {
    await assert.rejects(async () => {
      // Finite independent bound makes a broken checkpoint fail this test
      // instead of starving the test runner's own timeout forever.
      const until = performance.now() + 500;
      while (performance.now() < until) await execution.checkpoint(abort.signal);
    }, /operator cancellation/);
    assert.ok(record.events.some((event) => event.kind === "yielded" && event.iterations > 1));
  } finally {
    clearTimeout(timer);
  }
});

test("time awaiting observations is not charged as uninterrupted computation", async () => {
  using record = recordExecution();
  using execution = new ExecutionScope({ bot: "WaitingTest", operation: "guard", targetId: null });
  for (let tick = 0; tick < 4; tick++) {
    await execution.checkpoint();
    await delay(20);
  }
  assert.equal(record.events.filter((event) => event.kind === "yielded").length, 0);
});

test("nested execution transitions are observable even without a physics tick", async () => {
  using record = recordExecution();
  using execution = new ExecutionScope({ bot: "TransitionTest", operation: "combat", targetId: 7 });
  await execution.run("approach", () => execution.run("route", async () => {}, "incoming fire"));
  assert.deepEqual(
    record.events.map(({ kind, phase }) => [kind, phase]),
    [
      ["entered", "approach"],
      ["entered", "route"],
      ["returned", "route"],
      ["returned", "approach"],
    ],
  );
});
