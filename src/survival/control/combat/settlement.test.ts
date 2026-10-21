import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../../../test-support/bot.js";
import { encounterBaseline, type DeflectResponseResult, type FightResponseResult } from "./response-result.js";
import { completeResponse, responseContinuation } from "./settlement.js";

test("a survived explosion preserves request reassessment after a completed fight", () => {
  const bot = botFixture();
  const physical: FightResponseResult = {
    ...encounterBaseline(bot, { kind: "fight", targetId: 7, threats: [] }, 20),
    response: "fight", result: { kind: "contact_ended" }, killedTargetIds: [7],
    attacks: 1, combatStyles: [], weaponsUsed: [], shieldRaisedSwings: 0, projectileGuards: 0, explosions: 1,
  };
  assert.deepEqual(responseContinuation(completeResponse(physical, new AbortController().signal)), { kind: "resume" });
  assert.equal(responseContinuation(completeResponse({ ...physical, healthAfter: 0 }, new AbortController().signal)).kind, "return");
});

test("a fireball gone without a reversal returns the body to the interrupted request", () => {
  // r3-a 2026-10-21T04-37-31-335Z: the basalt traverse turned to deflect a
  // ghast's fireball, which burst or passed unreversed while the bot stood at
  // full health, and the navigate was ended with a capability limit.
  const bot = botFixture();
  const physical: DeflectResponseResult = {
    ...encounterBaseline(bot, { kind: "deflect", targetId: 99, reason: "incoming_fireball", threats: [] }, 20),
    response: "deflect",
    result: { kind: "unobserved", attacks: 0, observation: "Fireball disappeared or passed without an observed reversal." },
    killedTargetIds: [],
    attacks: 0, combatStyles: [], weaponsUsed: [], shieldRaisedSwings: 0, projectileGuards: 0, explosions: 0,
  };
  assert.deepEqual(responseContinuation(completeResponse(physical, new AbortController().signal)), { kind: "resume" });
});
