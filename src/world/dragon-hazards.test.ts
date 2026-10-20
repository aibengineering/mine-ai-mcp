import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../test-support/bot.js";
import { breathBesideFeet, dragonDanger } from "./dragon-hazards.js";

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
