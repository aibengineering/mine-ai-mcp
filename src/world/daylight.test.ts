import assert from "node:assert/strict";
import test from "node:test";
import { dayPhase, isBedSleepTime, ticksToMinutes, ticksUntilDay, ticksUntilNight } from "./daylight.js";

test("night is exactly the window in which a bed accepts the bot", () => {
  assert.equal(isBedSleepTime(12541), false);
  assert.equal(isBedSleepTime(12542), true);
  assert.equal(isBedSleepTime(23458), true);
  assert.equal(isBedSleepTime(23459), false);
  assert.equal(dayPhase(6000), "day");
  assert.equal(dayPhase(18000), "night");
});

test("counts ticks to the next phase change from either side of it", () => {
  assert.equal(ticksUntilNight(6000), 6542);
  assert.equal(ticksUntilNight(23600), 12942);
  assert.equal(ticksUntilNight(18000), 0);
  assert.equal(ticksUntilDay(18000), 5459);
  assert.equal(ticksUntilDay(6000), 0);
  assert.equal(ticksToMinutes(1200), 1);
});
