import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { CreeperClearance } from "./creepers.js";

test("fuse timing survives repeated reads and only regains the observed unwind time", () => {
  const bot = botFixture({ groundY: 63 });
  const swell = bot.registry.entitiesByName.creeper!.metadataKeys!.indexOf("swell_dir");
  const metadata: unknown[] = [];
  metadata[swell] = -1;
  bot.entities[7] = { id: 7, name: "creeper", width: 0.6, height: 1.7, isValid: true,
    position: bot.entity.position.offset(2, 0, 0), metadata } as typeof bot.entity;
  const clearance = new CreeperClearance(bot);
  const remaining = (tick: number) => clearance.observe(tick, new Set())[0]!.fuseRemainingTicks;
  assert.equal(remaining(0), 30);
  metadata[swell] = 1;
  assert.equal(remaining(23), 7);
  assert.equal(remaining(23), 7);
  metadata[swell] = -1;
  assert.equal(remaining(24), 8, "a stopped swell is not a fresh thirty-tick fuse");
  metadata[swell] = 1;
  assert.equal(remaining(25), 7);
  const firstSeenActive = new CreeperClearance(bot);
  assert.equal(firstSeenActive.observe(25, new Set())[0]!.fuseRemainingTicks, 0);
});

test("clearance survives another target's death and missing creeper observation until separation is sustained", () => {
  const bot = botFixture();
  bot.entity.position.set(0, 64, 0);
  bot.entities[7] = { id: 7, name: "creeper", width: 0.6, height: 1.7, isValid: true, position: new Vec3(3, 64, 0) } as typeof bot.entity;
  const clearance = new CreeperClearance(bot);
  clearance.require(clearance.observe(0, new Set()));
  delete bot.entities[7];
  const dead = new Set([8]);
  for (let tick = 1; tick <= 40; tick++) clearance.observe(tick, dead);
  assert.equal(clearance.pending, true);
  bot.entity.position.x = -10;
  for (let tick = 41; tick < 70; tick++) {
    clearance.observe(tick, dead);
    clearance.observe(tick, dead);
  }
  assert.equal(clearance.pending, true, "multiple reads cannot count as multiple physics ticks");
  clearance.observe(70, dead);
  assert.equal(clearance.pending, false);
});
test("confirmed creeper death discharges its own clearance immediately", () => {
  const bot = botFixture();
  bot.entities[7] = { id: 7, name: "creeper", width: 0.6, height: 1.7, isValid: true, position: bot.entity.position.clone() } as typeof bot.entity;
  const clearance = new CreeperClearance(bot);
  clearance.require(clearance.observe(0, new Set()));
  clearance.observe(1, new Set([7]));
  assert.equal(clearance.pending, false);
});
test("clearance from another dimension cannot constrain a new fight", () => {
  const bot = botFixture();
  bot.entities[7] = { id: 7, name: "creeper", width: 0.6, height: 1.7, isValid: true, position: bot.entity.position.clone() } as typeof bot.entity;
  const clearance = new CreeperClearance(bot);
  clearance.require(clearance.observe(0, new Set()));
  delete bot.entities[7];
  bot.game.dimension = "the_nether";
  clearance.observe(1, new Set());
  assert.equal(clearance.pending, false);
});

test("only an observed unwind behind solid cover clears a nearby live fuse", () => {
  const bot = botFixture({ groundY: 63 });
  bot.entity.position.set(0, 64, 0);
  const metadata: unknown[] = [];
  const swell = bot.registry.entitiesByName.creeper!.metadataKeys!.indexOf("swell_dir");
  metadata[swell] = 1;
  bot.entities[7] = { id: 7, name: "creeper", width: 0.6, height: 1.7, isValid: true, position: new Vec3(3, 64, 0), metadata } as typeof bot.entity;
  const clearance = new CreeperClearance(bot);
  clearance.require(clearance.observe(0, new Set()));
  bot.world.raycast = () => ({ x: 1, y: 64, z: 0, face: 4, intersect: new Vec3(1, 64, 0) });
  for (let tick = 1; tick <= 30; tick++) clearance.observe(tick, new Set());
  assert.equal(clearance.pending, true, "occlusion does not excuse a still-swelling fuse");
  metadata[swell] = -1;
  for (let tick = 31; tick <= 60; tick++) clearance.observe(tick, new Set());
  assert.equal(clearance.pending, false);
});

test("blast and removal settle only the matching fuse, in either packet order", () => {
  for (const removalFirst of [false, true]) {
    const bot = botFixture({ groundY: 63 });
    bot.entity.position.set(0, 64, 0);
    for (const id of [7, 8]) bot.entities[id] = { id, name: "creeper", width: 0.6, height: 1.7, isValid: true, position: new Vec3(id - 4, 64, 0) } as typeof bot.entity;
    const clearance = new CreeperClearance(bot);
    clearance.require(clearance.observe(0, new Set()));
    if (removalFirst) delete bot.entities[7];
    clearance.exploded({ x: 3, y: 64, z: 0 }, 1);
    delete bot.entities[7];
    const remaining = clearance.observe(1, new Set());
    assert.equal(remaining.some(threat => threat.id === 7), false);
    assert.equal(clearance.pending, true, "the other nearby creeper still requires clearance");
    delete bot.entities[8];
    clearance.observe(2, new Set());
    assert.equal(clearance.pending, true, "removal alone cannot settle the other fuse");
  }
});

test("two covered fuses can unwind at different times without rearming each other", () => {
  const bot = botFixture({ groundY: 63 });
  bot.entity.position.set(0, 64, 0);
  const swell = bot.registry.entitiesByName.creeper!.metadataKeys!.indexOf("swell_dir");
  for (const id of [7, 8]) {
    const metadata: unknown[] = [];
    metadata[swell] = 1;
    bot.entities[id] = { id, name: "creeper", width: 0.6, height: 1.7, isValid: true, position: new Vec3(id - 4, 64, 0), metadata } as typeof bot.entity;
  }
  const clearance = new CreeperClearance(bot);
  clearance.require(clearance.observe(0, new Set()));
  bot.world.raycast = () => ({ x: 1, y: 64, z: 0, face: 4, intersect: new Vec3(1, 64, 0) });
  Reflect.set(bot.entities[7]!.metadata, swell, -1);
  for (let tick = 1; tick <= 45; tick++) {
    if (tick === 15) Reflect.set(bot.entities[8]!.metadata, swell, -1);
    clearance.require(clearance.observe(tick, new Set()));
  }
  assert.equal(clearance.pending, false);
});
