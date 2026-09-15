import { MemoryWorld as GoalTestWorld } from "../world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import type { PlanningNode } from "./goal.js";
import type { NavigationObservation } from "../world/world.js";
import { safeFromEntitiesGoal } from "./index.js";
import { observation } from "../../test-support/navigation.js";

const goalTestWorld = new GoalTestWorld();

/** The bot at the origin, watching threat 7 at `entityX`; nothing observed when it is absent. */
function watching(entityX?: number): NavigationObservation {
  return {
    ...observation(0, 0, 0),
    position: { x: 0, y: 0, z: 0 },
    entities:
      entityX === undefined
        ? new Map()
        : new Map([[7, { id: 7, position: { x: entityX, y: 0, z: 0 }, width: 0.6, height: 1.8 }]]),
  };
}

function node(x: number): PlanningNode {
  return { feet: { x, y: 0, z: 0 }, remainingScaffolds: 0, overlayId: "test" };
}

test("safe-from-entities grades the distance still owed and follows the threat it can see", () => {
  const goal = safeFromEntitiesGoal([{ id: 7, position: { x: 0, y: 0, z: 0 } }], 16);
  const first = goal.resolve(watching(0));
  const moved = goal.resolve(watching(1));
  assert.equal(first.kind, "active");
  assert.equal(moved.kind, "active");
  if (first.kind !== "active") return;

  assert.equal(first.heuristic(node(5)), 44);
  assert.equal(first.isSatisfied(node(16), goalTestWorld), true);
  assert.equal(first.isSatisfied(node(15), goalTestWorld), false);
  assert.notEqual(first.revision, moved.revision);

  // The blocked-retreat scenario lost its creeper to an explosion. Navigation
  // must still satisfy the same last-observed separation checked by survival.
  const gone = goal.resolve(watching());
  assert.equal(gone.kind, "active");
  if (gone.kind !== "active") return;
  assert.equal(gone.isSatisfied(node(0), goalTestWorld), false);
  assert.equal(gone.isSatisfied(node(16), goalTestWorld), true);
});
