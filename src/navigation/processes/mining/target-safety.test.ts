import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { flatWorld } from "../../../test-support/navigation.js";
import { blockClass } from "../../mineflayer/world.js";
import { createMovementPolicy } from "../../movements/policy.js";
import { evaluateMineTarget } from "./target-safety.js";
import { createMineflayerMovementPolicy } from "../../mineflayer/movement-policy.js";
import { observeMineflayerBlock } from "../../mineflayer/world.js";

test("lava preparation counts permitted building material, not reserved inventory", () => {
  const bot = botFixture({ items: [{ type: 1, name: "oak_log", count: 64 }] });
  const blocks = blockClass(bot);
  const target = blocks.fromStateId(bot.registry.blocksByName.oak_log!.defaultState, 0);
  target.position = new Vec3(0, 64, 0);
  bot.blockAt = (position) => {
    const name = position.equals(new Vec3(1, 64, 0)) ? "lava" : "air";
    const block = blocks.fromStateId(bot.registry.blocksByName[name]!.defaultState, 0);
    block.position = position;
    return block;
  };
  const policy = createMovementPolicy();
  const world = flatWorld();
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), {
    kind: "prohibited",
    reason: "1 lava face, 0 blocks available for placement",
  });
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 1), {
    kind: "mineable",
    routeMayBreak: false,
  });
});

test("missing isolation material rejects a dry water barrier but retains a swimmer's approach", () => {
  const bot = botFixture();
  const blocks = blockClass(bot);
  let submergedTarget = false;
  bot.blockAt = (position) => {
    const name = position.equals(new Vec3(2, 64, 0)) || (submergedTarget && position.equals(new Vec3(1, 65, 0)))
      ? "water" : position.equals(new Vec3(1, 64, 0)) ? "stone" : "air";
    const block = blocks.fromStateId(bot.registry.blocksByName[name]!.minStateId, 0);
    block.position = position;
    return block;
  };
  const world = {
    blockAt: (x: number, y: number, z: number) => observeMineflayerBlock(bot.blockAt(new Vec3(x, y, z))!),
    revision: 0, subscribe: () => () => {},
  };
  const policy = createMineflayerMovementPolicy(bot);
  const target = bot.blockAt(new Vec3(1, 64, 0))!;
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), {
    kind: "prohibited", reason: "liquid isolation needs a permitted building block or an empty bucket",
  });
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 1), { kind: "mineable", routeMayBreak: false });
  Reflect.set(bot.entity, "isInWater", true);
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), { kind: "mineable", routeMayBreak: false });
  Reflect.set(bot.entity, "isInWater", false);
  submergedTarget = true;
  assert.deepEqual(evaluateMineTarget(bot, policy, target, world, 0), { kind: "mineable", routeMayBreak: false },
    "a shore approach to an already submerged target remains available");
});
