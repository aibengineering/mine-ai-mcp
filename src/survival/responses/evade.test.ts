import assert from "node:assert/strict";
import test from "node:test";
import { threatClosingAhead } from "./evade.js";

test("an evade sees a cube lying or carried on its route ahead, but not one beside, behind, distant or coming at it", () => {
  // CubeEvade in r3-cube 2026-10-21T05-04-58-015Z (t00001), 2.5 s into its
  // evade: sprinting east (Mineflayer velocity 0.15 blocks/tick) with the
  // small cube #3 knocked 2.8 blocks ahead by the retreat strikes and resting
  // there between hops. The cube struck 0.4 s later.
  const sprint = { x: 0.15, z: 0 };
  const resting = { x: 213.8, z: -3.4 };
  const cubes = [
    { id: 3, position: resting, earlier: resting },
    { id: 2, position: { x: 193.8, z: 3.2 }, earlier: { x: 193.8, z: 3.2 } },
  ];
  assert.equal(threatClosingAhead({ x: 211.26, z: -4.5 }, sprint, cubes), 3);
  assert.equal(threatClosingAhead({ x: 210.41, z: -4.51 }, sprint, cubes), null, "3.35 blocks off it is not yet close");
  assert.equal(threatClosingAhead({ x: 211.26, z: -4.5 }, { x: 0.02, z: 0 }, cubes), null, "a stopped body runs into nothing");
  assert.equal(threatClosingAhead({ x: 215.5, z: -4.5 }, sprint, cubes), null, "a cube already passed is behind");
  assert.equal(threatClosingAhead({ x: 213.8, z: -6 }, sprint, cubes), null, "a cube beside the heading is not ahead");

  // Still flying from a knock along the heading, it is carried down the route.
  const knocked = [{ id: 3, position: resting, earlier: { x: 212.9, z: -3.3 } }];
  assert.equal(threatClosingAhead({ x: 211.26, z: -4.5 }, sprint, knocked), 3);
  // The same place held by a walker coming at the body, or by a hostile not
  // yet watched long enough to tell.
  const walker = [{ id: 19, position: resting, earlier: { x: 214.4, z: -3.4 } }];
  assert.equal(threatClosingAhead({ x: 211.26, z: -4.5 }, sprint, walker), null, "a walker is not lying in the route");
  const unseen = [{ id: 19, position: resting, earlier: null }];
  assert.equal(threatClosingAhead({ x: 211.26, z: -4.5 }, sprint, unseen), null);
});
