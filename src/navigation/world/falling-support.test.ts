import assert from "node:assert/strict";
import test from "node:test";
import { planningStart } from "../../test-support/navigation.js";
import { hasUnstableFallingSupport } from "./block-geometry.js";
import { MemoryWorld } from "./memory-world.js";

const floor = { x: 0, y: 38, z: 0 };
const base = { x: 0, y: 36, z: 0 };
function column() {
  const world = new MemoryWorld();
  for (const y of [37, 38]) world.load({ ...floor, y }, { stateId: 124, traits: { falling: true } });
  return world;
}

test("falling floors require a supported column, including its unobserved base", () => {
  const world = column();
  const unstable = () => hasUnstableFallingSupport((x, y, z) => world.blockAt(x, y, z), 0, 38, 0);
  assert.equal(unstable(), true);
  world.load(base, { stateId: 0 });
  assert.equal(unstable(), true);
  world.load(base, { stateId: 1 });
  assert.equal(unstable(), false);
  world.load(base, { stateId: 102, collisionShapes: [], traits: { liquid: "lava", empty: true } });
  assert.equal(unstable(), true);
});

test("falling support follows the route's prior breaks and placements", () => {
  const world = column();
  world.load(base, { stateId: 1 });
  const broken = planningStart({ x: 0, y: 39, z: 0 }).overlay.apply({ kind: "break", position: base, stateId: 0 });
  const placed = broken.apply({ kind: "place", position: base, stateId: 1 });
  assert.equal(hasUnstableFallingSupport(broken.view(world).blockAt, 0, 38, 0), true);
  assert.equal(hasUnstableFallingSupport(placed.view(world).blockAt, 0, 38, 0), false);
});

test("ordinary support does not inspect the column beneath it", () => {
  const world = new MemoryWorld();
  world.load(floor, { stateId: 1 });
  let reads = 0;
  assert.equal(
    hasUnstableFallingSupport(
      (x, y, z) => {
        reads++;
        return world.blockAt(x, y, z);
      },
      0,
      38,
      0,
    ),
    false,
  );
  assert.equal(reads, 1);
});
