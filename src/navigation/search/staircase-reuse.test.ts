import { exactBlockGoal } from "../goals/index.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovementPolicy } from "../movements/policy.js";
import { MemoryWorld } from "../world/memory-world.js";
import { IncrementalSearch, type SearchUpdate } from "./search.js";
import type { Goal, ResolvedGoal } from "../goals/goal.js";
import assert from "node:assert/strict";
import test from "node:test";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";

/**
 * Solid rock with one diagonal staircase already cut through it: tread `i`
 * has its feet at (i, 64 - i, 0) with three open cells above the floor, the
 * shape every descent leaves behind. Observed live on 2026-09-04: from the top
 * tread the planner dug the floor out from under every tread instead of
 * walking the free staircase, once three blocks beneath an older staircase
 * and once one block beneath its own.
 */
function activeGoal(goal: Goal, from: { x: number; y: number; z: number }): Extract<ResolvedGoal, { kind: "active" }> {
  const resolved = goal.resolve(observation(from.x, from.y, from.z));
  if (resolved.kind !== "active") throw new Error(resolved.observation);
  return resolved;
}

function rockWithStaircase(treads: number): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -3; x <= treads + 3; x += 1)
    for (let z = -3; z <= 3; z += 1)
      for (let y = 64 - treads - 4; y <= 68; y += 1) world.load({ x, y, z }, { stateId: 1 });
  for (let i = 0; i <= treads; i += 1) {
    const feetY = 64 - i;
    for (let dy = 0; dy <= 2; dy += 1) world.load({ x: i, y: feetY + dy, z: 0 }, { stateId: 0 });
  }
  return world;
}

/** Cobblestone in the pockets: every placement edge is on offer, which is the live case. */
const CARRIED_SCAFFOLD = { scaffold: { itemType: 35, stateId: 14 }, remainingScaffolds: 207 } as const;

function planDown(
  world: MemoryWorld,
  treads: number,
  budget: { maximumExpansions: number },
  pockets: { scaffold: { itemType: number; stateId: number } | null; remainingScaffolds: number },
): SearchUpdate {
  const search = new IncrementalSearch({
    id: "staircase-reuse",
    start: planningStart({ x: 0, y: 64, z: 0 }, pockets.remainingScaffolds),
    goal: activeGoal(exactBlockGoal({ x: treads, y: 64 - treads, z: 0 }), { x: 0, y: 64, z: 0 }),
    now: () => 0,
    context: {
      world,
      policy: createMovementPolicy({ scaffold: pockets.scaffold }),
      player: WELL_FED,
      catalogue: createMovementCatalogue(),
    },
  });
  let update = search.advance(budget);
  while (update.kind === "progress") update = search.advance(budget);
  return update;
}

for (const [pockets, label] of [
  [{ scaffold: null, remainingScaffolds: 0 }, "empty-handed"],
  [CARRIED_SCAFFOLD, "carrying cobblestone"],
] as const) {
  test(`an existing staircase is walked, not dug out from underneath, ${label}`, () => {
    const treads = 8;
    const result = planDown(rockWithStaircase(treads), treads, { maximumExpansions: 50_000 }, pockets);
    assert.equal(result.kind, "complete", JSON.stringify(result).slice(0, 400));
    if (result.kind !== "complete") return;
    const breaks = result.plan.steps.flatMap((step) =>
      step.operations.filter((operation) => operation.kind === "break").map((operation) => operation.position),
    );
    const treadsWalked = result.plan.steps.map((step) => `${step.to.x},${step.to.y},${step.to.z}:${step.kind}`);
    assert.deepEqual(breaks, [], `dug ${JSON.stringify(breaks)} along ${treadsWalked.join(" ")}`);
    assert.equal(result.plan.steps.length, treads);
  });
}

// ── Replay of the live geometry ─────────────────────────────────────────────────────────

import { nearGoal } from "../goals/index.js";
import { DEFAULT_SEARCH_LIMITS } from "../navigate.js";
import { STAIRCASE_REGION } from "./fixtures/staircase-region.js";

function regionWorld(): MemoryWorld {
  const world = new MemoryWorld();
  for (const line of STAIRCASE_REGION.layers.split("\n")) {
    const [yText, rows] = line.split("|");
    const y = Number(yText);
    rows!.split("/").forEach((row, zi) => {
      [...row].forEach((ch, xi) => {
        const cell = { x: STAIRCASE_REGION.x0 + xi, y, z: STAIRCASE_REGION.z0 + zi };
        if (ch === ".") world.load(cell, { stateId: 0 });
        else if (ch === "w")
          world.load(cell, {
            stateId: 3,
            collisionShapes: [],
            traits: { empty: true, liquid: "water", liquidSource: true, safeToBreak: false },
          });
        else if (ch === "l")
          world.load(cell, {
            stateId: 4,
            collisionShapes: [],
            traits: { empty: true, liquid: "lava", liquidSource: true, safeToBreak: false, damaging: true },
          });
        else world.load(cell, { stateId: 1 });
      });
    });
  }
  return world;
}

/** The live policy's prices: a diamond pickaxe on deepslate plus the terrain break penalty, cobblestone carried. */
const livePrices = createMovementPolicy({
  scaffold: CARRIED_SCAFFOLD.scaffold,
  placementPenalty: 20,
  evaluateBreak: (block) => ({
    decision:
      block.kind === "loaded" && block.traits.safeToBreak
        ? { kind: "penalized", reason: "prefer a route that preserves terrain", cost: 25 }
        : { kind: "prohibited", reason: "not safe to break" },
    tool: { itemType: null, expectedTicks: 11 },
  }),
});

function describe(update: SearchUpdate): string {
  if (update.kind !== "complete" && update.kind !== "segment_ready") return JSON.stringify(update).slice(0, 300);
  const steps = update.plan.steps.map((step) => {
    const digs = step.operations.filter((operation) => operation.kind === "break").length;
    return `${step.to.x},${step.to.y},${step.to.z}:${step.kind}${digs ? `+${digs}dig` : ""}`;
  });
  const digs = update.plan.steps.reduce(
    (n, step) => n + step.operations.filter((operation) => operation.kind === "break").length,
    0,
  );
  return `${update.kind} cost=${update.plan.totalCost} steps=${steps.length} digs=${digs}\n  ${steps.join(" ")}`;
}

function replay(limits: typeof DEFAULT_SEARCH_LIMITS | undefined): SearchUpdate {
  const search = new IncrementalSearch({
    id: "live-replay",
    start: planningStart({ x: 96, y: -32, z: 95 }, CARRIED_SCAFFOLD.remainingScaffolds),
    goal: activeGoal(nearGoal({ x: 87, y: -53, z: 99 }, 1), { x: 96, y: -32, z: 95 }),
    ...(limits && { limits }),
    now: () => performance.now(),
    context: { world: regionWorld(), policy: livePrices, player: WELL_FED, catalogue: createMovementCatalogue() },
  });
  let update = search.advance();
  while (update.kind === "progress") update = search.advance();
  return update;
}

test("live replay: the descent from 96,-32,95 walks the existing staircases", () => {
  const unbounded = replay(undefined);
  const bounded = replay(DEFAULT_SEARCH_LIMITS);
  for (const update of [unbounded, bounded]) {
    assert.ok(update.kind === "complete" || update.kind === "segment_ready", describe(update));
    if (update.kind !== "complete" && update.kind !== "segment_ready") return;
    const digs = update.plan.steps.reduce(
      (n, step) => n + step.operations.filter((operation) => operation.kind === "break").length,
      0,
    );
    assert.equal(digs, 0, describe(update));
  }
});
