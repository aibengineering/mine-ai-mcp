import { exactBlockGoal } from "./goals/index.js";
import { createMovementPolicy } from "./movements/policy.js";
import { createNavigationRuntime } from "./runtime.js";
import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../test-support/bot.js";

test("builds and closes one navigation runtime for a bot", async () => {
  const bot = botFixture();
  const physicsListeners = bot.listenerCount("physicsTick");

  const navigation = createNavigationRuntime(bot);
  assert.equal(navigation.active, false);
  assert.equal(bot.listenerCount("death"), 1);
  assert.equal(bot.listenerCount("end"), 1);
  assert.equal(bot.listenerCount("physicsTick"), physicsListeners + 1);

  await navigation.close();
  assert.equal(bot.listenerCount("death"), 0);
  assert.equal(bot.listenerCount("end"), 0);
  assert.equal(bot.listenerCount("physicsTick"), physicsListeners);
  // A closed runtime is spent: there is no registry to look a live one up in.
  await assert.rejects(navigation.navigate({} as never), /closed/);
});

test("navigation uses observed perched-cloud clearance", async () => {
  const bot = botFixture();
  bot.entity.position.set(-2.5, 62, 1.5);
  bot.entity.velocity = bot.entity.position.scaled(0);
  bot.world.getBlockStateId = (p) => (p.y < 62 ? bot.registry.blocksByName.end_stone.defaultState : 0);
  Object.assign(bot.world, {
    getColumn: () => ({ minY: -64, worldHeight: 384, getBlockStateId: bot.world.getBlockStateId }),
  });
  const metadata: unknown[] = [];
  const keys = bot.registry.entitiesByName.area_effect_cloud.metadataKeys;
  assert.ok(keys);
  metadata[keys.indexOf("particle")] = { type: "dragon_breath" };
  metadata[keys.indexOf("radius")] = 5;
  bot.entities[564] = {
    id: 564,
    name: "area_effect_cloud",
    isValid: true,
    position: bot.entity.position.clone().set(-0.8084108410180761, 63, 8.551320364546644),
    metadata,
  } as typeof bot.entity;
  const navigation = createNavigationRuntime(bot);
  const stop = new AbortController();
  let plans = 0;
  navigation.onEvent((event) => {
    if (event.kind === "route_committed") {
      plans++;
      stop.abort("Route observed; execution is covered by the native scenario");
    }
  });
  try {
    await navigation.navigate({
      movements: createMovementPolicy({ allowDigging: false, allowParkour: false }),
      goal: exactBlockGoal({ x: -3, y: 62, z: 3 }),
      stopSignal: stop.signal,
    });
    assert.equal(plans, 1, "The goal is outside the native radius and has an unobstructed approach");
  } finally {
    await navigation.close();
  }
});
