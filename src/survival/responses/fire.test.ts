import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { isInLava } from "../perception/body.js";

test("lava contact includes the shallow body overlap missed by the swimming flag", () => {
  let level: number | string = 0;
  const bot = {
    entity: { position: new Vec3(0.761841334797, 63.875, 0.5), width: 0.6, height: 1.8, isInLava: false },
    blockAt: (at: Vec3) =>
      at.floored().equals(new Vec3(1, 63, 0)) ? { name: "lava", getProperties: () => ({ level }) } : { name: "air" },
  } as unknown as Bot;
  assert.equal(isInLava(bot), true);
  bot.entity.position.x = 0.69;
  assert.equal(isInLava(bot), false, "beside lava without body overlap is safe");
  bot.entity.position.x = 0.76;
  bot.entity.position.y = 63.95;
  assert.equal(isInLava(bot), false, "above the source surface is safe");
  bot.entity.position.y = 63.875;
  level = 7;
  assert.equal(isInLava(bot), false, "a low flowing layer does not fill the whole cell");
  level = "7";
  assert.equal(isInLava(bot), false, "Prismarine string levels retain the same shallow surface");
  level = "8";
  assert.equal(isInLava(bot), true, "a falling stream fills back up to source height");
});
