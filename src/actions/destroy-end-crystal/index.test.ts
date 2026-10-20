import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import type { CrystalObservation } from "../../survival/perception/combat/crystal.js";
import { createDestroyEndCrystalAction } from "./index.js";

// The legacy End caller (scenarios/src/ender-dragon.ts) moved on to the next
// tower when a crystal request failed its walk back but its evidence had
// observed the destruction: a failed descent does not resurrect the crystal.
test("a destroyed crystal stays observed when the walk back to the ground fails", async (t) => {
  const crystal = { id: 42, name: "end_crystal", isValid: true, metadata: [], position: new Vec3(30, 80, 0) };
  const bot = botFixture({ position: new Vec3(12.5, 64, 0.5), dimension: "the_end", entities: { 42: crystal } });
  bot._client = new EventEmitter() as Bot["_client"];
  const combat = {
    runEnd: async ({ observation }: { observation: CrystalObservation }) => {
      observation.destroyed = true;
      observation.beginReturn();
      observation.finishReturn(false);
      return {
        outcome: "stopped",
        attacks: 1,
        healthBefore: null,
        healthAfter: null,
        reason: "Crystal destroyed; return route failed: no route down",
      };
    },
  };
  const action = createDestroyEndCrystalAction(bot, combat as never);
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const evidence: { current?: () => { completion: { observed: boolean } } } = {};
  const result = await action.begin(action.parse({ entity_id: 42, weapon: "melee" }), lifetime.signal, (observe) => {
    evidence.current = observe as typeof evidence.current;
  })({});

  assert.equal(result.status, "failed");
  assert.equal(result.combat.outcome, "stopped");
  assert.match(result.combat.reason ?? "", /^Crystal destroyed; return route failed/);
  assert.equal(evidence.current?.().completion.observed, true);
});
