import assert from "node:assert/strict";
import test from "node:test";
import { endCombatActionResult } from "./end-combat-result.js";

test("a released but unconfirmed crystal shot is failure, while confirmed destruction succeeds", () => {
  const evidence = { attacks: 1, healthBefore: null, healthAfter: null, reason: null };
  assert.equal(endCombatActionResult({ ...evidence, outcome: "shot_missed" }).status, "failed");
  assert.equal(endCombatActionResult({ ...evidence, outcome: "crystal_destroyed" }).status, "succeeded");
});
