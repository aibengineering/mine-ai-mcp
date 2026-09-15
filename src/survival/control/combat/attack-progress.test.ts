import assert from "node:assert/strict";
import test from "node:test";
import { Budgets } from "../../state/budgets.js";
import { ProtectedAttackProgress } from "./attack-progress.js";

test("temporary exposure and alternating refuges cannot reopen a spent position wait", () => {
  const budgets = new Budgets();
  using progress = new ProtectedAttackProgress(budgets, 7, 300);
  for (let visit = 0; visit < 3; visit++) {
    const window = progress.enter("A");
    for (let tick = 0; tick < 100; tick++) progress.tick(false);
    assert.equal(window.remaining, 200 - visit * 100);
    progress.leave();
    assert.equal(budgets.snapshot().length, 0);
    progress.enter("B");
    progress.tick(false);
  }
  assert.equal(progress.enter("A").exhausted, true);
  assert.equal(progress.enter("B").remaining, 297);
});

test("recovery pauses spending and only confirmed quarry damage renews its position", () => {
  const budgets = new Budgets();
  using progress = new ProtectedAttackProgress(budgets, 7, 300);
  const window = progress.enter("A");
  for (let tick = 0; tick < 100; tick++) progress.tick(false);
  for (let tick = 0; tick < 1000; tick++) progress.tick(true);
  assert.equal(window.remaining, 200);
  progress.confirmedTargetDamage();
  assert.equal(window.remaining, 300);
  progress.tick(false);
  progress.leave();
  assert.equal(progress.enter("A").remaining, 299);
});
