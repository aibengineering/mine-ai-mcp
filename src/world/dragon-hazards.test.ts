import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../test-support/bot.js";
import { breathBesideFeet, breathOverStances, dragonDanger } from "./dragon-hazards.js";

/** A dragon-breath area effect cloud; metadata 8 is its radius. */
function breathCloud(id: number, position: Vec3, radius: number) {
  return {
    id, name: "area_effect_cloud", isValid: true, position,
    metadata: { 8: radius, 10: { type: "dragon_breath" } },
  } as unknown as Bot["entity"];
}

/**
 * Seed 8675309, 20 October: the dragon sat on the fountain flaming, and its
 * radius-five cloud #88 settled at 9.95,64,-1.61 while the bot stood on a
 * raised cell at 9.85,65,-0.10. A block above the cloud's floor the body was
 * not exposed and no escape ran, but every step down entered the breath, and
 * the staircase it had been asked to build read that as unreachable treads,
 * five requests running.
 */
test("breath on the floor beside a raised cell closes its routes without exposing the body on it", () => {
  const feet = new Vec3(9.85, 65, -0.1);
  const bot = botFixture({ dimension: "the_end", position: feet });
  bot.entities[88] = breathCloud(88, new Vec3(9.95, 64, -1.61), 5);
  assert.equal(dragonDanger(bot), false, "standing above the cloud is safe");
  assert.deepEqual(breathBesideFeet(bot, feet).map((cloud) => cloud.id), [88]);
  assert.deepEqual(breathBesideFeet(bot, new Vec3(30.5, 65, 0.5)), [], "breath twenty blocks off closes nothing here");
  assert.deepEqual(breathBesideFeet(bot, new Vec3(9.85, 70, -0.1)), [], "nor breath five blocks below");
});

/**
 * Seed 81360492, first-entry fight of 20 October: a dragon fireball's cloud
 * #411 landed on the staircase at -44.46,70.23,-3.50, two treads above the
 * bot at -44.44,68,-1.45. Too high to count as beside its feet, it still
 * filled the treads at -45,70,-4 and -44,71,-4, the only way up, and three
 * staircase requests each spent their 2000 ms searching for another.
 */
test("breath on a tread above the bot closes the staircase route through it", () => {
  const feet = new Vec3(-44.44, 68, -1.45);
  const bot = botFixture({ dimension: "the_end", position: feet });
  bot.entities[411] = breathCloud(411, new Vec3(-44.46, 70.23, -3.5), 3.65);
  assert.deepEqual(breathBesideFeet(bot, feet), [], "two and a quarter blocks up is not beside the feet");
  const treads = [{ x: -45, y: 70, z: -4 }, { x: -44, y: 71, z: -4 }, { x: -43, y: 72, z: -4 }];
  assert.deepEqual(breathOverStances(bot, treads).map((cloud) => cloud.id), [411]);
  assert.deepEqual(breathOverStances(bot, [{ x: -43, y: 80, z: -4 }]), [], "a tread far above it is open");
});
