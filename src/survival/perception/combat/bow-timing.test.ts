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

test("a draw seen aimed at the bot stays aimed at it while its reported head lags the bot's walk", () => {
  // skeleton-arena-crossfire, xfire-fix3 2026-10-22T03-13-08-714Z (t00017).
  // Skeleton #373 drew at the bot from 4 blocks, its head 2 degrees off. As
  // the bot walked past, the head the server reported fell behind: 10 degrees
  // off at 3.5 blocks, wider than the body and two byte-angle steps. Two ticks
  // from release the draw read as aimed elsewhere, the guard turned to #375,
  // and #373's arrow entered from 130 degrees off.
  const bot = botFixture({ position: new Vec3(10.2375, -60, 3.1697), groundY: -61 });
  bot.entity.yaw = -1.8404;
  const skeleton = (id: number, position: Vec3, headYaw: number) => ({ id, name: "skeleton", kind: "Hostile mobs",
    isValid: true, position, velocity: new Vec3(0, 0, 0), height: 1.99, width: 0.6,
    heldItem: { name: "bow" }, metadata: { 8: 1 }, headYaw, pitch: 0,
  }) as unknown as typeof bot.entity;
  const near = skeleton(373, new Vec3(13.4571, -60, 5.6023), 0.9572);
  const far = skeleton(375, new Vec3(15.4619, -60, -2.0398), 2.2826);
  bot.entities[373] = near;
  bot.entities[375] = far;
  using _tracker = trackBowDraws(bot);
  bot.emit("physicsTick");
  assert.ok(observeProjectileDefence(bot)!.windingUp.includes(near), "458 ms out, the draw is plainly aimed at the bot");

  for (let tick = 0; tick < 6; tick++) bot.emit("physicsTick");
  bot.entity.position.set(11.2941, -60, 3.4556);
  near.position.set(13.5213, -60, 6.1704);
  Reflect.set(near, "headYaw", 0.859);
  far.position.set(16.0334, -60, -2.0249);
  Reflect.set(far, "headYaw", 2.3562);
  bot.emit("physicsTick");
  const defence = observeProjectileDefence(bot)!;
  assert.ok(defence.windingUp.includes(near), "the same draw, its head 10 degrees off, is still for the bot");
  const toward = near.position.minus(bot.entity.position);
  const heading = defence.facing.minus(bot.entity.position);
  assert.ok((toward.x * heading.x + toward.z * heading.z) / Math.hypot(toward.x, toward.z) / Math.hypot(heading.x, heading.z) > 0,
    "the shield stays in front of it");

  // A head turned well away from the bot is another target, even mid-draw.
  Reflect.set(near, "headYaw", 0.859 + Math.PI / 2);
  bot.emit("physicsTick");
  assert.ok(!observeProjectileDefence(bot)!.windingUp.includes(near));
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
