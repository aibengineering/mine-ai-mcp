import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import prismarineBlock from "prismarine-block";
import { Vec3 } from "vec3";
import { nearbySwimEscape, swimmingRoof } from "./swim-escape.js";

test("all four off-center shoulders detect the overhang and recenter inside the waterfall", () => {
  const registry = minecraftData("1.21.4");
  const Block = prismarineBlock("1.21.4");
  for (const [x, z, roofX, roofZ] of [
    [0.03, 0.09, 0, -1],
    [0.97, 0.91, 0, 1],
    [0.09, 0.97, -1, 0],
    [0.91, 0.03, 1, 0],
  ] as const) {
    const bot = {
      entity: { position: new Vec3(x, -32.8, z) },
      blockAt: (p: Vec3) => {
        const at = p.floored();
        const name =
          at.x === roofX && at.y === -31 && at.z === roofZ ? "bedrock" : at.x === 0 && at.z === 0 ? "water" : "air";
        return Block.fromStateId(registry.blocksByName[name]!.defaultState, 0);
      },
    } as unknown as Bot;
    assert.equal(swimmingRoof(bot)?.name, "bedrock");
    const escape = nearbySwimEscape(bot);
    assert.deepEqual(escape, new Vec3(0.5, -32.8, 0.5), "do not select unsupported air beside a tall waterfall");
    bot.entity.position = escape!;
    assert.equal(swimmingRoof(bot), null);
  }
});
