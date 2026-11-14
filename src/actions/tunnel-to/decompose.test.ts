import assert from "node:assert/strict";
import test from "node:test";
import { decompose } from "./tunnel-to.js";

const dist3d = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

test("every hop is no longer than segment_length and the last waypoint is the exact target", () => {
  const from = { x: -312, y: 68, z: -1720 };
  const to = { x: -270, y: -36, z: -1817 };
  const waypoints = decompose(from, to, 13);

  assert.deepEqual(waypoints.at(-1), to, "the carve ends on the target, not a rounded approximation");
  // Nominal spacing is <= segment; rounding each waypoint to a block can add at
  // most sqrt(3) to one hop (half a block per axis at each end).
  const bound = 13 + Math.sqrt(3) + 1e-9;
  let previous = from;
  for (const waypoint of waypoints) {
    assert.ok(
      dist3d(previous, waypoint) <= bound,
      `hop ${previous.x},${previous.y},${previous.z} -> ${waypoint.x},${waypoint.y},${waypoint.z} exceeds the segment`,
    );
    assert.ok(Number.isInteger(waypoint.x) && Number.isInteger(waypoint.y) && Number.isInteger(waypoint.z));
    previous = waypoint;
  }
});

test("the split count follows segment_length: a shorter hop makes strictly more waypoints", () => {
  const from = { x: 0, y: 70, z: 0 };
  const to = { x: 0, y: 10, z: 120 };
  const coarse = decompose(from, to, 13);
  const fine = decompose(from, to, 4);
  assert.ok(fine.length > coarse.length);
  // 120-ish blocks of run split into <=4-block hops needs at least 30 waypoints.
  assert.ok(fine.length >= 30, `expected >= 30 fine hops, got ${fine.length}`);
});

test("a target already within one hop yields a single waypoint at the target", () => {
  const from = { x: 5, y: 64, z: 5 };
  const to = { x: 7, y: 63, z: 6 };
  const waypoints = decompose(from, to, 13);
  assert.equal(waypoints.length, 1);
  assert.deepEqual(waypoints[0], to);
});
