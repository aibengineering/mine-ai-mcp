import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { inDefensiveContact } from "./contact.js";

test("a sword-armed attacker closing on a sprinting bot is in contact while a guard can still be ready", () => {
  // The 2026-10-20 crossing, two ticks before the fight began: the bot
  // sprinted at 0.28 blocks a tick and the wither skeleton walked back at
  // 0.27. Admitted at 2.79 blocks, the guard had four ticks of use when the
  // swing landed; a raised shield blocks only after five. At 3.85 blocks the
  // swing is still six ticks away, and it is already the last chance to guard.
  const bot = botFixture();
  bot.entity.position.set(0.5, 64, 6.9);
  bot.entity.width = 0.6;
  bot.entity.height = 1.8;
  bot.world.raycast = () => null;
  const skeleton = {
    id: 4, name: "wither_skeleton", kind: "Hostile mobs", isValid: true,
    width: 0.7, height: 2.4,
    position: new Vec3(0.4, 64, 10.75),
    velocity: new Vec3(0, 0, 0),
    heldItem: { name: "stone_sword" },
    metadata: [],
  } as unknown as Bot["entity"];
  bot.entities[4] = skeleton;
  assert.equal(inDefensiveContact(bot, skeleton), true);
});
