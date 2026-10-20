import assert from "node:assert/strict";
import test from "node:test";
import { needsFood } from "./environment.js";

test("a badly wounded bot with spent saturation eats while hunger has room", () => {
  // Recorded in combat-proof4 2026-10-20T21-00-20-800Z: the Burning pen at
  // hunger 19 with no saturation, burning a point a second while slow
  // regeneration returned one every four, 4.73 health and falling. Eating
  // refills hunger and saturation, and with both the bot heals a point every
  // half second.
  assert.equal(needsFood(4.73, 19, 0), true);
  assert.equal(needsFood(4.73, 20, 0), false, "a full bar cannot be eaten into");
  assert.equal(needsFood(15, 19, 0), false, "a lightly wounded bot keeps its food");
});
