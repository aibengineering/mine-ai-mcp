import assert from "node:assert/strict";
import test from "node:test";
import { decideCombatTactic, type CombatTacticalFacts } from "./tactics.js";

const facts: CombatTacticalFacts = {
  creepers: [], clearancePending: false, retreatPermitted: true, escapeAvailable: true,
  counterTarget: null, counterReady: false, barrier: null, stationaryCommitment: false, footingRecovery: false,
  shield: { available: true, raised: true },
  meleeImminent: false,
  projectile: { imminent: true, aligned: true, coversAll: true, impactInTicks: 2 },
};
test("an active blast outranks a blockable projectile regardless of the selected weapon", () => {
  for (const stationaryCommitment of [false, true]) {
    const decision = decideCombatTactic({ ...facts, stationaryCommitment,
      creepers: [{ id: 7, distance: 3, swelling: true, observed: true, fuseRemainingTicks: 25 }] });
    assert.deepEqual(decision, { kind: "escape", reason: "active_fuse", threatIds: [7] });
  }
  assert.equal(decideCombatTactic({ ...facts, clearancePending: true }).kind, "escape",
    "losing the current entity observation cannot erase an unfinished escape");
  assert.equal(decideCombatTactic({ ...facts, clearancePending: true, retreatPermitted: false }).kind, "brace_blast");
});
test("blocked mixed-fuse escape selects feasible protection without settling a fight", () => {
  const danger = { ...facts, escapeAvailable: false, clearancePending: true,
    creepers: [7, 8].map(id => ({ id, distance: 2, swelling: true, observed: true, fuseRemainingTicks: 25 })) };
  assert.deepEqual(decideCombatTactic({ ...danger, counterTarget: 8, counterReady: true }), { kind: "counter_blast", targetId: 8 });
  const cell = { x: 1, y: 64, z: 0 };
  assert.deepEqual(decideCombatTactic({ ...danger, counterTarget: 8, counterReady: false, barrier: cell }), { kind: "blast_barrier", cell });
  assert.equal(decideCombatTactic(danger).kind, "brace_blast");
  assert.equal(decideCombatTactic({ ...danger, escapeAvailable: true }).kind, "escape");
});

test("a late or unknown fuse preserves shield readiness instead of spending it on a swing or placement", () => {
  for (const fuseRemainingTicks of [undefined, 0, 7]) {
    const danger = { ...facts, escapeAvailable: false, counterTarget: 7, counterReady: true,
      barrier: { x: 1, y: 64, z: 0 },
      creepers: [{ id: 7, distance: 2, swelling: true, observed: true, fuseRemainingTicks }] };
    assert.equal(decideCombatTactic(danger).kind, "brace_blast");
    assert.equal(decideCombatTactic({ ...danger, escapeAvailable: true }).kind, "brace_blast",
      "a last-second sprint also drops shield use");
    assert.equal(decideCombatTactic({ ...danger, shield: { available: false, raised: false } }).kind, "counter_blast",
      "without a shield, keep the available knockback answer");
  }
});
test("a bow yields before fuse activation while an aligned guard can advance between projectiles", () => {
  const creepers = [{ id: 7, distance: 3.9, swelling: false, observed: true }];
  assert.equal(decideCombatTactic({ ...facts, creepers, stationaryCommitment: true }).kind, "escape");
  assert.equal(decideCombatTactic({ ...facts, projectile: { ...facts.projectile!, imminent: false } }).kind, "act");
  assert.equal(decideCombatTactic({ ...facts, creepers, footingRecovery: true }).kind, "recover_footing");
});
