import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { fitsDragonShot } from "./dragon-shot.js";

test("inset permits straight flight, tightens edge shots, and rejects projected turns", () => {
  const center = new Vec3(20, 80, 0), motion = new Vec3(0, 0, 1), intercept = center.offset(0, 0, 10);
  assert.equal(fitsDragonShot(intercept, center, motion, motion, 10, 1.25), true);
  assert.equal(fitsDragonShot(intercept.offset(2.1, 0, 0), center, motion, motion, 10, 0), true);
  assert.equal(fitsDragonShot(intercept.offset(2.1, 0, 0), center, motion, motion, 10, 0.5), false);
  assert.equal(fitsDragonShot(intercept, center, motion, new Vec3(0.3, 0, 1), 10, 0.5), false);
});
