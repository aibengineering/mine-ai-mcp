import assert from "node:assert/strict";
import test from "node:test";
import { observation, flatWorld, planningStart, WELL_FED } from "../../test-support/navigation.js";
import { createMovementPolicy } from "../movements/policy.js";
import { excavateGoal } from "./excavate.js";
import { MemoryWorld as GoalTestWorld } from "../world/memory-world.js";
import type { NavigationObservation, Position3 } from "../world/world.js";
import type { ResolvedGoal } from "./goal.js";
import {
  DESCENT_TICKS_PER_BLOCK,
  HORIZONTAL_TICKS_PER_BLOCK,
  anyGoal,
  exactBlockGoal,
  itemPickupGoal,
  nearEntityGoal,
  nearGoal,
} from "./index.js";

const goalTestWorld = new GoalTestWorld();

test("stationary excavation chooses a stable stance instead of digging a dry target from a current", () => {
  const world = flatWorld();
  const target = { x: 1, y: 64, z: 0 };
  world.load(target, { stateId: 1 });
  const goal = excavateGoal(target).resolve(observation());
  if (goal.kind !== "active") throw new Error("Expected an excavation goal");
  const state = planningStart({ x: 0, y: 63, z: 0 });
  const context = { world, policy: createMovementPolicy(), player: WELL_FED };
  const dig = { submergedAtEyes: false, onGround: true, aquaAffinity: false, effects: {} };
  assert.ok(goal.finish?.(state, context, dig));
  world.load(state.node.feet, { stateId: 2, collisionShapes: [], traits: { empty: true, liquid: "water", liquidSource: false } });
  assert.equal(goal.finish?.(state, context, dig), null);
  world.load(state.node.feet, { stateId: 2, collisionShapes: [], traits: { empty: true, liquid: "water", liquidSource: true } });
  assert.ok(goal.finish?.(state, context, dig));
});

/** One observed body, id 7, seen from `from`. */
function watching(
  from: Position3,
  body: { position: Position3; width: number; height: number },
): NavigationObservation {
  return { ...observation(), position: from, entities: new Map([[7, { id: 7, ...body }]]) };
}

function node(feet: Position3) {
  return { feet, remainingScaffolds: 0, overlayId: "overlay:0" };
}

function active(goal: ResolvedGoal): Extract<ResolvedGoal, { kind: "active" }> {
  if (goal.kind !== "active") throw new Error(`The goal resolved as invalid: ${goal.observation}`);
  return goal;
}

test("goal constructors preserve satisfaction and admissible distance", () => {
  const at = node({ x: 2, y: 63, z: 0 });
  const exact = active(exactBlockGoal({ x: 2, y: 63, z: 0 }).resolve(observation()));
  const near = active(nearGoal({ x: 4, y: 63, z: 0 }, 2).resolve(observation()));

  assert.equal(exact.isSatisfied(at, goalTestWorld), true);
  assert.equal(exact.heuristic(at), 0);
  assert.equal(near.isSatisfied(at, goalTestWorld), true);
  // A satisfied goal must estimate zero. A positive estimate at a node that
  // already answers the goal lets A* defer a destination it has reached.
  assert.equal(near.heuristic(at), 0);
});

/**
 * Contact is physical: the goal compares the bot's real body, standing where
 * the observation says it stands, against the entity's real box. Cell centres
 * are not close enough to either to answer it.
 */
const CONTACT = [
  {
    name: "an adjacent stance inside the requested distance",
    from: { x: 0.5, y: 63, z: 0.5 },
    body: { position: { x: 6.5, y: 62.0, z: 5.5 }, width: 0.25, height: 0.25 },
    distance: 1.5,
    satisfied: [{ x: 5, y: 63, z: 5 }],
    unsatisfied: [
      { x: 8, y: 62, z: 5 },
      { x: 6, y: 66, z: 5 },
    ],
  },
  {
    name: "a cow inside eight cells but outside eight physical blocks",
    from: { x: 0.5, y: 63, z: 0.5 },
    body: { position: { x: 8.9, y: 63, z: 0.5 }, width: 0.9, height: 1.4 },
    distance: 8,
    satisfied: [{ x: 1, y: 63, z: 0 }],
    unsatisfied: [{ x: 0, y: 63, z: 0 }],
  },
  {
    name: "a body standing on a lowered floor, whose feet are below the cell it occupies",
    from: { x: 0.1, y: 62.875, z: 0.5 },
    body: { position: { x: 8.4, y: 63, z: 0.5 }, width: 0.9, height: 1.4 },
    distance: 8,
    satisfied: [],
    unsatisfied: [{ x: 0, y: 63, z: 0 }],
  },
  {
    name: "melee ground below a target whose elevated feet are still in swing range",
    from: { x: 0.5, y: 63, z: 0.5 },
    body: { position: { x: 8.5, y: 65.7, z: 0.5 }, width: 0.6, height: 1.8 },
    distance: 3,
    satisfied: [{ x: 8, y: 63, z: 0 }],
    unsatisfied: [{ x: 6, y: 63, z: 0 }],
  },
  {
    name: "a target lifted out of swing range above the same ground",
    from: { x: 0.5, y: 63, z: 0.5 },
    body: { position: { x: 8.5, y: 66.1, z: 0.5 }, width: 0.6, height: 1.8 },
    distance: 3,
    satisfied: [],
    unsatisfied: [{ x: 8, y: 63, z: 0 }],
  },
  {
    name: "the bot's own cell, which is in range only when the body is",
    from: { x: 0.1, y: 63, z: 0.5 },
    body: { position: { x: 3.4, y: 63, z: 0.5 }, width: 0.6, height: 1.8 },
    distance: 3,
    satisfied: [{ x: 1, y: 63, z: 0 }],
    unsatisfied: [{ x: 0, y: 63, z: 0 }],
  },
] as const;

test("entity contact is decided by the two physical bodies, not by their cell centres", () => {
  for (const row of CONTACT) {
    const goal = active(nearEntityGoal({ id: 7 }, row.distance).resolve(watching(row.from, row.body)));
    for (const feet of row.satisfied) {
      const where = `${row.name}: ${JSON.stringify(feet)}`;
      assert.equal(goal.isSatisfied(node(feet), goalTestWorld), true, `${where} must be contact`);
      assert.equal(goal.heuristic(node(feet)), 0, `${where} answers the goal and must estimate zero`);
    }
    for (const feet of row.unsatisfied)
      assert.equal(
        goal.isSatisfied(node(feet), goalTestWorld),
        false,
        `${row.name}: ${JSON.stringify(feet)} must not be contact`,
      );
  }
});

test("hunting a surface cow from a cave credits climbing toward its height", () => {
  // Run 16: the hunt stopped at y10 beneath cows at y64. Horizontal-only
  // estimates were zero throughout the column, leaving no partial-route progress.
  const observed = watching(
    { x: 33.5, y: 10, z: -44.5 },
    {
      position: { x: 33.5, y: 64, z: -44.5 },
      width: 0.9,
      height: 1.4,
    },
  );
  const goal = active(nearEntityGoal({ id: 7 }, 8).resolve(observed));
  const inColumn = (y: number) => node({ x: 33, y, z: -45 });

  assert.ok(goal.heuristic(inColumn(10)) > goal.heuristic(inColumn(20)));
  assert.ok(goal.heuristic(inColumn(20)) > goal.heuristic(inColumn(56)));
  assert.equal(goal.isSatisfied(inColumn(10), goalTestWorld), false);
  assert.equal(goal.isSatisfied(inColumn(56), goalTestWorld), true);
  assert.equal(goal.heuristic(inColumn(56)), 0);
});

test("an item goal's estimate falls onto the drop and never rewards climbing above it", () => {
  const drop = { position: { x: 6.5, y: 62.06, z: 5.5 }, width: 0.25, height: 0.25 };
  const snapshot = active(itemPickupGoal({ id: 7 }).resolve(watching(observation().position, drop)));
  const estimate = (x: number, y: number, z: number) => snapshot.heuristic(node({ x, y, z }));

  assert.ok(estimate(2, 62, 5) > estimate(4, 62, 5));
  assert.ok(estimate(4, 62, 5) > estimate(5, 62, 5));
  assert.equal(estimate(6, 62, 5), 0);

  // Baritone charges more per block of descent than of sprinting, so the column
  // over a lower target is not the cheapest place to be. Pricing descent below
  // horizontal inverts that, and collection followed the inversion one step up
  // onto a canopy it could not climb back down from.
  const lower = active(
    itemPickupGoal({ id: 7 }).resolve(
      watching(observation().position, { ...drop, position: { x: 6.5, y: 60.06, z: 8.5 } }),
    ),
  );
  const beside = lower.heuristic(node({ x: 6, y: 62, z: 9 }));
  const above = lower.heuristic(node({ x: 6, y: 63, z: 8 }));
  assert.ok(above > beside, `climbing to ${above} must not beat staying at ${beside}`);
  assert.ok(DESCENT_TICKS_PER_BLOCK > HORIZONTAL_TICKS_PER_BLOCK);
});

test("an item goal accepts the cell the pickup volume actually reaches", () => {
  // Vanilla grows the player's box by about half a block downward and two
  // upward before collecting, so an item one cell above the feet is inside it
  // and one cell below is not. Hovering over a drop must therefore stay
  // unsatisfied, or the route stops one cell short of the handover.
  const snapshot = active(
    itemPickupGoal({ id: 7 }).resolve(
      watching(observation().position, { position: { x: 6.5, y: 62.06, z: 5.5 }, width: 0.25, height: 0.25 }),
    ),
  );
  const at = (x: number, y: number, z: number) => snapshot.isSatisfied(node({ x, y, z }), goalTestWorld);

  assert.equal(at(6, 62, 5), true);
  assert.equal(at(6, 61, 5), true);
  assert.equal(at(6, 63, 5), false);
  assert.equal(at(5, 62, 5), false);
  assert.equal(at(6, 62, 6), false);
  assert.equal(at(4, 62, 5), false);
});

test("an adjacent drop stops routing only when the actual body is in pickup reach", () => {
  const drop = { position: { x: 1.9, y: 64, z: 0.5 }, width: 0.25, height: 0.25 };
  const goal = itemPickupGoal({ id: 7 });
  const touching = active(goal.resolve(watching({ x: 0.8, y: 63, z: 0.5 }, drop)));
  const outside = active(goal.resolve(watching({ x: 0.1, y: 63, z: 0.5 }, drop)));
  const feet = node({ x: 0, y: 63, z: 0 });

  assert.equal(touching.isSatisfied(feet, goalTestWorld), true);
  assert.equal(outside.isSatisfied(feet, goalTestWorld), false);
  assert.notEqual(touching.revision, outside.revision);
});

test("a resolved goal names the entities it can still see, and one that needs a vanished entity is invalid", () => {
  const withOneItem: NavigationObservation = {
    ...observation(),
    entities: new Map([[8, { id: 8, position: { x: 4.5, y: 63, z: 0.5 }, width: 0.25, height: 0.25 }]]),
  };
  const composite = active(anyGoal([itemPickupGoal({ id: 7 }), itemPickupGoal({ id: 8 })]).resolve(withOneItem));
  assert.match(composite.revision, /entity:8/);
  assert.doesNotMatch(composite.revision, /entity:7/);

  // Collection and despawn look identical from here: the entity is simply no
  // longer observed. Reporting `active` would leave the route chasing a goal
  // that can never be satisfied until its deadline expires.
  assert.equal(nearEntityGoal({ id: 7 }, 1.5).resolve(observation()).kind, "invalid");
});
