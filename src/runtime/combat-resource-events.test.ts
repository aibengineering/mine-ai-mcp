import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { CombatResourceObservation } from "../session/progress.js";
import { botFixture } from "../test-support/bot.js";
import { observeCombatResourceEvents } from "./combat-resource-events.js";
import { recordCombatResourceReceipt } from "./combat-resource-receipts.js";

function fixture() {
  const arrow = { name: "arrow", type: 1, count: 3, slot: 10 };
  const bot = botFixture({ items: [arrow] }, { heldItem: { name: "bow", count: 1, slot: 36 } }) as Bot;
  const client = Object.assign(new EventEmitter(), { write() {} });
  Reflect.set(bot, "_client", client);
  const observed: CombatResourceObservation[] = [];
  let owner = "hostile_reflex";
  let scope = "request-1";
  let action = "navigate";
  const runner = {
    ownership: () => ({ current: owner }),
    status: () => ({ activeAction: { action, startedAt: "now" } }),
    recordCombatResource: (event: CombatResourceObservation) => observed.push(event),
    combatResourceScope: () => scope,
    recordScopedCombatResource: (candidate: string, event: CombatResourceObservation) => { if (candidate === scope) observed.push(event); },
  };
  const stop = observeCombatResourceEvents(bot, runner as never);
  return { bot, client, arrow, observed, stop, idle: () => { owner = null as never; },
    directHunt: () => { owner = "task"; action = "collect_mob_drop"; }, nextRequest: () => { scope = "request-2"; } };
}

test("recorded packet sequence requires confirmation before counting an arrow release", () => {
  const f = fixture();
  try {
    recordCombatResourceReceipt(f.bot, { kind: "arrow_release_command" });
    assert.deepEqual(f.observed, [], "a release command alone is not a fired projectile");
    f.arrow.count = 2;
    (f.bot.inventory as EventEmitter).emit("updateSlot", 10, { ...f.arrow, count: 3 }, f.arrow);
    assert.deepEqual(f.observed, [{ kind: "arrow_fired" }]);
    (f.bot.inventory as EventEmitter).emit("updateSlot", 10, { ...f.arrow, count: 2 }, { ...f.arrow, count: 1 });
    assert.equal(f.observed.length, 1, "inventory loss without another release is not another shot");
  } finally { f.stop(); }
});

test("a delayed arrow confirmation cannot bleed into a successor request", () => {
  const f = fixture();
  try {
    recordCombatResourceReceipt(f.bot, { kind: "arrow_release_command" });
    f.nextRequest();
    f.arrow.count = 2;
    (f.bot.inventory as EventEmitter).emit("updateSlot", 10, { ...f.arrow, count: 3 }, f.arrow);
    assert.deepEqual(f.observed, []);
  } finally { f.stop(); }
});

test("a direct collect mob drop request owns combat resource receipts", () => {
  const f = fixture();
  try {
    f.directHunt();
    f.client.emit("entity_status", { entityId: f.bot.entity.id, entityStatus: 29 });
    assert.deepEqual(f.observed, [{ kind: "shield_block" }]);
  } finally { f.stop(); }
});

test("native block, status, pickup and durability facts are attributed only during combat", () => {
  const f = fixture();
  try {
    f.client.emit("damage_event", { entityId: 7, sourceCauseId: f.bot.entity.id + 1 });
    (f.bot.inventory as EventEmitter).emit("updateSlot", 36,
      { name: "iron_sword", slot: 36, count: 1, durabilityUsed: 4 },
      { name: "iron_sword", slot: 36, count: 1, durabilityUsed: 5 });
    (f.bot.inventory as EventEmitter).emit("updateSlot", 6,
      { name: "iron_chestplate", slot: 6, count: 1, durabilityUsed: 8 },
      { name: "iron_chestplate", slot: 6, count: 1, durabilityUsed: 9 });
    f.client.emit("entity_status", { entityId: f.bot.entity.id, entityStatus: 29 });
    (f.bot as unknown as EventEmitter).emit("playerCollect", f.bot.entity, Object.assign(new EventEmitter(), {
      id: 9, name: "item", getDroppedItem: () => ({ name: "arrow", count: 2 }), position: new Vec3(0, 64, 0),
    }));
    assert.deepEqual(f.observed.map((event) => event.kind), ["durability_used", "durability_used", "shield_block", "arrow_recovered", "arrow_recovered"]);
    (f.bot as unknown as EventEmitter).emit("playerCollect", f.bot.entity, Object.assign(new EventEmitter(), {
      id: 10, name: "arrow", position: new Vec3(0, 64, 0),
    }));
    assert.equal(f.observed.at(-1)?.kind, "arrow_recovered", "a recoverable projectile entity counts without item-stack metadata");
    f.idle();
    f.client.emit("entity_status", { entityId: f.bot.entity.id, entityStatus: 29 });
    assert.equal(f.observed.length, 6, "idle facts do not bleed into the next request");
  } finally { f.stop(); }
});
