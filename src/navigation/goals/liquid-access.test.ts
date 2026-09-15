import assert from "node:assert/strict";
import test from "node:test";
import { flatWorld, observation, planningStart, WELL_FED } from "../../test-support/navigation.js";
import { liquidAccessGoal, canAccessLiquid } from "./liquid-access.js";
import { anyGoal } from "./index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovementPolicy } from "../movements/policy.js";
import { MemoryWorld } from "../world/memory-world.js";
import { IncrementalSearch } from "../search/search.js";

const source = { x: 3, y: 62, z: 0 };
const lid = { ...source, y: 63 };
const dry = { submergedAtEyes: false, onGround: true, aquaAffinity: false, effects: {} };

function pocket() {
  const world = flatWorld();
  world.load(source, {
    stateId: 80,
    collisionShapes: [],
    traits: { empty: true, liquid: "water", liquidSource: true },
  });
  world.load(lid, { stateId: 1 });
  const goal = liquidAccessGoal([source], "water").resolve(observation());
  if (goal.kind !== "active") throw new Error("Expected an active liquid goal.");
  return { world, state: planningStart({ x: 0, y: 63, z: 0 }), goal };
}

test("a liquid goal and its composite see predicted excavation without changing the observed world", () => {
  const { world, state, goal } = pocket();
  const opened = state.overlay.apply({ kind: "break", position: lid, stateId: 0 });
  assert.equal(goal.isSatisfied(state.node, world), false);
  assert.equal(goal.isSatisfied(state.node, opened.view(world)), true);
  const composite = anyGoal([liquidAccessGoal([source], "water")]).resolve(observation());
  assert.equal(composite.kind === "active" && composite.isSatisfied(state.node, opened.view(world)), true);
  const cover = world.blockAt(lid.x, lid.y, lid.z);
  assert.equal(cover.kind === "loaded" && cover.geometry.solid, true);
});

test("terminal excavation clears successive sightline obstructions and keeps its own support", () => {
  const { world, state, goal } = pocket();
  world.load({ x: 1, y: 64, z: 0 }, { stateId: 1 });
  world.load({ x: 2, y: 63, z: 0 }, { stateId: 1 });
  const finish = goal.finish?.(state, { world, policy: createMovementPolicy(), player: WELL_FED }, dry);
  assert.ok(finish);
  const breaks = finish.step.operations.filter((op) => op.kind === "break");
  assert.ok(breaks.length >= 3);
  assert.ok(breaks.some((op) => op.position.x === lid.x && op.position.y === lid.y));
  assert.ok(breaks.every((op) => !(op.position.x === 0 && op.position.z === 0 && op.position.y < 63)));
  assert.equal(goal.isSatisfied(finish.state.node, finish.state.overlay.view(world)), true);
  assert.equal(goal.isSatisfied(state.node, world), false);
  assert.ok(finish.cost > 0);
});

test("terminal access work refuses disabled digging, its own floor, and a source out of the actual reach", () => {
  const { world, state, goal } = pocket();
  const context = (policy = createMovementPolicy()) => ({ world, policy, player: WELL_FED });
  assert.equal(goal.finish?.(state, context(createMovementPolicy({ allowDigging: false })), dry), null);

  const underfoot = { x: 0, y: 61, z: 0 };
  world.load(underfoot, {
    stateId: 80,
    collisionShapes: [],
    traits: { empty: true, liquid: "water", liquidSource: true },
  });
  const underGoal = liquidAccessGoal([underfoot], "water").resolve(observation());
  if (underGoal.kind !== "active") throw new Error("Expected active goal.");
  assert.equal(underGoal.finish?.(state, context(), dry), null);

  // The stance is judged where the body actually stands, not from the centre
  // of the cell it occupies.
  const distant = { x: 4, y: 62, z: 0 };
  world.load(distant, {
    stateId: 80,
    collisionShapes: [],
    traits: { empty: true, liquid: "water", liquidSource: true },
  });
  world.load(lid, { stateId: 0 });
  const offCentre = liquidAccessGoal([distant], "water").resolve({
    ...observation(),
    position: { x: 0.1, y: 63, z: 0.5 },
  });
  if (offCentre.kind !== "active") throw new Error("Expected active goal.");
  assert.equal(offCentre.isSatisfied(state.node, world), false);
  assert.equal(offCentre.finish?.(state, context(), dry), null);
});

test("dry access rejects wet plants, unsupported feet, and a source changed since discovery", () => {
  const { world } = pocket();
  world.load(lid, { stateId: 0 });
  const position = observation().position;
  assert.equal(canAccessLiquid(world, position, source, "water"), true);
  world.load({ x: 0, y: 63, z: 0 }, { stateId: 90, collisionShapes: [], traits: { empty: true, waterlogged: true } });
  assert.equal(canAccessLiquid(world, position, source, "water"), false);
  world.load({ x: 0, y: 63, z: 0 }, { stateId: 0 });
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 0 });
  assert.equal(canAccessLiquid(world, position, source, "water"), false);
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 1 });
  world.load(source, { stateId: 0 });
  assert.equal(canAccessLiquid(world, position, source, "water"), false);
});

test("the bucket ray names the liquid it wants, stops at an intervening source, and reaches one poured at feet level", () => {
  const { world } = pocket();
  const eyes = observation().position;
  world.load(lid, { stateId: 0 });
  world.load(source, { stateId: 90, collisionShapes: [], traits: { empty: true, liquid: "lava", liquidSource: true } });
  assert.equal(canAccessLiquid(world, eyes, source, "lava"), true);
  assert.equal(canAccessLiquid(world, eyes, source, "water"), false);
  world.load(
    { x: 2, y: 63, z: 0 },
    { stateId: 80, collisionShapes: [], traits: { empty: true, liquid: "water", liquidSource: true } },
  );
  assert.equal(canAccessLiquid(world, eyes, source, "lava"), false);

  // Poured water sits at the bot's own feet level, with the eyes above it.
  const poured = { x: 3, y: 63, z: 0 };
  world.load(poured, {
    stateId: 80,
    collisionShapes: [],
    traits: { empty: true, liquid: "water", liquidSource: true },
  });
  assert.equal(canAccessLiquid(world, eyes, poured, "water"), true);
});

test("search completes a liquid approach against the excavation overlay", () => {
  const { state, goal } = pocket();
  const world = new MemoryWorld();
  for (let x = 0; x <= 3; x++) for (let y = 62; y <= 65; y++) world.load({ x, y, z: 0 }, { stateId: y === 62 ? 1 : 0 });
  world.load(source, {
    stateId: 80,
    collisionShapes: [],
    traits: { empty: true, liquid: "water", liquidSource: true },
  });
  // Force travel to clear the lid; this exercises search's satisfaction
  // predicate independently of the terminal-excavation shortcut.
  const { finish: _finish, ...visibilityGoal } = goal;
  for (let x = 1; x <= 2; x++) {
    world.load({ x, y: 63, z: 0 }, { stateId: 1 });
    world.load({ x, y: 64, z: 0 }, { stateId: 1 });
  }
  const result = new IncrementalSearch({
    id: "liquid-overlay",
    start: state,
    goal: visibilityGoal,
    context: { world, policy: createMovementPolicy(), player: WELL_FED, catalogue: createMovementCatalogue() },
  }).advance({ maximumMilliseconds: Infinity });
  assert.equal(result.kind, "complete");
  if (result.kind !== "complete") throw new Error("Expected complete route.");
  let overlay = state.overlay;
  for (const step of result.plan.steps) for (const effect of step.effects) overlay = overlay.apply(effect);
  assert.equal(goal.isSatisfied(result.plan.endNode, overlay.view(world)), true);
  assert.equal(goal.isSatisfied(result.plan.endNode, world), false);
});
