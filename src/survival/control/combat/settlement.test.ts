import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../../../test-support/bot.js";
import { encounterBaseline, type FightResponseResult } from "./response-result.js";
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
