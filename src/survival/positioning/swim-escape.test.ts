import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { answerBlocks } from "../../test-support/world.js";
import { risingReachesAir, swimmingRoof } from "./swim-escape.js";

test("all four off-center shoulders detect the overhang and recenter inside the waterfall", () => {
  for (const [x, z, roofX, roofZ] of [
    [0.03, 0.09, 0, -1],
    [0.97, 0.91, 0, 1],
    [0.09, 0.97, -1, 0],
    [0.91, 0.03, 1, 0],
  ] as const) {
    const bot = { entity: { position: new Vec3(x, -32.8, z) } } as unknown as Bot;
    answerBlocks(bot, (p) => {
      const at = p.floored();
      if (at.x === roofX && at.y === -31 && at.z === roofZ) return "bedrock";
      return at.x === 0 && at.z === 0 && at.y <= -21 ? "water" : "air";
    });
    assert.equal(swimmingRoof(bot)?.name, "bedrock");
    const centre = risingReachesAir(bot);
    assert.deepEqual(centre, new Vec3(0.5, -32.8, 0.5), "rise in the column, not beside it");
    bot.entity.position = centre!;
    assert.equal(swimmingRoof(bot), null);
  }
});

test("a column closed overhead leaves the way to air to a route", () => {
  const bot = { entity: { position: new Vec3(0.5, -58, 0.5) } } as unknown as Bot;
  // PocketSwimmer's room: water to -57 under obsidian, the pocket six blocks east.
  answerBlocks(bot, (p) => {
    const at = p.floored();
    if (at.y >= -57 && at.x >= 6) return at.y <= -57 ? "water" : "air";
    return at.y <= -57 ? "water" : "obsidian";
  });
  assert.equal(risingReachesAir(bot), null);
  bot.entity.position = new Vec3(6.5, -58, 0.5);
  assert.deepEqual(risingReachesAir(bot), new Vec3(6.5, -58, 0.5));
});
