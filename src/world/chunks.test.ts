import assert from "node:assert/strict";
import test from "node:test";
import { CHUNK_WIDTH, chunkCoordinate, chunkPosition } from "./chunks.js";

test("maps block coordinates to their containing chunks across zero and exact boundaries", () => {
  assert.equal(CHUNK_WIDTH, 16);
  assert.deepEqual([15.999, 16, -0.001, -16, -16.001].map(chunkCoordinate), [0, 1, -1, -1, -2]);
});

test("maps one structural horizontal position to chunk coordinates", () => {
  assert.deepEqual(chunkPosition({ x: -0.001, z: 31.999 }), { chunkX: -1, chunkZ: 1 });
});
