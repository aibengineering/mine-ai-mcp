import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { visibleBlockAim } from "./block-visibility.js";
import { worldViewRaycaster } from "../navigation/world/line-of-sight.js";

const FULL = [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }];
const CARPET = [{ ...FULL[0]!, maxY: 0.0625 }];

/**
 * A world whose only solid cells are the ones named, so occlusion is explicit.
 * Built on the planning raycaster search itself uses, rather than a stepping
 * approximation: which cell the ray meets first, and from which side, is the
 * whole question here.
 */
const worldWith = (solid: readonly string[], shape = FULL) =>
  worldViewRaycaster((x, y, z) => (solid.includes(`${x},${y},${z}`) ? shape : []));

test("reports the face an eye can see, not merely that the block is near", () => {
  const face = visibleBlockAim(worldWith(["3,64,0"]), { x: 0.5, y: 65.62, z: 0.5 }, { x: 3, y: 64, z: 0 }, 4.5, FULL);

  assert.notEqual(face, null);
  // Approached from below and to one side, the eye is above the block centre,
  // so the top face is the one the dig has to aim at.
  assert.deepEqual(face, new Vec3(3.5, 65, 0.5));
});

test("refuses a target it cannot reach: walled off from the eye, or simply too far", () => {
  const eye = { x: 0.5, y: 64.62, z: 0.5 };
  // A full column between the eye and the target blocks every approach face.
  const walled = worldWith(["3,64,0", "1,64,0", "1,65,0", "1,66,0", "2,64,0", "2,65,0", "2,66,0"]);
  assert.equal(visibleBlockAim(walled, eye, { x: 3, y: 64, z: 0 }, 4.5, FULL), null);

  assert.equal(visibleBlockAim(worldWith(["8,64,0"]), eye, { x: 8, y: 64, z: 0 }, 4.5, FULL), null);
});

test("a carpet at chest height has a visible aim point on its thin top", () => {
  const world = worldWith(["1,64,0"], CARPET);
  const eye = { x: 0.5, y: 64.62, z: 0.5 };
  const target = { x: 1, y: 64, z: 0 };

  assert.equal(visibleBlockAim(world, eye, target, 4.5, FULL), null, "the old cube aim misses the carpet");
  assert.deepEqual(visibleBlockAim(world, eye, target, 4.5, CARPET), new Vec3(1.5, 64.0625, 0.5));
});

test("a passable target needs a clear ray to its centre and remains limited by reach", () => {
  const target = { x: 3, y: 64, z: 0 };
  const eye = { x: 0.5, y: 64.5, z: 0.5 };

  assert.deepEqual(visibleBlockAim(worldWith([]), eye, target, 4.5, []), new Vec3(3.5, 64.5, 0.5));
  assert.equal(visibleBlockAim(worldWith(["1,64,0"]), eye, target, 4.5, []), null);
  assert.equal(visibleBlockAim(worldWith([]), eye, target, 2, []), null);
});
