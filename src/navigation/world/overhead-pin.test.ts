import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "./memory-world.js";
import { overheadPinningCell } from "./overhead-pin.js";

/** A big dripleaf's flat leaf: a full-width slab from 0.6875 to 0.9375 of its cell. */
const LEAF = { stateId: 7, collisionShapes: [{ minX: 0, minY: 0.6875, minZ: 0, maxX: 1, maxY: 0.9375, maxZ: 1 }] };
const SOLID = { stateId: 1 };

function pool() {
  const world = new MemoryWorld();
  for (let x = -1; x <= 1; x += 1)
    for (let z = -1; z <= 1; z += 1) {
      world.load({ x, y: -61, z }, SOLID);
      for (let y = -60; y <= -57; y += 1) world.load({ x, y, z }, { stateId: 0 });
    }
  return world;
}

test("a leaf reset over a body in a one-deep pool is the cell holding it down", () => {
  const world = pool();
  world.load({ x: 0, y: -59, z: 0 }, LEAF);
  // The server's hold, as observed: the leaf's underside less the crouch box.
  assert.deepEqual(overheadPinningCell(world, { x: 0.54, y: -59.8166, z: 0.5 }), { x: 0, y: -59, z: 0 });
  // Mineflayer's own reading, a few hundredths higher each tick, says the same.
  assert.deepEqual(overheadPinningCell(world, { x: 0.54, y: -59.78, z: 0.5 }), { x: 0, y: -59, z: 0 });
});

test("a body standing on the leaf, or clear of it, is not held", () => {
  const world = pool();
  world.load({ x: 0, y: -59, z: 0 }, LEAF);
  assert.equal(overheadPinningCell(world, { x: 0.5, y: -58.0625, z: 0.5 }), null, "standing on top");
  assert.equal(overheadPinningCell(world, { x: 1.5, y: -60, z: 0.5 }), null, "the pool cell beside it");
  world.load({ x: 0, y: -59, z: 0 }, { stateId: 0 });
  assert.equal(overheadPinningCell(world, { x: 0.5, y: -60, z: 0.5 }), null, "the leaf broken");
});

test("a ceiling the body cannot even crawl under is a wall to physics, not a pin", () => {
  const world = pool();
  world.load({ x: 0, y: -60, z: 0 }, SOLID);
  assert.equal(overheadPinningCell(world, { x: 0.5, y: -60, z: 0.5 }), null);
});

test("the leaf counts only where the footprint reaches it", () => {
  const world = pool();
  world.load({ x: 0, y: -59, z: 0 }, LEAF);
  assert.deepEqual(overheadPinningCell(world, { x: 1.2, y: -60, z: 0.5 }), { x: 0, y: -59, z: 0 }, "the body's edge is under it");
  assert.equal(overheadPinningCell(world, { x: 1.4, y: -60, z: 0.5 }), null, "the body is past it");
});
