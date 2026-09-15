import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Vec3 } from "vec3";
import type { IncidentReference } from "../bot-data/incident-log.js";
import type { NavigationEvent } from "../navigation/index.js";
import { MemoryWorld } from "../navigation/world/memory-world.js";
import { CombatProgress } from "../survival/control/combat/progress.js";
import { observeDamageRegistry } from "../world/damage-registry.js";
import { observeIncidents } from "./incident-observer.js";

test("failure evidence separates lost support, server corrections, and local motion and detaches every listener", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "incident-observer-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bot = Object.assign(new EventEmitter(), {
    version: "1.21.4",
    health: 20,
    food: 20,
    oxygenLevel: 20,
    registry: { entitiesByName: { player: { metadataKeys: ["living_entity_flags", "shared_flags"] } } },
    usingHeldItem: false,
    game: { dimension: "overworld" },
    entity: {
      id: 5,
      position: new Vec3(0.5, 64, 0.5),
      velocity: new Vec3(0.02, -0.08, 0),
      onGround: true,
      yaw: 0,
      pitch: 0,
      metadata: [3, 1],
    },
    entities: {},
    inventory: { slots: [] },
    _client: new EventEmitter(),
    // Use getters just like Mineflayer: object spread must not define the evidence.
    getControlState: (control: string) => control === "forward",
  }) as unknown as Bot;
  observeDamageRegistry(bot);
  bot._client.emit("registry_data", {
    id: "minecraft:damage_type",
    entries: [{ key: "test:zero" }, { key: "test:one" }, { key: "minecraft:fireball" }],
  });
  const world = new MemoryWorld();
  world.load({ x: 0, y: 63, z: 0 }, { stateId: 1 });
  const events = new Set<(event: NavigationEvent) => void>();
  const references: IncidentReference[] = [];
  const observer = observeIncidents(
    bot,
    {
      world,
      onEvent: (listener) => {
        events.add(listener);
        return () => {
          events.delete(listener);
        };
      },
    },
    {
      directory,
      identity: { worldId: "test" },
      published: (reference) => references.push(reference),
      owner: () => ({
        requestId: 17,
        precedingRequestId: null,
        session: {
          owner: "foreground",
          busy: true,
          activeAction: { action: "navigate", startedAt: "test" },
        },
        combat: {
          targetId: 42,
          position: null,
          execution: {
            phase: "guard",
            phaseTicks: 0,
            attacks: 0,
            expected: "Volley finishes",
            completedEffects: 0,
            phaseHistory: {},
            progress: new CombatProgress().snapshot(),
          },
        },
      }),
    },
  );
  bot.emit("physicsTick");
  bot.entity.position.x += 0.1;
  bot.emit("physicsTick");
  // A failed step and mob hit stay silent; a death freezes their preceding history.
  for (const listener of events)
    listener({
      kind: "step_failed",
      runId: "r1",
      stepId: "s1",
      movement: "walk",
      observation: "no progress",
      atMs: Date.now(),
    });
  bot._client.emit("damage_event", {
    entityId: 5,
    sourceTypeId: 2,
    sourceCauseId: 7,
    sourceDirectId: 7,
    sourcePosition: null,
  });
  bot.health = 18;
  bot._client.emit("update_health", { health: 18, food: 20, foodSaturation: 3 });
  bot.emit("health");
  // Damage caused by this bot is evidence too, including a collateral hit.
  // It remains silent and does not trigger a separate capture.
  bot._client.emit("damage_event", { entityId: 8, sourceTypeId: 2, sourceCauseId: 6, sourceDirectId: 6 });
  bot._client.emit("damage_event", { entityId: 9, sourceTypeId: 2, sourceCauseId: 10, sourceDirectId: 10 });
  // Preserve the authoritative own impulse, independent of client velocity.
  bot._client.emit("entity_velocity", {
    entityId: 5,
    velocity: { x: -4000, y: 3200, z: 8000 },
    secret: "never-record",
  });
  bot._client.emit("entity_velocity", { entityId: 19, velocity: { x: 1, y: 2, z: 3 } });
  bot._client.emit("entity_velocity", { entityId: 19, velocity: "unsupported foreign shape" });
  bot._client.emit("entity_velocity", { entityId: 5, velocity: { x: 0.5, y: 0, z: 0 } });
  assert.equal(references.length, 0);
  bot.emit("death");
  await observer.recorder.flush();
  const first = references[0]!.artifact;
  assert.equal(first.kind, "written");
  if (first.kind !== "written") return;
  const intact = await readFile(first.path, "utf8");
  assert.match(intact, /"forward":true/);
  assert.match(intact, /"combat":\{"targetId":42,"position":null,"execution":/);
  assert.match(intact, /"phaseTicks":\{"guard":2\}/);
  assert.match(intact, /"positionDelta":\{"elapsedMs":\d+,"x":0\.099/);
  assert.match(intact, /"mineflayerVelocity":\{"x":0\.02/);
  assert.match(intact, /"mineflayerUsingHeldItem":false,"serverLivingEntityFlags":3/);
  assert.match(intact, /"kind":"hit".*"cause":\{"id":6,"name":null.*"burning":true/);
  assert.match(intact, /"kind":"unloaded"/);
  assert.match(intact, /"sourceType":"minecraft:fireball"/);
  assert.match(intact, /"shieldReadyFromObservedUse":false/);
  assert.match(intact, /"healthLossFollowingSource":\{"minecraft:fireball":2\}/);
  assert.doesNotMatch(intact, /nearby_block_change/);
  assert.match(intact, /"entityId":8,"sourceTypeId":2,"sourceCauseId":6,"sourceDirectId":6/);
  assert.match(intact, /"entityId":9/, "unrelated damage remains available before attribution filtering");
  assert.match(intact, /"packet":"update_health","botEntityId":5,"fields":\{"health":18,"food":20,"foodSaturation":3\}/);
  const impulseRows = intact
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((row) => row.packet === "entity_velocity");
  assert.deepEqual(
    impulseRows.map(({ atMs, ...row }) => row),
    [
      {
        kind: "packet",
        packet: "entity_velocity",
        fields: {
          entityId: 5,
          velocity: { x: -4000, y: 3200, z: 8000 },
          velocityBlocksPerTick: { x: -0.5, y: 0.4, z: 1 },
        },
      },
      { kind: "packet_unavailable", packet: "entity_velocity", reason: "unsupported diagnostic fields" },
    ],
  );

  world.load({ x: 0, y: 63, z: 0 }, { stateId: 0 });
  bot._client.emit("position", {
    teleportId: 4,
    x: 8,
    y: 64,
    z: 0.5,
    dx: 0,
    dy: 0,
    dz: 0,
    yaw: 0,
    pitch: 0,
    flags: { _value: 0, x: false },
    secret: "never-record",
  });
  bot.entity.position.x = 8;
  bot.emit("forcedMove");
  bot.emit("physicsTick");
  bot._client.emit("explosion", { x: 10, y: 64, z: 0, playerKnockback: { x: 1, y: 0, z: 0 }, secret: "never-record" });
  // Protodef omits the value of an absent option; it does not return null.
  bot._client.emit("damage_event", { entityId: 5, sourceTypeId: 2, sourceCauseId: 0, sourceDirectId: 0 });
  bot.health = 17;
  bot.emit("health");
  await observer.close();
  const last = references.at(-1)!.artifact;
  assert.equal(last.kind, "written");
  if (last.kind !== "written") return;
  const changed = await readFile(last.path, "utf8");
  assert.equal(references.at(-1)?.trigger, "runtime_closed");
  assert.match(
    changed,
    /nearby_block_change.*"before":\{"kind":"loaded","stateId":1.*"after":\{"kind":"loaded","stateId":0/,
  );
  assert.match(changed, /server_position_applied/);
  assert.match(changed, /"position":\{"x":8,"y":64,"z":0\.5},"positionDelta":null/);
  assert.match(changed, /"packet":"damage_event"/);
  assert.match(changed, /"packet":"explosion"/);
  assert.doesNotMatch(changed, /never-record/);
  assert.equal(world.listenerCount, 0);
  assert.equal(events.size, 0);
  bot.emit("end", "done");
  assert.deepEqual(bot.eventNames(), []);
  assert.deepEqual(bot._client.eventNames(), []);
});
