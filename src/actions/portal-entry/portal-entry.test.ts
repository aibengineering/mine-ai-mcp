import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import minecraftData from "minecraft-data";
import { parseNavigateRequest } from "../navigate/contract.js";
import { parseEndPortalRequest, parseNetherPortalRequest } from "./contract.js";
import { personalRespawnObservation, recordPersonalRespawn } from "./respawn-knowledge.js";
import { portalSupplyWarning } from "./portal-policy.js";
import { beginPortalEntry, endRespawnProblem, enterPortalAction } from "./portal-entry.js";

function botFixture() {
  const bot = Object.assign(new EventEmitter(), {
    registry: { foodsByName: { bread: {} } },
    inventory: { items: () => [] as Array<{ name: string; count: number }> },
    blockAt: () => null,
  }) as unknown as Bot;
  return bot;
}

test("portal inputs live only on their dedicated actions", () => {
  assert.throws(() => parseNavigateRequest({ x: 1, y: 64, z: 1, destination_dimension: "the_end" }));
  assert.deepEqual(parseNetherPortalRequest({ x: 1, y: 64, z: 1 }), {
    kind: "nether", x: 1, y: 64, z: 1, allowLowSupplies: false, respawnWithin: 128, allowDistantRespawn: false,
  });
  assert.deepEqual(parseEndPortalRequest({ x: 1, y: 64, z: 1 }), {
    kind: "end", x: 1, y: 64, z: 1, allowLowSupplies: false, respawnWithin: 128, allowDistantRespawn: false,
  });
  assert.equal(parseEndPortalRequest({ x: 1, y: 64, z: 1, respawn_within: 32, allow_distant_respawn: true }).respawnWithin, 32);
});

function crossingBot() {
  const controls = new Map<string, boolean>();
  const bot = Object.assign(botFixture(), {
    health: 20,
    game: { dimension: "overworld" },
    entity: { position: new Vec3(-2.5, 65, 0.5), onGround: true, yaw: 0 },
    registry: { foodsByName: {}, itemsByName: {} },
    inventory: { items: () => [], count: () => 0 },
    blockAt: (cell: Vec3) => ({ name: cell.equals(new Vec3(0, 64, 0)) ? "end_portal" : "air" }),
    setControlState: (name: string, value: boolean) => controls.set(name, value),
  }) as unknown as Bot;
  return { bot, controls };
}

test("portal action accepts only a server-positioned destination and releases observation with its lifetime", async () => {
  const { bot } = crossingBot();
  const lifetime = new AbortController();
  const result = await enterPortalAction(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }),
    {} as never,
    {
      createMovements: () => ({}) as never,
      navigate: async () => {
        bot.game.dimension = "the_end";
        bot.entity.position.set(100.5, 49, 0.5);
        bot.emit("forcedMove");
        return { status: "stopped", reason: "dimension changed", elapsedMs: 7 };
      },
    },
    lifetime.signal,
  );
  assert.equal(result.status, "succeeded");
  assert.equal(result.navigation.endDimension, "the_end");
  assert.equal(result.navigation.remainingDistance, null);
  assert.equal(bot.listenerCount("forcedMove"), 1);
  lifetime.abort();
  assert.equal(bot.listenerCount("forcedMove"), 0);
  assert.equal(bot.listenerCount("death"), 0);
});

test("portal action preserves caller cancellation and lifetime cleanup", async () => {
  const { bot } = crossingBot();
  const caller = new AbortController();
  const lifetime = new AbortController();
  const pending = enterPortalAction(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }),
    { signal: caller.signal } as never,
    {
      createMovements: () => ({}) as never,
      navigate: async ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true })),
    },
    lifetime.signal,
  );
  caller.abort(new Error("operator cancelled"));
  await assert.rejects(pending, /operator cancelled/);
  lifetime.abort();
  assert.equal(bot.listenerCount("forcedMove"), 0);
  assert.equal(bot.listenerCount("death"), 0);
});

test("a portal approach settles tool loss before issuing entry and retains navigation resource evidence", async () => {
  const { bot, controls } = crossingBot();
  bot.registry = minecraftData("1.21.4") as never;
  const items = [
    { name: "diamond_pickaxe", count: 1, slot: 36 },
    { name: "stone_pickaxe", count: 1, slot: 9 },
  ];
  const inventory = Object.assign(new EventEmitter(), { items: () => items, count: () => 0 });
  bot.inventory = inventory as never;
  const lifetime = new AbortController();
  try {
    const result = await enterPortalAction(bot,
      parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }), {}, {
        createMovements: () => ({}) as never,
        navigate: async ({ onToolSelected, stopSignal }) => {
          onToolSelected?.(bot.registry.itemsByName.diamond_pickaxe!.id);
          items.shift();
          inventory.emit("updateSlot", 36, null);
          await Promise.resolve();
          assert.equal(stopSignal?.aborted, true);
          return { status: "stopped", reason: "tool loss", elapsedMs: 1 };
        },
      }, lifetime.signal);
    assert.equal(result.status, "partial");
    assert.match("error" in result ? result.error : "", /TOOL_TIER_LOST.*stone pickaxe remains/);
    assert.equal(controls.size, 0, "No portal entry was issued after the approach stopped.");
    assert.ok(result.navigation.scaffolding.some((stock) => stock.item === "end_stone"));
    assert.deepEqual(result.navigation.bucketDrops, { count: 0, waterRecovered: 0 });
  } finally { lifetime.abort(); }
  assert.equal(inventory.listenerCount("updateSlot"), 0);
});

test("an immediate return while still inside the arrival portal settles truthfully instead of waiting forever", async () => {
  const { bot } = crossingBot();
  bot.game.dimension = "the_end";
  bot.entity.position.set(0.5, 64, 0.5);
  const result = await enterPortalAction(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0 }),
    {} as never,
    { createMovements: () => ({}) as never, navigate: async () => { throw new Error("must not route"); } },
    new AbortController().signal,
  );
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /PORTAL_ALREADY_INSIDE/);
});

test("a crossing observed during takeover resumes with its original destination and receipt", async () => {
  const { bot } = crossingBot();
  const lifetime = new AbortController();
  const attempt = new AbortController();
  let routes = 0;
  const resume = beginPortalEntry(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }),
    {
      createMovements: () => ({}) as never,
      navigate: async () => {
        routes++;
        bot.game.dimension = "the_end";
        bot.entity.position.set(100.5, 49, 0.5);
        bot.emit("forcedMove");
        attempt.abort(new Error("survival takeover"));
        throw attempt.signal.reason;
      },
    },
    lifetime.signal,
  );
  await assert.rejects(resume({ signal: attempt.signal } as never), /survival takeover/);
  const result = await resume({} as never);
  assert.equal(result.status, "succeeded");
  assert.equal(result.navigation.startDimension, "overworld");
  assert.equal(result.navigation.endDimension, "the_end");
  assert.equal(routes, 1, "resumption must not reinterpret the End arrival as an Overworld return");
  assert.equal(bot.listenerCount("forcedMove"), 1, "one request lifetime owns one observer");
  lifetime.abort();
  assert.equal(bot.listenerCount("forcedMove"), 0);
});

test("death makes a resumed portal request terminal instead of routing again or reporting timeout", async () => {
  const { bot } = crossingBot();
  const lifetime = new AbortController();
  const attempt = new AbortController();
  let routes = 0;
  const resume = beginPortalEntry(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }),
    {
      createMovements: () => ({}) as never,
      navigate: async () => {
        routes++;
        bot.emit("death");
        attempt.abort(new Error("death takeover"));
        throw attempt.signal.reason;
      },
    },
    lifetime.signal,
  );
  await assert.rejects(resume({ signal: attempt.signal } as never), /death takeover/);
  const result = await resume({} as never);
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.error : "", /PORTAL_DIED/);
  assert.equal(routes, 1);
  lifetime.abort();
});

test("End guard refuses unknown, distant, and visibly missing bed evidence while allowing the explicit override", () => {
  const bot = botFixture();
  const request = parseEndPortalRequest({ x: 0, y: 64, z: 0 });
  assert.match(endRespawnProblem(bot, request, "the_end")!, /RESPAWN_UNKNOWN/);
  recordPersonalRespawn(bot, { x: 200, y: 64, z: 0 });
  bot.blockAt = () => ({ name: "red_bed" }) as never;
  assert.match(endRespawnProblem(bot, request, "the_end")!, /RESPAWN_DISTANT.*200\.00/);
  bot.blockAt = () => ({ name: "air" }) as never;
  assert.match(endRespawnProblem(bot, request, "the_end")!, /RESPAWN_STALE/);
  const override = parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true });
  assert.equal(endRespawnProblem(bot, override, "the_end"), null);
  assert.equal(endRespawnProblem(bot, request, "overworld"), null, "End return is exempt");
});

test("supply thresholds count usable items and exempt return", () => {
  const bot = botFixture();
  const stock = [{ name: "bread", count: 16 }, { name: "arrow", count: 32 }];
  bot.inventory.items = () => stock as never;
  assert.equal(portalSupplyWarning(bot, "the_end"), null);
  stock[0]!.count = 15;
  assert.match(portalSupplyWarning(bot, "the_nether")!, /15\/16/);
  assert.equal(portalSupplyWarning(bot, "overworld"), null);
});

test("personal respawn knowledge is confirmed separately from world spawn and invalidated by spawnReset", () => {
  const bot = botFixture();
  bot.spawnPoint = new Vec3(0, 64, 0);
  assert.equal(personalRespawnObservation(bot), null);
  recordPersonalRespawn(bot, { x: 100, y: 65, z: 100 });
  assert.deepEqual(personalRespawnObservation(bot)?.position, { x: 100, y: 65, z: 100 });
  assert.deepEqual(bot.spawnPoint, new Vec3(0, 64, 0));
  bot.emit("spawnReset");
  assert.equal(personalRespawnObservation(bot), null);
});
