import assert from "node:assert/strict";
import test from "node:test";
import { Budgets } from "./budgets.js";

test("replacement routes and oscillating health spend the original attempt budget", () => {
  let time = 0;
  const budgets = new Budgets();
  using evade = budgets.attempt({
    name: "evade",
    scope: "encounter",
    unit: "milliseconds",
    limit: 15_000,
    measure: () => time,
    exhaustion: "budget_exhausted",
  });
  using recovery = budgets.attempt({
    name: "recovery",
    scope: "hold",
    unit: "milliseconds",
    limit: 90_000,
    measure: () => time,
    exhaustion: "recovery_exhausted",
  });
  time = 15_000;
  assert.equal(evade.exhausted, true);
  assert.equal(recovery.remaining, 75_000);
  time = 90_000;
  assert.equal(recovery.exhausted, true);
});

test("incidental defence cannot renew a requested-target progress window", () => {
  let tick = 0;
  const budgets = new Budgets();
  {
    using position = budgets.progress({
      name: "position_wait",
      scope: "target:42:cell:A",
      unit: "ticks",
      limit: 300,
      measure: () => tick,
      exhaustion: "position_unproductive",
      progress: "target_damage:42",
    });
    tick = 290;
    position.observe("shield_raised");
    position.observe("target_damage:9");
    assert.equal(position.remaining, 10);
    position.observe("target_damage:42");
    assert.equal(position.remaining, 300);
    assert.equal(budgets.snapshot()[0]?.scope, "target:42:cell:A");
  }
  assert.deepEqual(budgets.snapshot(), []);
});
