import assert from "node:assert/strict";
import test from "node:test";
import { ScriptedBlaze } from "../../test-support/scripted-blaze.js";

test("a blocked charge outlives a volley guard, and reopening sight releases its overdue shot", () => {
  const blaze = new ScriptedBlaze();
  assert.equal(blaze.tick(true), "charge");
  for (let tick = 0; tick < 100; tick++) assert.equal(blaze.tick(false), null);
  assert.equal(blaze.charging, true);
  assert.equal(blaze.shots, 0);
  assert.equal(blaze.tick(true), "shot");
});

test("an unobstructed blaze has three shots six ticks apart followed by a hundred-tick rest", () => {
  const blaze = new ScriptedBlaze();
  const events: [number, string][] = [];
  for (let tick = 0; tick <= 178; tick++) {
    const event = blaze.tick(true);
    if (event) events.push([tick, event]);
  }
  assert.deepEqual(events, [
    [0, "charge"],
    [60, "shot"],
    [66, "shot"],
    [72, "shot"],
    [78, "rest"],
    [178, "charge"],
  ]);
});
