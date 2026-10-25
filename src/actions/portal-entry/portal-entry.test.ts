import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { createMovements, type Navigate } from "../../navigation/index.js";
import { botFixture, type FakeStack } from "../../test-support/bot.js";
import { parseEndPortalRequest } from "./contract.js";
import { personalRespawnObservation, recordPersonalRespawn } from "./respawn-knowledge.js";
import { portalSupplyWarning } from "./portal-policy.js";
import { beginPortalEntry, endRespawnProblem, enterPortalAction } from "./portal-entry.js";

/** A bot two blocks from an active End portal at 0,64,0, recording the controls it is driven with. */
function crossingBot(items: FakeStack[] = []) {
  const controls = new Map<string, boolean>();
  const bot = botFixture(
    { position: { x: -2.5, y: 65, z: 0.5 }, items, blocks: { "0,64,0": "end_portal" } },
    { setControlState: (name: string, value: boolean) => controls.set(name, value) },
  );
  return { bot, controls };
}

/** The only part of the navigation runtime portal entry routes through. */
const routing = (navigate: Navigate) => ({ navigate });

test("portal action accepts only a server-positioned destination and releases observation with its lifetime", async () => {
  const { bot } = crossingBot();
  const lifetime = new AbortController();
  const result = await enterPortalAction(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }),
    {} as never,
    routing(async () => {
        bot.game.dimension = "the_end";
        bot.entity.position.set(100.5, 49, 0.5);
        bot.emit("forcedMove");
        return { status: "stopped", reason: "dimension changed", elapsedMs: 7 };
    }),
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
    routing(async ({ signal }) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }))),
    lifetime.signal,
  );
  caller.abort(new Error("operator cancelled"));
  await assert.rejects(pending, /operator cancelled/);
  lifetime.abort();
  assert.equal(bot.listenerCount("forcedMove"), 0);
  assert.equal(bot.listenerCount("death"), 0);
});

test("a portal approach settles tool loss before issuing entry and retains navigation resource evidence", async () => {
  const items = [
    { name: "diamond_pickaxe", count: 1, slot: 36 },
    { name: "stone_pickaxe", count: 1, slot: 9 },
  ];
  const { bot, controls } = crossingBot(items);
  const inventory = bot.inventory;
  // The movement policy keeps one tool-plan cache per bot, listening for the
  // bot's lifetime; build it first so only the entry's own observer is counted.
  createMovements(bot);
  const listening = inventory.listenerCount("updateSlot");
  const lifetime = new AbortController();
  try {
    const result = await enterPortalAction(bot,
      parseEndPortalRequest({ x: 0, y: 64, z: 0, allow_distant_respawn: true, allow_low_supplies: true }), {}, routing(async ({ onToolSelected, stopSignal }) => {
          onToolSelected?.(bot.registry.itemsByName.diamond_pickaxe!.id);
          items.shift();
          inventory.emit("updateSlot", 36, null);
          await Promise.resolve();
          assert.equal(stopSignal?.aborted, true);
          return { status: "stopped", reason: "tool loss", elapsedMs: 1 };
        }), lifetime.signal);
    assert.equal(result.status, "partial");
    assert.match("error" in result ? result.error : "", /TOOL_TIER_LOST.*stone pickaxe remains/);
    assert.equal(controls.size, 0, "No portal entry was issued after the approach stopped.");
    assert.ok(result.navigation.scaffolding.some((stock) => stock.item === "end_stone"));
    assert.deepEqual(result.navigation.bucketDrops, { count: 0, waterRecovered: 0 });
  } finally { lifetime.abort(); }
  assert.equal(inventory.listenerCount("updateSlot"), listening);
});

test("an immediate return while still inside the arrival portal settles truthfully instead of waiting forever", async () => {
  const { bot } = crossingBot();
  bot.game.dimension = "the_end";
  bot.entity.position.set(0.5, 64, 0.5);
  const result = await enterPortalAction(
    bot,
    parseEndPortalRequest({ x: 0, y: 64, z: 0 }),
    {} as never,
    routing(async () => { throw new Error("must not route"); }),
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
    routing(async () => {
        routes++;
        bot.game.dimension = "the_end";
        bot.entity.position.set(100.5, 49, 0.5);
        bot.emit("forcedMove");
        attempt.abort(new Error("survival takeover"));
        throw attempt.signal.reason;
    }),
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
    routing(async () => {
        routes++;
        bot.emit("death");
        attempt.abort(new Error("death takeover"));
        throw attempt.signal.reason;
    }),
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
