import assert from "node:assert/strict";
import test from "node:test";
import { botFixture } from "../../../test-support/bot.js";
import { Vec3 } from "vec3";
import { bowReleaseInTicks, trackBowDraws } from "./bow-timing.js";
import { observeProjectileDefence } from "../../weapons/shield-facing.js";

test("observed draw transitions rank the due shooter ahead of entity order and survive lost sight", () => {
  const bot = botFixture();
  bot.entity.position.set(0, 64, 0);
  bot.world.raycast = () => null;
  const enemy = (id: number, z: number) => ({ id, name: "skeleton", kind: "Hostile mobs", isValid: true,
    position: new Vec3(0, 64, z), velocity: new Vec3(0, 0, 0), height: 1.99, width: 0.6,
    heldItem: { name: "bow" }, metadata: { 8: 0 }, headYaw: z > 0 ? 0 : Math.PI, pitch: 0,
  }) as unknown as typeof bot.entity;
  const later = enemy(5, 8), sooner = enemy(6, -8);
  bot.entities[5] = later; bot.entities[6] = sooner;
  using _tracker = trackBowDraws(bot);
  Reflect.set(sooner.metadata, 8, 1); bot.emit("entityUpdate", sooner);
  for (let tick = 0; tick < 15; tick++) bot.emit("physicsTick");
  Reflect.set(later.metadata, 8, 1); bot.emit("entityUpdate", later);
  assert.equal(bowReleaseInTicks(bot, sooner), 5);
  assert.equal(bowReleaseInTicks(bot, later), 20);
  assert.equal(observeProjectileDefence(bot)!.windupForecasts[0]!.entity.id, 6);
  assert.ok(observeProjectileDefence(bot)!.facing.z < 0);
  for (let tick = 0; tick < 30; tick++) bot.emit("physicsTick");
  assert.equal(bowReleaseInTicks(bot, sooner), 0, "held draws do not start another timer");
  Reflect.set(sooner.metadata, 8, 0); bot.emit("entityUpdate", sooner);
  assert.equal(bowReleaseInTicks(bot, sooner), null);
});

test("a draw already active when observed has unknown age", () => {
  const bot = botFixture();
  const enemy = { id: 5, name: "skeleton", heldItem: { name: "bow" }, metadata: { 8: 1 } } as unknown as typeof bot.entity;
  bot.entities[5] = enemy;
  using _tracker = trackBowDraws(bot);
  assert.equal(bowReleaseInTicks(bot, enemy), null);
  bot.emit("physicsTick");
  assert.equal(bowReleaseInTicks(bot, enemy), null);
});

test("equipment arriving after active metadata does not restart a draw", () => {
  const bot = botFixture();
  const enemy = { id: 5, name: "skeleton", metadata: { 8: 1 } } as unknown as typeof bot.entity;
  bot.entities[5] = enemy;
  using _tracker = trackBowDraws(bot);
  Reflect.set(enemy, "heldItem", { name: "bow" });
  bot.emit("entityUpdate", enemy);
  assert.equal(bowReleaseInTicks(bot, enemy), null);
});
