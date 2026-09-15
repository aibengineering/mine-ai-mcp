import assert from "node:assert/strict";
import test from "node:test";
import { assessBowWindow } from "./bow-window.js";
import type { observeProjectileDefence } from "./shield-facing.js";

function forecast(ticks: number, name = "arrow") {
  return { projectiles: [{ entity: { id: 7, name }, impactInTicks: ticks }],
    windupForecasts: [], holdRemainingTicks: 0 } as unknown as NonNullable<ReturnType<typeof observeProjectileDefence>>;
}

test("a shooting window includes shield readiness, turning and margin after release", () => {
  assert.equal(assessBowWindow(forecast(30), 20).safe, false);
  assert.equal(assessBowWindow(forecast(31), 20).safe, true);
  assert.equal(assessBowWindow(forecast(10), 0).safe, false);
  assert.equal(assessBowWindow(forecast(11), 0).safe, true);
});

test("new threats and held collisions close the window; accelerating fireballs stay conservative", () => {
  const defence = forecast(50);
  defence.windupForecasts.push({ entity: { id: 8 }, impactInTicks: 4, releaseInTicks: null } as typeof defence.windupForecasts[number]);
  assert.equal(assessBowWindow(defence, 5).threatId, 8);
  assert.equal(assessBowWindow(defence, 5).safe, false);
  assert.equal(assessBowWindow({ ...forecast(50), holdRemainingTicks: 1 }, 0).safe, false);
  assert.equal(assessBowWindow(forecast(50, "small_fireball"), 0).safe, false);
  assert.equal(assessBowWindow(null, 20, true).safe, false);
  assert.equal(assessBowWindow(null, 20).safe, true);
});
