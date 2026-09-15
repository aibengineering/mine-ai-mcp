import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { createPrepareDragonPerchAction } from "./index.js";

test("preparation delegates without attacking and publishes current staging readiness", async (t) => {
  const target = { id: 17, isValid: true, metadata: [], position: new Vec3(0, 70, 0) };
  const bot = botFixture({ position: new Vec3(0.5, 61, -2.5), dimension: "the_end", entities: { 17: target } });
  let requestKind: string | null = null;
  const combat = {
    runEnd: async (request: { kind: string; observation: { preparedPosition: Vec3 | null; stage: string } }) => {
      requestKind = request.kind;
      request.observation.preparedPosition = bot.entity.position.clone();
      request.observation.stage = "ready";
      return {
        outcome: "perch_ready",
        attacks: 0,
        healthBefore: null,
        healthAfter: null,
        reason: "Low staging position is ready.",
      };
    },
  };
  const action = createPrepareDragonPerchAction(bot, combat as never);
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const evidence: { current?: () => { checkpoint: unknown; completion: { observed: boolean } } } = {};
  const result = await action.begin(action.parse({ entity_id: 17 }), lifetime.signal, (observe) => {
    evidence.current = observe as typeof evidence.current;
  })({});

  assert.equal(requestKind, "prepare_perch");
  assert.equal(result.status, "succeeded");
  assert.equal(result.combat.outcome, "perch_ready");
  assert.equal(result.combat.attacks, 0);
  assert.deepEqual(evidence.current?.().checkpoint, {
    preparedPosition: { x: 0.5, y: 61, z: -2.5 },
    stage: "ready",
    blockedBy: null,
  });
  assert.equal(evidence.current?.().completion.observed, true);
});
