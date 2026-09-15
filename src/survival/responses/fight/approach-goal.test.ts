import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { flatWorld, observation } from "../../../test-support/navigation.js";
import { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

/** A skeleton six blocks away on flat ground: outside sword reach, inside a clear bow line. */
function fixture(bow: boolean) {
  const target = {
    id: 7,
    name: "skeleton",
    isValid: true,
    width: 0.6,
    height: 1.99,
    position: new Vec3(4.5, 63, 4.5),
    heldItem: { name: "bow" },
    metadata: [],
  } as unknown as Parameters<Bot["attack"]>[0];
  const bot = botFixture({
    position: { x: 0.5, y: 63, z: 0.5 },
    entities: { 7: target },
    items: [
      { name: "diamond_sword", count: 1 },
      { name: "bow", count: 1 },
      { name: "arrow", count: 3 },
    ],
  });
  const world = flatWorld();
  const scene = {
    bot,
    target,
    navigation: { world },
    policy: { combat: { bow, melee: true, shield: true } },
  } as unknown as FightScene;
  const movement = new FightMovement(scene, {} as FightWeapons);
  const goal = movement.approachGoal(true).resolve({ ...observation(), position: bot.entity.position });
  assert.equal(goal.kind, "active");
  if (goal.kind !== "active") throw new Error("unreachable");
  const start = { feet: { x: 0, y: 63, z: 0 }, remainingScaffolds: 0, overlayId: "overlay:0" };
  return goal.isSatisfied(start, world);
}

test("a carried bow's firing line satisfies the approach only when the policy permits the bow", () => {
  assert.equal(fixture(true), true, "a permitted bow may answer the skeleton from this firing line");
  // Arrow collection forbids the bow for the whole request. Arriving at once on
  // a firing line the turn may not use left the bot spinning between guard and
  // a zero-length approach six blocks from a skeleton it never reached.
  assert.equal(fixture(false), false, "a forbidden bow's firing line is not an attack position");
});
