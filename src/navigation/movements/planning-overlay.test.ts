import { OverlayInterner, PlanningOverlay } from "./planning-overlay.js";
import assert from "node:assert/strict";
import test from "node:test";

test("equivalent overlay results share identity independent of edit order", () => {
  const interner = new OverlayInterner();
  const root = new PlanningOverlay(interner);
  const first = root
    .apply({ kind: "place", position: { x: 1, y: 2, z: 3 }, stateId: 4 })
    .apply({ kind: "break", position: { x: 2, y: 2, z: 3 }, stateId: 0 });
  const second = root
    .apply({ kind: "break", position: { x: 2, y: 2, z: 3 }, stateId: 0 })
    .apply({ kind: "place", position: { x: 1, y: 2, z: 3 }, stateId: 4 });
  assert.equal(first.identity, second.identity);
});
