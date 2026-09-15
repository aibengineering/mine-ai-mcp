import assert from "node:assert/strict";
import test from "node:test";
import { observation } from "../../test-support/navigation.js";
import { PlanningStall } from "./planning-stall.js";

test("restarts, small jitter and surface bobbing do not renew the twenty-second planning window", () => {
  const stall = new PlanningStall();
  const start = observation();
  stall.begin(start, 0);
  for (let now = 1_000; now < 20_000; now += 1_000) {
    const bob = { ...start, position: { ...start.position, y: start.position.y + (now % 2_000 ? 1.1 : 0) } };
    stall.begin(bob, now);
    assert.equal(stall.check(bob, now), null);
  }
  const failure = stall.check(start, 20_000);
  assert.equal(failure?.kind, "no_progress");
  assert.match(failure && "observation" in failure ? failure.observation : "", /20000 ms/);
});

test("actual displacement renews planning and committed execution consumes none of the next window", () => {
  const stall = new PlanningStall();
  const start = observation();
  stall.begin(start, 0);
  const moved = { ...start, position: { ...start.position, x: start.position.x + 1 } };
  assert.equal(stall.check(moved, 19_999), null);
  assert.equal(stall.check(moved, 30_000), null);
  stall.committed();
  assert.equal(stall.check(moved, 600_000), null, "long execution is not a search stall");
  stall.begin(moved, 600_000);
  assert.equal(stall.check(moved, 619_999), null);
  assert.equal(stall.check(moved, 620_000)?.kind, "no_progress");
});
