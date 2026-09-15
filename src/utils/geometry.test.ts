import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { asVec3, cellIntersectsPlayerBody } from "./geometry.js";

test("converts a structural position to this package's Vec3", () => {
  const position = asVec3({ x: 1, y: 64, z: -2 });

  assert.ok(position instanceof Vec3);
  assert.deepEqual(position, new Vec3(1, 64, -2));
});

test("detects block cells intersecting the player's feet, head, and boundary", () => {
  const player = { x: 0.8, y: 64, z: 0.5 };

  assert.equal(cellIntersectsPlayerBody({ x: 0, y: 64, z: 0 }, player), true);
  assert.equal(cellIntersectsPlayerBody({ x: 0, y: 65, z: 0 }, player), true);
  assert.equal(cellIntersectsPlayerBody({ x: 1, y: 64, z: 0 }, player), true);
  assert.equal(cellIntersectsPlayerBody({ x: 0, y: 66, z: 0 }, player), false);
  assert.equal(cellIntersectsPlayerBody({ x: 2, y: 64, z: 0 }, player), false);
});
