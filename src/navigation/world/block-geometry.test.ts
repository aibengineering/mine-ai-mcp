import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "./memory-world.js";
import { isSafeSupport } from "./block-geometry.js";

/** A big dripleaf's flat leaf: full width, an eighth short of full height, so a tread by shape alone. */
const LEAF_SHAPE = [{ minX: 0, minY: 0.6875, minZ: 0, maxX: 1, maxY: 0.9375, maxZ: 1 }];

/** An open trapdoor's slat at the cell's east edge: full height, three sixteenths wide. */
const SLAT_SHAPE = [{ minX: 0.8125, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }];

/** A bottom staircase: a full slab under a step whose top reaches the cell's ceiling. */
const STAIR_SHAPE = [
  { minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 0.5, maxZ: 1 },
  { minX: 0, minY: 0.5, minZ: 0, maxX: 1, maxY: 1, maxZ: 0.5 },
];

test("a yielding tread is not support, though the same shape is", () => {
  const world = new MemoryWorld();
  world.load({ x: 0, y: 0, z: 0 }, { stateId: 7, collisionShapes: LEAF_SHAPE, traits: { empty: false } });
  world.load({ x: 1, y: 0, z: 0 }, { stateId: 8, collisionShapes: LEAF_SHAPE, traits: { empty: false, yielding: true } });
  assert.equal(isSafeSupport(world.blockAt(0, 0, 0)), true, "a slab-topped block of this height is a floor");
  assert.equal(isSafeSupport(world.blockAt(1, 0, 0)), false, "a big dripleaf is not");
});

test("a slat reaching full height at the cell's edge is not a tread", () => {
  const world = new MemoryWorld();
  world.load({ x: 0, y: 0, z: 0 }, { stateId: 7, collisionShapes: SLAT_SHAPE, traits: { empty: false } });
  assert.equal(
    isSafeSupport(world.blockAt(0, 0, 0)),
    false,
    "a body stepping into the cell's middle is held up by nothing",
  );
});

test("a staircase's step top passes under the cell's middle, so it stays a tread", () => {
  const world = new MemoryWorld();
  world.load({ x: 0, y: 0, z: 0 }, { stateId: 7, collisionShapes: STAIR_SHAPE, traits: { empty: false } });
  assert.equal(isSafeSupport(world.blockAt(0, 0, 0)), true, "the step's top reaches the middle");
});
