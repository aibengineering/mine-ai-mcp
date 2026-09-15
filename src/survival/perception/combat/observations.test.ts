import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { Vec3 } from "vec3";
import { CombatPerception } from "./observations.js";

test("only an observed blaze charge transition offers a first-shot window, spent even behind terrain", () => {
  const registry = minecraftData("1.21.4");
  const flags = registry.entitiesByName.blaze!.metadataKeys!.indexOf("flags");
  const metadata: unknown[] = [];
  const enemy = { id: 2, name: "blaze", isValid: true, position: new Vec3(0, 64, -8), metadata };
  const entities = { 2: enemy };
  const bot = Object.assign(new EventEmitter(), {
    game: { dimension: "overworld" },
    registry,
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0 },
    entities,
    _client: new EventEmitter(),
    world: { raycast: () => ({}) },
  }) as unknown as Bot;
  using perception = new CombatPerception(bot);
  const observe = () => {
    bot.emit("physicsTick");
    return perception.read()[0]!.firstShotInTicks;
  };
  assert.equal(observe(), null, "missing metadata is not an observed inactive charge");
  metadata[flags] = 1;
  assert.equal(observe(), null, "a flag first observed active may already be due");
  metadata[flags] = 0;
  assert.equal(observe(), null);
  metadata[flags] = 1;
  assert.equal(observe(), 60);
  for (let tick = 0; tick < 60; tick++) observe();
  assert.equal(observe(), 0, "hidden time does not renew the charge");
  enemy.position.z = -1;
  assert.equal(observe(), 0, "switching to melee does not clear the native flag");
  enemy.position.z = -8;
  assert.equal(observe(), 0);
  entities[2] = { ...enemy, metadata: [...metadata] };
  assert.equal(observe(), null, "entity-id reuse cannot inherit another body's observed charge start");
});

test("perception caches exposure per tick, retains a distant actual attacker and releases connection listeners", () => {
  let rays = 0;
  const enemy = {
    id: 2,
    name: "blaze",
    kind: "Hostile mobs",
    isValid: true,
    position: new Vec3(0, 64, -8),
    width: 0.6,
    height: 1.8,
    metadata: [],
  };
  const bot = Object.assign(new EventEmitter(), {
    game: { dimension: "overworld" },
    registry: minecraftData("1.21.4"),
    entity: { id: 1, position: new Vec3(0, 64, 0), yaw: 0, height: 1.8, metadata: [] },
    entities: { 2: enemy },
    _client: new EventEmitter(),
    world: {
      raycast: () => {
        rays++;
        return null;
      },
    },
  }) as unknown as Bot;
  const perception = new CombatPerception(bot);
  const first = perception.read();
  assert.equal(rays, 0, "reading distances need not perform exposure work");
  assert.equal(first[0]!.visible, true);
  const performed = rays;
  assert.equal(first[0]!.lastSeenTick, 0);
  assert.equal(perception.read(), first);
  assert.equal(first[0]!.visible, true);
  assert.equal(rays, performed);
  enemy.position.z = -40;
  bot.emit("entityHurt", bot.entity, bot.entities[2]!);
  bot.emit("physicsTick");
  assert.equal(perception.read()[0]!.hasHitUs, true, "passive observation range does not forget an attacker");
  assert.equal(perception.read()[0]!.distance, 40);
  bot.emit("entityDead", bot.entities[2]!);
  assert.equal(perception.read().length, 0);
  bot.emit("entityGone", bot.entities[2]!);
  assert.equal(perception.attackerIds.size, 0);
  perception[Symbol.dispose]();
  assert.equal(bot.listenerCount("physicsTick"), 0);
  assert.equal(bot.listenerCount("entityHurt"), 0);
  assert.equal(bot._client.listenerCount("spawn_entity"), 0);
});

test("Enderman attack attribution follows the observed victim, not its anger flag", () => {
  const enderman = { id: 2, name: "enderman", kind: "Hostile mobs", isValid: true };
  const dragon = { id: 3, name: "ender_dragon", kind: "Hostile mobs", isValid: true };
  const bot = Object.assign(new EventEmitter(), {
    game: { dimension: "overworld" },
    entity: { id: 1 },
    entities: { 2: enderman, 3: dragon },
    _client: new EventEmitter(),
  }) as unknown as Bot;
  using perception = new CombatPerception(bot);
  bot.emit("entityHurt", bot.entities[3]!, bot.entities[2]!);
  assert.equal(perception.attackerIds.has(2), false);
  bot.emit("entityHurt", bot.entity, bot.entities[2]!);
  assert.equal(perception.attackerIds.has(2), true);
  bot.emit("entityHurt", bot.entities[3]!, bot.entities[2]!);
  assert.equal(
    perception.attackerIds.has(2),
    false,
    "an observed attack on someone else retires its bot-target attribution",
  );
});
