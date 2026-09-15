import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { bowTrajectory, clearBowTrajectory } from "./bow-trajectory.js";

for (const target of [new Vec3(24, 0.9, 0), new Vec3(8, 0.9, 0), new Vec3(3, 4.9, 0), new Vec3(24, -10, 6)]) {
  test(`bow launch physically reaches ${target}`, () => {
    const origin = new Vec3(0, 1.52, 0);
    const trajectory = bowTrajectory(origin, target);
    assert.ok(trajectory);
    assert.ok(Math.abs(trajectory.velocity.norm() - 3) < 1e-9);
    // Independent forward simulation, stopping at the target's horizontal plane.
    let position = origin;
    let velocity = trajectory.velocity;
    while (position.x + velocity.x < target.x) {
      position = position.plus(velocity);
      velocity = new Vec3(velocity.x * 0.99, velocity.y * 0.99 - 0.05, velocity.z * 0.99);
    }
    position = position.plus(velocity.scaled((target.x - position.x) / velocity.x));
    assert.ok(position.distanceTo(target) < 1e-8);
    assert.ok(trajectory.points.at(-1)!.distanceTo(target) < 1e-8);
  });
}

test("bow rejects heights and ranges outside the projectile's physical reach", () => {
  assert.equal(bowTrajectory(new Vec3(0, 0, 0), new Vec3(3, 200, 0)), null);
  assert.equal(bowTrajectory(new Vec3(0, 0, 0), new Vec3(400, 0, 0)), null);
});

test("moving intercept meets a crossing target in independent arrow simulation", () => {
  const origin = new Vec3(0, 64, 0), target = new Vec3(35, 83, -10), motion = new Vec3(-0.2, 0, 0.8);
  const shot = bowTrajectory(origin, target, motion)!;
  assert.ok(shot);
  let position = origin, velocity = shot.velocity;
  const ticks = Math.floor(shot.flightTicks);
  for (let t = 0; t < ticks; t++) {
    position = position.plus(velocity);
    velocity = velocity.scaled(0.99).offset(0, -0.05, 0);
  }
  position = position.plus(velocity.scaled(shot.flightTicks - ticks));
  assert.ok(position.distanceTo(target.plus(motion.scaled(shot.flightTicks))) < 1e-8);
  assert.ok(Math.abs(shot.velocity.norm() - 3) < 1e-8);
});

test("curved clearance detects a ceiling above the unobstructed direct ray", () => {
  const origin = new Vec3(0, 1.52, 0);
  const target = new Vec3(24, 0.9, 0);
  const trajectory = bowTrajectory(origin, target)!;
  const ceiling = 1.6;
  const raycast = (from: Vec3, direction: Vec3, distance: number) => {
    const crossing = (ceiling - from.y) / direction.y;
    return crossing >= 0 && crossing <= distance ? {} : null;
  };
  const chord = target.minus(origin);
  assert.equal(raycast(origin, chord.normalize(), chord.norm()), null);
  assert.equal(clearBowTrajectory(trajectory, raycast), false);
  assert.equal(
    clearBowTrajectory(trajectory, () => null),
    true,
  );
});
