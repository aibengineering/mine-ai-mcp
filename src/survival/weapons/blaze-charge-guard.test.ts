import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { isWindingUp } from "../perception/combat/observations.js";
import { observeProjectileDefence } from "./shield-facing.js";

// Metadata is indexed exactly as the shared 1.21.4 registry indexes it: a
// fixture must never write to that registry, which every botFixture shares.
/** Blaze charge sits in the `flags` byte at sixteen. */
const charging = () => { const m: unknown[] = []; m[16] = 1; return m; };
/** A drawn bow sets bit one of `living_entity_flags` at eight. */
const drawing = () => { const m: unknown[] = []; m[8] = 1; return m; };

function shooterFixture(name: string, held: string | null, metadata: unknown[]) {
  const bot = botFixture();
  bot._client = new EventEmitter() as Bot["_client"];
  bot.entity.position.set(0, 64, 0);
  bot.entity.width = 0.6;
  bot.entity.height = 1.8;
  bot.world.raycast = () => null;
  const shooter = {
    id: 21, name, kind: "Hostile mobs", isValid: true,
    width: 0.6, height: 1.8, eyeHeight: 1.6,
    position: new Vec3(0, 64, 9),
    velocity: new Vec3(0, 0, 0),
    // Facing the bot: yaw zero looks down -z, from +z toward the origin.
    yaw: 0, headYaw: 0, pitch: 0,
    heldItem: held ? { name: held } : null,
    metadata,
  } as unknown as Bot["entity"];
  bot.entities[21] = shooter;
  return { bot, shooter };
}

test("a charging blaze raises the same projectile defence a drawing skeleton does", () => {
  // A blaze mid-charge, nine blocks out with a clear line: the shot is coming.
  const blaze = shooterFixture("blaze", null, charging());
  assert.equal(isWindingUp(blaze.bot, blaze.shooter), true, "perception sees the charge");
  assert.notEqual(
    observeProjectileDefence(blaze.bot, 0, 1000), null,
    "the guard trigger sees the same charge, because it asks perception rather than for a bow",
  );

  // The same situation with a bow holder is seen, which is why skeletons guard.
  const skeleton = shooterFixture("skeleton", "bow", drawing());
  assert.notEqual(
    observeProjectileDefence(skeleton.bot, 0, 1000), null,
    "a drawn bow does raise the defence",
  );
});
