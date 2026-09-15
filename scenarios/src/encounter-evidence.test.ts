import assert from "node:assert/strict";
import test from "node:test";
import { parseEncounterEvidence } from "../flat/combat/reflex.ts";

test("shield preparation is not parsed as a fight, while malformed fights still fail", () => {
  assert.equal(parseEncounterEvidence({ response: "prepare_shield", cancelled: false,
    outcome: { kind: "shield_prepared", equipped: true, error: null }, interrupted: null }), null);
  assert.throws(() => parseEncounterEvidence({ response: "fight", outcome: { kind: "shield_prepared" }, interrupted: null }));
});
