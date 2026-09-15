import assert from "node:assert/strict";
import test from "node:test";
import { MemoryWorld } from "./memory-world.js";
import { admitsDive, holdSwimDepth, openWaterSurface, swimTravelTicks } from "./swimming.js";
import { createMovementCatalogue } from "../movements/catalogue.js";
import { createMovementPolicy } from "../movements/policy.js";
import { WELL_FED, planningStart } from "../../test-support/navigation.js";

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
