import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_COMBAT_POLICY } from "./contract.js";
import { combatDecisionEvidence, decideCombatResponse, type CombatDecisionFacts } from "./decision.js";
import { decideFightBoundary } from "./fight-boundary.js";
import { replayCombatDecision } from "./replay.js";

function facts(): CombatDecisionFacts {
  return {
    policy: DEFAULT_COMBAT_POLICY,
    health: 11,
    burning: false,
    hideAllowed: true,
    recoveryAvailable: true,
    weapon: true,
    rangedWeapon: false,
    shield: true,
    contacts: [],
    fireball: null,
    unreachable: new Set(),
    answeredFights: new Map(),
    answered: new Set(),
  };
}
const purpose = { kind: "pursuit", targetId: 7, minimumHealth: 12 } as const;
const refuge = { returnable: true, atProtection: false, foodLow: false, foodAvailable: false };

test("the shared boundary recovers through the current refuge without reconstructing it", () => {
  assert.deepEqual(decideFightBoundary(facts(), purpose, refuge), { kind: "recover", health: 18 });
  const outside = decideFightBoundary(facts(), purpose, { ...refuge, returnable: false });
  assert.equal(outside.kind, "respond");
  if (outside.kind === "respond") assert.equal(outside.response.kind, "hide");
  assert.equal(decideFightBoundary({ ...facts(), answered: new Set(["recovery"]) }, purpose, refuge).kind, "respond");
});

test("policy health changes affect both pursuit admission and recovery inside cover", () => {
  const changed = { ...facts(), policy: { ...DEFAULT_COMBAT_POLICY, engage_min_health: 8, recover_to_health: 16 } };
  assert.equal(decideFightBoundary(changed, { ...purpose, minimumHealth: 8 }, refuge).kind, "fight");
  assert.deepEqual(decideFightBoundary({ ...changed, health: 7 }, { ...purpose, minimumHealth: 8 }, refuge), {
    kind: "recover",
    health: 16,
  });
  assert.deepEqual(decideFightBoundary({ ...changed, health: 7 }, { ...purpose, minimumHealth: 19 }, refuge), {
    kind: "recover",
    health: 19,
  });
});

test("combat and protected recovery decisions replay from serialized inputs after live facts change", () => {
  let observed = facts();
  const selected = decideCombatResponse(observed, purpose);
  const receipt = combatDecisionEvidence(observed, purpose, selected);
  const saved = JSON.parse(JSON.stringify(receipt));
  assert.deepEqual(replayCombatDecision(saved), selected);
  const boundary = JSON.parse(JSON.stringify({ boundary: "fight", protection: refuge, selection: receipt }));
  observed = { ...observed, policy: { ...DEFAULT_COMBAT_POLICY, recover: "never" } };
  assert.deepEqual(replayCombatDecision(boundary), { kind: "recover", health: 18 });
  assert.notDeepEqual(decideFightBoundary(observed, purpose, refuge), replayCombatDecision(boundary));
});

test("recorded ownership gates replay the handled response without a live controller", () => {
  const observed = facts();
  const receipt = {
    selection: combatDecisionEvidence(observed, purpose, decideCombatResponse(observed, purpose)),
    settling: false,
    combatOwnsBody: true,
    entries: [],
  };
  assert.deepEqual(replayCombatDecision(JSON.parse(JSON.stringify(receipt))), { kind: "handled", by: "combat" });
});
