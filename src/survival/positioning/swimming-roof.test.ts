import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { answerBlocks } from "../../test-support/world.js";
import { swimmingRoof } from "./swimming-roof.js";

test("all four off-center shoulders detect the overhang, and the column's centre clears it", () => {
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
    // The breath response centres on the cell it rises in.
    bot.entity.position = new Vec3(0.5, -32.8, 0.5);
    assert.equal(swimmingRoof(bot), null);
  }
});
