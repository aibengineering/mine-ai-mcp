import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { botFixture } from "../../src/test-support/bot.js";
import type { IncidentRecorder } from "../../src/diagnostics/incident-recorder.js";
import { observeProjectilePackets } from "./projectile-packets.js";

test("arrow telemetry observes applied state, and detaches without mutating entities", () => {
  const bot = botFixture();
  const client = new EventEmitter();
  bot._client = client as Bot["_client"];
  const arrow = { id: 8, name: "arrow", isValid: true, metadata: [],
    position: new Vec3(0, 67, 8), velocity: new Vec3(0, 0, -1) } as unknown as Bot["entity"];
  bot.entities[8] = arrow;
  client.on("rel_entity_move", () => arrow.position.z--);
  client.on("entity_destroy", () => { delete bot.entities[8]; });
  const rows: any[] = [];
  const recorder = { record: (kind: string, facts: object, atMs: number) => rows.push({ kind, ...facts, atMs }) } as unknown as IncidentRecorder;
  const observer = observeProjectilePackets(bot, recorder);
  client.emit("spawn_entity", { entityId: 8, x: 0, y: 67, z: 8 });
  assert.equal(arrow.position.z, 8);
  client.emit("entity_velocity", { entityId: 999, velocity: { x: 0, y: 0, z: 1 } });
  assert.equal(rows.length, 1);
  client.emit("rel_entity_move", { entityId: 8, dX: 0, dY: 0, dZ: -4096 });
  assert.equal(rows[1].applied.position.z, 7);
  assert.equal(rows[0].applied.position.z, 8, "earlier evidence must not alias mutable entity vectors");
  client.emit("entity_destroy", { entityIds: [8] });
  assert.equal(rows[2].projectileId, 8);
  assert.equal(rows[2].applied, null);
  observer[Symbol.dispose]();
  assert.equal(client.listenerCount("spawn_entity"), 0);
  assert.equal(client.listenerCount("rel_entity_move"), 1);
});
