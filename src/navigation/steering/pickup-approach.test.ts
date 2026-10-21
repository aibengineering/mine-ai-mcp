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
  // Nothing takes the item here, so the step holds its point for its full second.
  for (let tick = 0; tick < 25; tick++) {
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

test("closing on a drop against flowing water holds on until the item is taken", async () => {
  // collect/waterfall-oak, LiveCollector, 2026-10-22: the bottom log's drop
  // lay at x 0.875 in its cell, and the bot stood at x -0.57 in the flowing
  // water of the cell beside it. The approach stopped at the first overlap of
  // the pickup box, 0.02 of a block, and released; the current pushed the body
  // back before the server saw an overlap, and the route re-arrived for two
  // minutes without a log. The server, a tick behind, takes the item only with
  // a tenth of a block to spare.
  const controls: Record<string, boolean> = {};
  const item = { id: 7, name: "item", position: new Vec3(0.875, -59, 1.2485), width: 0.25, height: 0.25 };
  const entities: Record<number, unknown> = { 7: item };
  const bot = botFixture(
    { position: new Vec3(-0.57, -59, 1.2696), entities },
    { setControlState: (control: string, state: boolean) => { controls[control] = state; } },
  );
  const walk = stepIntoPickupReach(bot, 7);
  let taken = false;
  for (let tick = 0; tick < 25 && !taken; tick++) {
    await nextTurn();
    // Recorded: walking in the current gains about 0.0125 a tick; the current
    // alone carries the body back about 0.01.
    bot.entity.position.x += controls.right ? 0.0125 : -0.01;
    if (bot.entity.position.x + 0.3 + 1 > item.position.x - 0.125 + 0.1) {
      delete entities[7];
      taken = true;
    }
    bot.emit("physicsTick");
  }
  assert.equal(taken, true, `the server took the item; the body reached x ${bot.entity.position.x.toFixed(3)}`);
  assert.equal(await walk, true);
  assert.equal(Object.values(controls).some(Boolean), false, "controls released");
});
