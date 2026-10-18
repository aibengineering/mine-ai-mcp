import assert from "node:assert/strict";
import test from "node:test";
import {
  BREATH_ROOF_AIR,
  BREATH_SURFACE_AIR,
  SURFACE_MAXIMUM_TICKS,
  SURFACE_OPEN_WATER_MAXIMUM_TICKS,
  decideBreathResponse,
  needsBreathResponse,
} from "./environment.js";

test("open water surfaces within one breath, a roof keeps the full budget", () => {
  const open = decideBreathResponse(BREATH_SURFACE_AIR, null);
  assert.equal(open.kind, "respond");
  assert.equal(open.kind === "respond" && open.name, "surface");
  assert.equal(open.kind === "respond" && open.response.airBefore, BREATH_SURFACE_AIR);
  assert.equal(open.kind === "respond" && open.response.maximumTicks, SURFACE_OPEN_WATER_MAXIMUM_TICKS);
  assert.ok(
    SURFACE_OPEN_WATER_MAXIMUM_TICKS < SURFACE_MAXIMUM_TICKS,
    "the open-water cap must be the shorter of the two",
  );

  const roofed = decideBreathResponse(BREATH_ROOF_AIR, "stone");
  assert.equal(roofed.kind === "respond" && roofed.response.maximumTicks, SURFACE_MAXIMUM_TICKS);
});

test("the roof is what decides when the breath response fires", () => {
  assert.equal(needsBreathResponse(BREATH_SURFACE_AIR, null), true);
  assert.equal(needsBreathResponse(BREATH_SURFACE_AIR + 1, null), false);
  assert.equal(needsBreathResponse(BREATH_ROOF_AIR, "stone"), true);
  assert.equal(needsBreathResponse(BREATH_ROOF_AIR + 1, "stone"), false);
  // A roof digs sooner, so the same air that is fine in the open is already a response.
  assert.equal(needsBreathResponse(BREATH_ROOF_AIR, null), false);
});
