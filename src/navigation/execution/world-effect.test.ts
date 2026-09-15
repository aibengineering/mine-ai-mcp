import assert from "node:assert/strict";
import test from "node:test";
import { FakeNavigationBot, flatWorld } from "../../test-support/navigation.js";
import { airMatcher, stateMatcher } from "../movements/movement.js";
import { ExpectedMutationLedger } from "./mutations.js";
import { executeWorldEffect } from "./world-effect.js";

for (const failure of ["timeout", "conflict"] as const) {
  test(`a world effect stops and drains on ${failure}, without physics ticks`, async () => {
    const world = flatWorld();
    const position = { x: 0, y: 64, z: 0 };
    world.load(position, { stateId: 1 });
    const ledger = new ExpectedMutationLedger();
    const unsubscribe = world.subscribe((change) => ledger.classify(change, new Set(), Date.now()));
    const bot = new FakeNavigationBot();
    let finish!: () => void;
    let cancellations = 0;
    bot.startEffect = () => ({
      issued: true,
      completion: new Promise((resolve) => { finish = () => resolve({ kind: "failed", observation: "stopped" }); }),
      cancel: () => { cancellations++; finish(); },
    });
    try {
      const pending = executeWorldEffect({
        bot, ledger, signal: new AbortController().signal,
        token: { runId: "run", planId: "plan", stepId: "break", attempt: 1 },
        operation: { kind: "break", position, expectedStateId: 1, toolType: null, brings: [] },
        targets: [{ position, before: stateMatcher(1), after: airMatcher }],
        deadlineMs: Date.now() + (failure === "timeout" ? 10 : 1_000),
      });
      if (failure === "conflict") world.load(position, { stateId: 2 });
      const { result } = await pending;
      assert.equal(result.kind, failure === "timeout" ? "expired" : "conflicting");
      assert.equal(cancellations, 1);
      assert.equal(ledger.activeCount, 0);
      assert.equal(bot.ticks.size, 0);
    } finally { unsubscribe(); }
  });
}
