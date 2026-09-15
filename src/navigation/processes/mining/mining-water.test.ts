import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { blockClass } from "../../mineflayer/world.js";
import { clearMiningWater } from "./mining-water.js";

test("dry mining seals source water, including below the target, while an existing surface swim needs no plug", async () => {
  for (const wetMiner of [false, true]) for (const offset of [new Vec3(1, 0, 0), new Vec3(0, -1, 0)]) {
    const bot = botFixture();
    bot.entity.position = new Vec3(0.5, 64, 0.5);
    bot.entity.onGround = true;
    const target = new Vec3(1, 64, 0);
    const face = target.plus(offset);
    const blocks = blockClass(bot);
    let sealed = false;
    bot.blockAt = (position) => {
      const name = (position.equals(face) && !sealed) || (wetMiner && position.equals(new Vec3(0, 64, 0)))
        ? "water" : position.equals(target) || position.y < 64 ? "stone" : "air";
      const block = blocks.fromStateId(bot.registry.blocksByName[name]!.minStateId, 0);
      block.position = position;
      return block;
    };
    // No source is visible, so preparation must seal the local face directly.
    bot.world.raycast = () => null;
    const result = await clearMiningWater(bot, target, async (_bot, position) => {
      assert.deepEqual(position, face);
      sealed = true;
      return { kind: "placed", block: bot.blockAt(face)! };
    }, null);
    assert.equal(result, null);
    assert.equal(sealed, !wetMiner);
  }
});

test("a dry mining site with no sealing material is refused without waiting for water that cannot drain", async () => {
  const bot = botFixture();
  const blocks = blockClass(bot);
  bot.entity.position = new Vec3(0.5, 64, 0.5);
  bot.blockAt = (position) => {
    const name = position.equals(new Vec3(2, 64, 0)) ? "water" : "air";
    const block = blocks.fromStateId(bot.registry.blocksByName[name]!.minStateId, 0);
    block.position = position;
    return block;
  };
  bot.world.raycast = () => null;
  const result = await clearMiningWater(bot, new Vec3(1, 64, 0), async () => ({ kind: "failed", error: "No building material" }), null);
  assert.match(result!, /could not be isolated.*No building material/);
});
