import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { blockNamed } from "../../test-support/world.js";
import { compareCollectionTargets } from "./target-selection.js";

const blaze = (id: number, x: number, y: number) =>
  ({
    id,
    name: "blaze",
    position: new Vec3(x, y, 0),
    height: 1.8,
    width: 0.6,
  }) as Bot["entities"][number];

/** Ground below y 64 whose name depends on x; `null` is an unloaded column. */
function terrain(ground: (x: number) => string | null): Bot {
  return botFixture({
    position: { x: 0, y: 64, z: 0 },
    blocks: (cell: Vec3) => {
      const name = ground(cell.x);
      return name === null ? null : blockNamed(cell.y < 64 ? name : "air", cell.floored());
    },
  });
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
