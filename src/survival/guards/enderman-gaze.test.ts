import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { endermanGazeRisk } from "../perception/combat/gaze.js";
import { attachEndermanGazeControl } from "./enderman-gaze.js";

function fixture() {
  const bot = botFixture();
  bot.game.dimension = "the_end";
  bot.inventory.slots = [];
  bot.entity.yaw = 0;
  bot.entity.pitch = 0;
  bot.world.raycast = () => null;
  bot.entities[7] = { id: 7, name: "enderman", isValid: true, position: new Vec3(0.5, 63.07, -10) } as Parameters<
    Bot["attack"]
  >[0];
  bot.look = async (yaw, pitch) => {
    bot.entity.yaw = yaw;
    bot.entity.pitch = pitch;
  };
  return bot;
}

test("End eye contact is diverted without changing movement yaw; idle gaze is guarded too", async () => {
  const bot = fixture();
  const original = bot.look;
  const guard = attachEndermanGazeControl(bot, () => null);
  await bot.look(0, 0, true);
  assert.equal(bot.entity.yaw, 0);
  assert.equal(bot.entity.pitch, -Math.PI / 2);
  bot.entity.pitch = 0;
  bot.emit("physicsTick");
  assert.equal(bot.entity.pitch, -Math.PI / 2);
  await bot.look(0, 0.7, true);
  assert.equal(bot.entity.pitch, 0.7, "safe upward crystal aim stays intact");
  guard[Symbol.dispose]();
  assert.equal(bot.look, original);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});

test("gaze guard respects dimension, cover, pumpkin and deliberate selected Enderman combat", async () => {
  const bot = fixture();
  const risk = () => endermanGazeRisk(bot, bot.entity.position, 0, 0);
  assert.equal(risk(), true);
  bot.game.dimension = "overworld";
  assert.equal(risk(), false);
  bot.game.dimension = "the_end";
  bot.inventory.slots[5] = { name: "carved_pumpkin" } as Bot["heldItem"];
  assert.equal(risk(), false);
  bot.inventory.slots[5] = null;
  bot.world.raycast = () => ({}) as NonNullable<ReturnType<Bot["world"]["raycast"]>>;
  assert.equal(risk(), false);
  bot.world.raycast = () => null;
  using _guard = attachEndermanGazeControl(bot, () => ({ kind: "mob", targetId: 7 }));
  await bot.look(0, 0, true);
  assert.equal(bot.entity.pitch, 0);
  bot.entities[8] = { ...bot.entities[7]!, id: 8 } as Parameters<Bot["attack"]>[0];
  await bot.look(0, 0, true);
  assert.equal(bot.entity.pitch, -Math.PI / 2, "another Enderman is still protected from provocation");
});
