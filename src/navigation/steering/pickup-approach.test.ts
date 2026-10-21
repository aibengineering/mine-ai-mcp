import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { nextTurn } from "../../test-support/async.js";
import { botFixture } from "../../test-support/bot.js";
import { stepIntoPickupReach } from "./pickup-approach.js";

test("an arrival off the centre of a reaching cell closes on the item without leaving the cell", async () => {
  // progression/tool-tier-progression's iron seam: an upper ore's drop rests
  // in its notch at x 25.8, reached from the floor cell 24,-59,13 in front.
  // A body can stop anywhere in a cell, and one stopped 0.49 off centre; here
  // at x 24.1 the pickup box falls short. It must walk toward the item, never
  // past x 24.7 where its edge meets the cell's, until the box overlaps.
  const controls: Record<string, boolean> = {};
  const bot = botFixture(
    { position: new Vec3(24.1, -59, 13.5), entities: { 9: { id: 9, name: "item", position: new Vec3(25.8, -57, 13.5), width: 0.25, height: 0.25 } } },
    { setControlState: (control: string, state: boolean) => { controls[control] = state; } },
  );
  let furthest = bot.entity.position.x;
  const walk = stepIntoPickupReach(bot, 9);
  for (let tick = 0; tick < 12; tick++) {
    await nextTurn();
    // A walking body covers about a quarter block a tick.
    if (controls.right) bot.entity.position.x += 0.22;
    if (controls.left) bot.entity.position.x -= 0.22;
    furthest = Math.max(furthest, bot.entity.position.x);
    bot.emit("physicsTick");
  }
  assert.equal(await walk, true);
  assert.ok(furthest <= 24.7 + 0.22, `stayed in its cell, reaching x ${furthest}`);
  assert.equal(Object.values(controls).some(Boolean), false, "controls released");
});
