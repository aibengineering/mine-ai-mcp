import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import blockLoader from "prismarine-block";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { compareCollectionTargets } from "./target-selection.js";

const registry = minecraftData("1.21.4");
const Block = blockLoader("1.21.4");
const blaze = (id: number, x: number, y: number) =>
  ({
    id,
    name: "blaze",
    position: new Vec3(x, y, 0),
    height: 1.8,
    width: 0.6,
  }) as Bot["entities"][number];

function terrain(ground: (x: number) => string | null): Bot {
  return {
    blockAt: (position: Vec3) => {
      const name = ground(position.x);
      if (name === null) return null;
      const block = Block.fromStateId(registry.blocksByName[position.y < 64 ? name : "air"].defaultState, 0);
      block.position = position.floored();
      return block;
    },
    entity: { position: new Vec3(0, 64, 0), height: 1.8 },
    world: { raycast: () => null },
  } as unknown as Bot;
}

test("collection prefers a farther supported blaze drop over a nearby lava landing", () => {
  const bot = terrain((x) => (x < 5 ? "lava" : "nether_bricks"));
  assert.ok(compareCollectionTargets(bot, blaze(1, 8, 68), blaze(2, 2, 65)) < 0);
});

test("collection prefers a shorter supported drop and keeps unknown landings eligible", () => {
  const bot = terrain((x) => (x === 3 ? null : "nether_bricks"));
  assert.ok(compareCollectionTargets(bot, blaze(1, 8, 65), blaze(2, 2, 72)) < 0);
  assert.ok(compareCollectionTargets(bot, blaze(1, 8, 65), blaze(3, 3, 65)) < 0);
  assert.equal(compareCollectionTargets(bot, blaze(3, 3, 65), blaze(3, 3, 65)), 0);
});
