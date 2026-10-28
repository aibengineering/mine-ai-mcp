import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "./memory-world.js";
import { admitsDive, holdSwimDepth, openWaterSurface, risingSurface, swimTravelTicks, type DiveAdmission } from "./swimming.js";
import { createMovementPolicy } from "../movements/policy.js";
import { WELL_FED, observation, planningStart } from "../../test-support/navigation.js";
import type { ResolvedGoal } from "../goals/goal.js";
import { headOutOfLiquidGoal } from "../goals/index.js";
import { IncrementalSearch } from "../search/search.js";
import { createMovementCatalogue } from "../movements/catalogue.js";

function pool() {
  const world = new MemoryWorld();
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = 58; y <= 65; y++)
    world.load({ x, y, z }, y === 58 ? { stateId: 1 } : y <= 63
      ? { stateId: 2, traits: { empty: true, liquid: "water", liquidSource: true, safeToBreak: false } }
      : { stateId: 0 });
  return world;
}

test("open-water admission accounts for the slow descent, work and escape; a roof/current is not a surface", () => {
  const world = pool();
  const read = (x: number, y: number, z: number) => world.blockAt(x, y, z);
  const feet = { x: 0, y: 61, z: 0 };
  assert.deepEqual(openWaterSurface(read, feet), { x: 0, y: 63, z: 0 });
  assert.ok(admitsDive(read, feet, { origin: { ...feet, y: 63 }, airTicks: 300 }, 75));
  assert.equal(admitsDive(read, feet, { origin: { ...feet, y: 63 }, airTicks: 120 }, 75), false);
  assert.equal(admitsDive(read, { ...feet, y: 59 }, { origin: { ...feet, y: 63 }, airTicks: 300 }, 75), false);
  world.load({ x: 0, y: 64, z: 0 }, { stateId: 1 });
  assert.equal(openWaterSurface(read, feet), null);
  world.load({ x: 0, y: 64, z: 0 }, { stateId: 0 });
  world.load({ x: 0, y: 62, z: 0 }, { stateId: 3, traits: { empty: true, liquid: "water", liquidSource: false } });
  assert.equal(openWaterSurface(read, feet), null);
  assert.equal(openWaterSurface(read, { x: 12, y: 61, z: 0 }), null);
});

test("vertical water edges require scoped air admission and retain asymmetric travel cost", () => {
  const world = pool();
  const feet = { x: 0, y: 62, z: 0 };
  const generate = (air?: number) => createMovementCatalogue().generate(planningStart(feet), {
    world, player: WELL_FED, policy: createMovementPolicy({
      allowDigging: false, allowPlacing: false,
      ...(air === undefined ? {} : { dive: { origin: feet, airTicks: air } }),
    }),
  }, { submergedAtEyes: true, onGround: false, aquaAffinity: false, effects: {} }).toArray();
  assert.equal(generate().some(({ to }) => to.y === 61), false);
  const edges = generate(300);
  const down = edges.find(({ to }) => to.x === 0 && to.y === 61 && to.z === 0);
  const up = edges.find(({ to }) => to.x === 0 && to.y === 63 && to.z === 0);
  assert.ok(down && up);
  assert.ok(down.cost > up.cost);
  assert.equal(generate(30).some(({ to }) => to.y === 61), false);
  assert.equal(edges.some(({ step }) => step.kind === "drop"), false, "liquid descent must not use a land-priced fall");
});

test("a newly dug pickup hole retains its verified ascent as air becomes flowing water", () => {
  const world = pool();
  const read = (x: number, y: number, z: number) => world.blockAt(x, y, z);
  const hole = { x: 0, y: 59, z: 0 };
  world.load(hole, { stateId: 0 });
  assert.deepEqual(openWaterSurface(read, hole), { x: 0, y: 63, z: 0 });
  world.load(hole, { stateId: 3, traits: { empty: true, liquid: "water", liquidSource: false } });
  assert.deepEqual(openWaterSurface(read, hole), { x: 0, y: 63, z: 0 });
  world.load(hole, { stateId: 4, traits: { empty: true, waterlogged: true } });
  assert.equal(openWaterSurface(read, hole), null, "a bubble column is not the transient air in a pickup hole");
});

test("depth holding arrests inherited momentum and stays in a band under pinned liquid physics", () => {
  assert.equal(holdSwimDepth(60, -0.025, 60), true);
  assert.equal(holdSwimDepth(60, 0.15, 60), false);
  let y = 60.2;
  let velocity = -0.025;
  let min = y, max = y;
  for (let tick = 0; tick < 200; tick++) {
    if (holdSwimDepth(y, velocity, 60.2)) velocity += 0.04;
    y += velocity;
    velocity = velocity * 0.8 - 0.005;
    min = Math.min(min, y); max = Math.max(max, y);
  }
  assert.ok(max - min < 0.18, `hold varied from ${min} to ${max}`);
  assert.ok(swimTravelTicks({ x: 0, y: 63, z: 0 }, { x: 0, y: 61, z: 0 }) >
    swimTravelTicks({ x: 0, y: 61, z: 0 }, { x: 0, y: 63, z: 0 }));
});

/** PocketSwimmer's room: water three deep under a sealed ceiling, air over its far end. */
function sealedRoom() {
  const world = new MemoryWorld();
  const water = { stateId: 2, traits: { empty: true, liquid: "water" as const, liquidSource: true, safeToBreak: false } };
  for (let x = -1; x <= 9; x++) for (let z = -2; z <= 2; z++) for (let y = 58; y <= 64; y++) {
    const inside = x >= 0 && x <= 8 && z >= -1 && z <= 1;
    world.load({ x, y, z }, inside && y >= 59 && y <= 61 ? water
      : inside && x >= 6 && (y === 62 || y === 63) ? { stateId: 0 } : { stateId: 1 });
  }
  return world;
}

test("a dive whose goal ends in air reaches air a ceiling hides, within its budget and not past it", () => {
  const world = sealedRoom();
  const feet = { x: 0, y: 60, z: 0 };
  const search = (dive: DiveAdmission) => new IncrementalSearch({
    id: "escape",
    start: planningStart(feet),
    goal: headOutOfLiquidGoal().resolve(observation(0.5, 60, 0.5)) as Extract<ResolvedGoal, { kind: "active" }>,
    now: () => 0,
    context: {
      world, player: WELL_FED, catalogue: createMovementCatalogue(),
      policy: createMovementPolicy({ allowDigging: false, allowPlacing: false, dive }),
    },
  }).advance({ maximumMilliseconds: Infinity });
  // A planned dive asks every cell for its own way up; under the ceiling none has one.
  assert.notEqual(search({ origin: feet, airTicks: 300 }).kind, "complete");
  const escape = search({ origin: feet, airTicks: 300, ascent: "goal" });
  assert.equal(escape.kind, "complete");
  if (escape.kind !== "complete") return;
  assert.ok(escape.plan.end.x >= 6 && escape.plan.end.y === 61, `surfaced at ${JSON.stringify(escape.plan.end)}`);
  // Six blocks of swimming is 92 ticks: a 60-tick budget cannot reach the pocket.
  assert.notEqual(search({ origin: feet, airTicks: 60, ascent: "goal" }).kind, "complete");
});

test("a dive whose goal ends in air digs up through a roof it may break; a planned dive does not", () => {
  // SealedDiver's chamber: water three deep under two blocks of stone, air above.
  const world = new MemoryWorld();
  const water = { stateId: 2, traits: { empty: true, liquid: "water" as const, liquidSource: true, safeToBreak: false } };
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) for (let y = 58; y <= 66; y++) {
    const inside = Math.abs(x) <= 2 && Math.abs(z) <= 2;
    world.load({ x, y, z }, inside && y >= 59 && y <= 61 ? water : y >= 64 ? { stateId: 0 } : { stateId: 1 });
  }
  const feet = { x: 0, y: 60, z: 0 };
  const search = (dive?: DiveAdmission) => new IncrementalSearch({
    id: "dig-up",
    start: planningStart(feet),
    goal: headOutOfLiquidGoal().resolve(observation(0.5, 60, 0.5)) as Extract<ResolvedGoal, { kind: "active" }>,
    now: () => 0,
    context: {
      world, player: WELL_FED, catalogue: createMovementCatalogue(),
      policy: createMovementPolicy({
        allowPlacing: false,
        ...(dive && { dive }),
        // The Mineflayer policy's rule: a break beside a water source floods.
        confirmBreak: (_block, { x, y, z }, view) =>
          [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dz]) => {
            const beside = view.blockAt(x + dx!, y, z + dz!);
            return beside.kind === "loaded" && beside.traits.liquidSource;
          })
            ? { kind: "prohibited", reason: "opens into liquid" }
            : { kind: "allowed" },
      }),
    },
  }).advance({ maximumMilliseconds: Infinity });
  assert.notEqual(search().kind, "complete");
  assert.notEqual(search({ origin: feet, airTicks: 400 }).kind, "complete");
  const escape = search({ origin: feet, airTicks: 400, ascent: "goal" });
  assert.equal(escape.kind, "complete");
  if (escape.kind !== "complete") return;
  // One break opens the cell over the surface: the head is in air beneath the second.
  assert.deepEqual(escape.plan.end, { x: 0, y: 61, z: 0 });
  assert.deepEqual(escape.plan.steps.flatMap(({ operations }) => operations.filter(({ kind }) => kind === "break")
    .map((operation) => "position" in operation ? operation.position : null)), [{ x: 0, y: 62, z: 0 }]);
});

test("rising reaches air through flowing water and plants, which a planned dive refuses, but not through a ceiling", () => {
  // cast-obsidian's spawn column: the bot in its own poured bucket, flowing
  // water at its feet and head, air two blocks up.
  const world = new MemoryWorld();
  const read = (x: number, y: number, z: number) => world.blockAt(x, y, z);
  const flowing = { stateId: 3, traits: { empty: true, liquid: "water" as const, liquidSource: false } };
  world.load({ x: 0, y: -50, z: 0 }, flowing);
  world.load({ x: 0, y: -49, z: 0 }, flowing);
  for (let y = -48; y <= -42; y++) world.load({ x: 0, y, z: 0 }, { stateId: 0 });
  const feet = { x: 0, y: -50, z: 0 };
  assert.equal(openWaterSurface(read, feet), null, "planning still asks for still water");
  assert.deepEqual(risingSurface(read, feet), { x: 0, y: -49, z: 0 });
  // Kelp counts as water to rise through.
  world.load({ x: 0, y: -48, z: 0 }, { stateId: 5, traits: { empty: true, waterlogged: true } });
  assert.deepEqual(risingSurface(read, feet), { x: 0, y: -48, z: 0 });
  // A ceiling closes the column.
  world.load({ x: 0, y: -47, z: 0 }, { stateId: 1 });
  assert.equal(risingSurface(read, feet), null);
});
