import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { damageSourceName, observeDamageRegistry } from "./damage-registry.js";

test("damage IDs follow the server registry, reject unrelated packets and detach on connection end", () => {
  const bot = Object.assign(new EventEmitter(), { _client: new EventEmitter() }) as unknown as Bot;
  observeDamageRegistry(bot);
  observeDamageRegistry(bot);
  assert.equal(bot._client.listenerCount("registry_data"), 1);
  assert.equal(damageSourceName(bot, 0), null);
  bot._client.emit("registry_data", {
    id: "minecraft:damage_type",
    entries: [{ key: "custom:burn" }, { key: "minecraft:fireball" }],
  });
  assert.equal(damageSourceName(bot, 1), "minecraft:fireball");
  bot._client.emit("registry_data", { id: "minecraft:biome", entries: [{ key: "minecraft:plains" }] });
  assert.equal(damageSourceName(bot, 0), "custom:burn");
  assert.equal(damageSourceName(bot, 2), null);
  bot.emit("end", "done");
  assert.equal(bot._client.listenerCount("registry_data"), 0);
  assert.equal(damageSourceName(bot, 1), null);
});
