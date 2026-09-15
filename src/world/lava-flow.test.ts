import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { advancingLavaAt } from "./lava-flow.js";

test("new adjacent lava threatens a dry stance before contact, respecting flow reach and barriers", () => {
  let level = "4";
  let body = "air";
  const source = new Vec3(-1, 64, 0);
  const bot = {
    game: { dimension: "overworld" },
    entity: { position: new Vec3(0.5, 64, 0.5) },
    blockAt: (p: Vec3) => {
      if (p.equals(source)) return { name: "lava", boundingBox: "empty", getProperties: () => ({ level }) };
      return { name: body, boundingBox: body === "stone" ? "block" : "empty" };
    },
  } as unknown as Bot;
  assert.equal(advancingLavaAt(bot), true);
  assert.equal(
    advancingLavaAt(bot, bot.entity.position, new Vec3(8, 64, 0)),
    false,
    "unrelated updates do not claim the body",
  );
  assert.equal(advancingLavaAt(bot, new Vec3(1.5, 64, 0.5)), false);
  level = "6";
  assert.equal(advancingLavaAt(bot), false, "terminal Overworld flow cannot take another horizontal step");
  bot.game.dimension = "the_nether";
  assert.equal(advancingLavaAt(bot), true, "Nether flow reaches another cell");
  body = "stone";
  assert.equal(advancingLavaAt(bot), false, "a separating solid blocks flow");
  body = "water";
  assert.equal(advancingLavaAt(bot), false, "water reacts with lava instead of admitting its flow");
});
