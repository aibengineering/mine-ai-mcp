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

test("closing on a drop beside lava keeps the body's momentum out of the lava cell", async () => {
  // pathfinder/flowing-lava-course, Collector, 2026-10-22 (bisect-df85fa5
  // t00001): the obsidian's drop lay at 400.125,-0.947, reached from the floor
  // cell 401,-54,0 whose west neighbour 400,-54,0 had filled with spent lava.
  // The approach steered for x 401.3, flush with that cell, released inside its
  // 0.05 brake still moving 0.08 a tick, and the body slid to x 401.27: its
  // edge 0.03 into the lava. Burning, the collect returned failed at health 16.
  const controls: Record<string, boolean> = {};
  const item = { id: 7, name: "item", position: new Vec3(400.125, -54, -0.9475), width: 0.25, height: 0.25 };
  const entities: Record<number, unknown> = { 7: item };
  const bot = botFixture(
    {
      position: new Vec3(401.593, -54, 0.4549),
      entities,
      groundY: -55,
      blocks: { "400,-54,0": "lava", "401,-54,-1": "bedrock", "401,-53,-1": "bedrock" },
    },
    { setControlState: (control: string, state: boolean) => { controls[control] = state; } },
  );
  const walk = stepIntoPickupReach(bot, 7);
  // Ground walking as Mineflayer integrates it: a tenth of a block of
  // acceleration while a control is held, and 0.546 of the velocity kept
  // each tick. Yaw 0 puts left at -x and forward at -z; the bedrock north of
  // the cell stops the body at z 0.3.
  const velocity = { x: 0, z: 0 };
  let nearestLava = Infinity;
  let taken = false;
  for (let tick = 0; tick < 25 && !taken; tick++) {
    await nextTurn();
    velocity.x = velocity.x * 0.546 + (controls.right ? 0.1 : 0) - (controls.left ? 0.1 : 0);
    velocity.z = velocity.z * 0.546 + (controls.back ? 0.1 : 0) - (controls.forward ? 0.1 : 0);
    bot.entity.position.x += velocity.x;
    bot.entity.position.z = Math.max(0.3, bot.entity.position.z + velocity.z);
    nearestLava = Math.min(nearestLava, bot.entity.position.x - 0.3 - 401);
    // The server takes the item with a tenth of a block to spare.
    const reach = 0.3 + 1 + item.width / 2 - 0.1;
    if (
      Math.abs(bot.entity.position.x - item.position.x) < reach &&
      Math.abs(bot.entity.position.z - item.position.z) < reach
    ) {
      delete entities[7];
      taken = true;
    }
    bot.emit("physicsTick");
  }
  // Let the released body coast to rest.
  for (let tick = 0; tick < 10; tick++) {
    velocity.x *= 0.546;
    bot.entity.position.x += velocity.x;
    nearestLava = Math.min(nearestLava, bot.entity.position.x - 0.3 - 401);
  }
  assert.ok(nearestLava >= 0, `the body's edge reached ${(-nearestLava).toFixed(3)} into the lava cell`);
  assert.equal(taken, true, `the server took the item; the body reached x ${bot.entity.position.x.toFixed(3)}`);
  assert.equal(await walk, true);
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
