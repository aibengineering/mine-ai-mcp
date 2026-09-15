import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import type { Bot } from "mineflayer";
import type { ScenarioDefinition } from "mine-labs/client";

import { observeScenarioPlayerPreparation } from "./player-preparation.ts";

function fakeBot(overrides: Record<string, unknown> = {}): Bot & EventEmitter {
  const inventory = Object.assign(new EventEmitter(), { items: () => [] as Array<{ type: number; count: number }> });
  return Object.assign(new EventEmitter(), {
    username: "CraftBot",
    version: "1.21.4",
    registry: { itemsByName: { oak_log: { id: 1 } } },
    inventory,
    game: { dimension: "overworld" },
    health: 20,
    entity: { position: { x: 0, y: -59, z: 0 } },
    ...overrides,
  }) as unknown as Bot & EventEmitter;
}

test("requires a post-ready inventory update even when stale local counts already match", async () => {
  const bot = fakeBot();
  const inventory = bot.inventory as unknown as EventEmitter & { items: () => unknown[] };
  inventory.items = () => [{ type: 1, count: 4 }];
  const scenario = {
    world: { dimension: "overworld" },
    players: [{ name: "CraftBot", inventory: [{ item: "oak_log", count: 4 }] }],
  } as ScenarioDefinition;
  const observation = observeScenarioPlayerPreparation(bot, scenario);
  let settled = false;
  const prepared = observation.wait().then(() => {
    settled = true;
  });

  await setImmediate();
  assert.equal(settled, false);

  inventory.emit("updateSlot", 9, null, { type: 1, count: 4 });
  await prepared;

  assert.equal(inventory.listenerCount("updateSlot"), 1);
  observation.close();
  assert.equal(inventory.listenerCount("updateSlot"), 0);
  assert.equal(bot.listenerCount("move"), 0);
  assert.equal(bot.listenerCount("health"), 0);
});

test("a Nether start settles only once the client is in the Nether, at its position, at its declared health", async () => {
  const bot = fakeBot({ username: "Fighter" });
  const scenario = {
    world: { dimension: "the_nether" },
    players: [{ name: "Fighter", pos: [-27.5, 82, 355.5], health: 11, inventory: [] }],
  } as unknown as ScenarioDefinition;
  const observation = observeScenarioPlayerPreparation(bot, scenario);
  let settled = false;
  const prepared = observation.wait().then(() => {
    settled = true;
  });

  // Still in the overworld: a matching position there is the wrong place.
  bot.entity.position = { x: -27.5, y: 82, z: 355.5 } as Bot["entity"]["position"];
  bot.emit("move");
  await setImmediate();
  assert.equal(settled, false);

  // Respawned into the Nether, but the wound has not landed yet.
  (bot.game as { dimension: string }).dimension = "the_nether";
  bot.emit("spawn");
  await setImmediate();
  assert.equal(settled, false);

  (bot as { health: number }).health = 11;
  bot.emit("health");
  await prepared;
  observation.close();
  assert.equal(bot.listenerCount("spawn"), 0);
});
