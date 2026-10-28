import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { physicsEveryMillisecond } from "../../test-support/physics.js";
import { TestEndCombat } from "../../test-support/combat.js";
import type { DragonShotObservation } from "../../survival/perception/combat/dragon-shot.js";
import type { FootingRecovery } from "../../survival/responses/footing.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner } from "../../runner/action-runner.js";
import type { CombatController } from "../../survival/combat/contract.js";
import { createShootDragonAction } from "./index.js";

// The shot itself is proven beside EndCombat (survival/combat/end/shoot-dragon.test.ts)
// and the observation beside DragonShotObservation; this file proves only what
// the action adds: one observation carried across a takeover and its resume.
function fixture() {
  let drawing = false, releases = 0;
  const dragon = { id: 42, name: "ender_dragon", isValid: true, position: new Vec3(30, 84, 0),
    velocity: new Vec3(0, 0, 0), yaw: 0, metadata: { 9: 190, 16: 1 } } as unknown as Bot["entity"];
  const bot = botFixture({ dimension: "the_end", groundY: 63, entities: { 42: dragon },
    items: [{ name: "bow", count: 1 }, { name: "arrow", count: 3 }] }, {
    clearControlStates() {}, setQuickBarSlot() { drawing = false; },
    activateItem() { drawing = true; }, deactivateItem() { if (drawing) releases++; drawing = false; },
  });
  const end = new TestEndCombat(bot, {} as NavigationRuntime, { needed: false } as FootingRecovery);
  return { bot, dragon, end, releases: () => releases };
}

test("a released shot survives takeover, reports health loss, and is never fired twice", async () => {
  const f = fixture(), runner = new ActionRunner();
  let first: DragonShotObservation | undefined, attempts = 0;
  using _physics = physicsEveryMillisecond(f.bot);
  const combat = { async runEnd(request, signal) {
    if (request.kind !== "dragon_bow") throw Error("wrong request");
    attempts++;
    if (attempts === 1) {
      first = request.observation;
      first.released(10);
      const cancelled = new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
      assert.equal(runner.claim("hostile", "Incoming hostile", async () => {
        Reflect.set(f.dragon.metadata, 9, 187);
        f.bot.emit("entityUpdate", f.dragon);
        return { value: null, continuation: { kind: "resume" as const } };
      }).kind, "claimed");
      await cancelled;
      signal.throwIfAborted();
    }
    assert.equal(request.observation, first);
    return f.end.shootDragon(signal, request.observation);
  } } as CombatController;
  const result = await runner.run(createShootDragonAction(f.bot, combat), { entity_id: 42 });
  assert.equal(result.result.status, "succeeded");
  assert.equal(first!.attacks, 1);
  assert.equal(first!.damageObserved, 3);
  assert.equal(f.releases(), 0);
  assert.equal(f.bot.listenerCount("entityDead"), 0);
});
