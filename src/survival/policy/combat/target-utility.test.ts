import assert from "node:assert/strict";
import test from "node:test";
import { compareTargets, type TargetFacts } from "./target-utility.js";

test("answerable contacts precede distant shooters; old hits and loot ground do not buy a longer chase", () => {
  const facts: TargetFacts = { inReach: false, visible: true, hasHitUs: false, safeDropGround: false, distance: 4 };
  assert.ok(compareTargets({ ...facts, inReach: true }, { ...facts, hasHitUs: true }) < 0);
  assert.ok(compareTargets({ ...facts, hasHitUs: true }, { ...facts, safeDropGround: true }) < 0);
  assert.ok(compareTargets({ ...facts, safeDropGround: true, distance: 8 }, facts) > 0);
  assert.ok(compareTargets({ ...facts, hasHitUs: true, distance: 18 }, facts) > 0);
  assert.ok(compareTargets({ ...facts, safeDropGround: true }, facts) < 0);
  assert.ok(compareTargets({ ...facts, visible: false, distance: 1 }, facts) > 0);
});
