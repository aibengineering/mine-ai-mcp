import { exactBlockGoal } from "./goals/index.js";
import { createMovementPolicy } from "./movements/policy.js";
import { avoidingObservedBreath, createMovements, createNavigationRuntime } from "./runtime.js";
import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../test-support/bot.js";
import { flatWorld } from "../test-support/navigation.js";

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

/**
 * Staircase fight of 22 October (run 2026-10-22T01-41-26-600Z-t00001): a
 * fireball's breath lay on the tread at y 79.92 above the climb. Standing on
 * -46,78,1 the head stops 0.12 below it, so the step was admitted, but the
 * step-up from -46,77,2 lifts the head into it. The route jumped through it
 * three times, six damage each, and the bot died. These are the recorded
 * cloud (its fireball footprint reserved at radius seven) and steps.
 */
test("a step-up whose jump rises into breath above its landing is refused", () => {
  const cloud = { id: 123, x: -45.49348371844987, y: 79.92159999847412, z: 0.40520858723854586, radius: 7 };
  const movements = avoidingObservedBreath(createMovementPolicy(), [cloud], { x: -45.5, y: 76, z: 3.5 });
  const world = flatWorld();
  assert.equal(movements.decideStep(-46, 78, 1, world).kind, "allowed", "standing there, the head stays below the cloud");
  assert.equal(movements.decideStep(-46, 79, 1, world).kind, "prohibited");
  assert.equal(movements.decideMovement?.("step_up", { x: -46, y: 77, z: 2 }, { x: -46, y: 78, z: 1 }).kind, "prohibited");
  assert.equal(movements.decideMovement?.("walk", { x: -46, y: 77, z: 2 }, { x: -46, y: 77, z: 1 }).kind ?? "allowed", "allowed");
  assert.equal(movements.decideMovement?.("step_up", { x: -46, y: 76, z: 3 }, { x: -46, y: 77, z: 2 }).kind, "allowed",
    "a block lower, the jump's head stays below the cloud");
  assert.equal(movements.decideMovement?.("step_up", { x: -36, y: 77, z: 10 }, { x: -36, y: 78, z: 11 }).kind, "allowed",
    "beyond the radius a jump is free");
});

/**
 * pathfinder/flowing-lava-course, Spreader (bisect-df85fa5-b,
 * 2026-10-22T07-34-51-145Z-t00001): a cup's lava had landed at 332,-59,0 and
 * spread to level 4 two cells out when the bot, held up by a 1.2 s stall of
 * its client, replanned from 325,-59,0. The route skirted that ring through
 * 330,1, 331,3 and 332,3, cells the level-4 lava fills on its next update; it
 * filled 332,3 as the bot entered it, and the bot burned. Level-6 lava, the
 * ring three out, is spent. This is the recorded world at that replan.
 */
test("a route skirts spreading lava outside the cells its next update fills", async () => {
  const bot = botFixture();
  bot.entity.position.set(325.5, -59, 0.5);
  bot.entity.velocity = bot.entity.position.scaled(0);
  const lava = bot.registry.blocksByName.lava.minStateId;
  const bedrock = bot.registry.blocksByName.bedrock.defaultState;
  const glass = bot.registry.blocksByName.glass.defaultState;
  const cells = new Map<string, number>();
  for (let x = 331; x <= 333; x++)
    for (let z = -1; z <= 1; z++) for (const y of [-57, -56]) cells.set(`${x},${y},${z}`, glass);
  cells.set("332,-56,0", lava);
  for (const y of [-57, -58, -59]) cells.set(`332,${y},0`, lava + 8);
  for (const [x, z] of [[331, 0], [333, 0], [332, 1], [332, -1]]) cells.set(`${x},-59,${z}`, lava + 2);
  for (const [x, z] of [[330, 0], [334, 0], [331, 1], [331, -1], [333, 1], [333, -1], [332, 2], [332, -2]])
    cells.set(`${x},-59,${z}`, lava + 4);
  const stateAt = (x: number, y: number, z: number) =>
    cells.get(`${x},${y},${z}`) ?? (y <= -60 && x >= 298 && x <= 381 && z >= -15 && z <= 15 ? bedrock : 0);
  bot.world.getBlockStateId = (p) => stateAt(p.x, p.y, p.z);
  Object.assign(bot.world, {
    getColumn: (chunkX: number, chunkZ: number) => ({
      minY: -64,
      worldHeight: 384,
      getBlockStateId: (p: { x: number; y: number; z: number }) => stateAt(chunkX * 16 + p.x, p.y, chunkZ * 16 + p.z),
    }),
  });
  const navigation = createNavigationRuntime(bot);
  const stop = new AbortController();
  let route: readonly { to: { x: number; y: number; z: number } }[] = [];
  navigation.onEvent((event) => {
    if (event.kind !== "route_committed") return;
    route = event.plan.steps;
    stop.abort("Route observed; execution is covered by the native scenario");
  });
  try {
    await navigation.navigate({
      movements: createMovements(bot, { allowDigging: false, scaffolding: false }),
      goal: exactBlockGoal({ x: 378, y: -59, z: 0 }),
      stopSignal: stop.signal,
    });
    assert.ok(route.length > 0, "a route was committed");
    const next = route.filter(({ to }) => Math.abs(to.x - 332) + Math.abs(to.z) < 4).map(({ to }) => `${to.x},${to.z}`);
    assert.deepEqual(next, [], "no step stands where the lava's next update reaches");
  } finally {
    await navigation.close();
  }
});
