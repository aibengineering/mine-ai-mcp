import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Bot } from "mineflayer";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import { SqlBotData, botEventSchema } from "../../bot-data/index.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { createLocateStrongholdAction, loadedStrongholdFrame } from "./locate-stronghold.js";
import { locateStrongholdInputSchema, locateStrongholdResultSchema } from "./contract.js";
import { StrongholdEyeFlights, awaitFlight } from "./throw-eye.js";
import { StrongholdThrows } from "./throw-store.js";
import { triangulate, type Bearing } from "./triangulation.js";
import { strongholdSupplies } from "./supplies.js";

const registry = minecraftData("1.21.4");
const bearing = (x: number, z: number, tx: number, tz: number): Bearing => {
  const length = Math.hypot(tx - x, tz - z);
  return { start: { x, y: 70, z }, end: { x: x + (12 * (tx - x)) / length, y: 78, z: z + (12 * (tz - z)) / length } };
};
const makeData = () =>
  SqlBotData.create({ storage: { kind: "temporary" }, identity: { worldId: "test", scope: { kind: "shared" } } });
function fixture() {
  const events = new EventEmitter();
  let activations = 0;
  const bot = Object.assign(events, {
    username: "Locator",
    game: { dimension: "overworld" },
    registry,
    entity: { position: new Vec3(0, 70, 0), height: 1.8, onGround: true, effects: {} },
    entities: {},
    world: { getColumns: () => [] },
    inventory: Object.assign(new EventEmitter(), { items: () => [], slots: [] }),
    activateItem: () => {
      activations++;
    },
    equip: async () => {},
    blockAt: () => null,
  }) as unknown as Bot;
  return { bot, activations: () => activations };
}
const eye = (id = 42) => ({ id, uuid: `eye-${id}`, name: "eye_of_ender", position: new Vec3(0, 71.5, 0) });

test("intersects forward rays in every quadrant without slope singularities", () => {
  for (const [x, z] of [
    [0, -500],
    [500, 0],
    [-500, 0],
    [0, 500],
    [-500, -500],
  ]) {
    const found = triangulate(bearing(0, 0, x!, z!), bearing(32, -32, x!, z!));
    assert.ok(found);
    assert.ok(Math.hypot(found.x - x!, found.z - z!) < 1e-6);
  }
});
test("refuses parallel, backwards, sub-block and poorly conditioned bearings", () => {
  assert.equal(triangulate(bearing(0, 0, 100, 0), bearing(0, 32, 100, 32)), null);
  assert.equal(triangulate(bearing(0, 0, -100, 0), bearing(32, 32, 100, 0)), null);
  assert.equal(
    triangulate({ start: { x: 0, y: 70, z: 0 }, end: { x: 0.01, y: 80, z: 0 } }, bearing(32, 32, 500, 0)),
    null,
  );
  assert.equal(triangulate(bearing(0, 0, 1e6, 0), bearing(0, 32, 1e6, 0)), null);
});
test("SQLite survives reopen and isolates search, bot, dimension and world", () => {
  const root = mkdtempSync(path.join(tmpdir(), "stronghold-"));
  const options = {
    storage: { kind: "persistent" as const, root },
    identity: { worldId: "one", scope: { kind: "shared" as const } },
  };
  let data = SqlBotData.create(options);
  try {
    const store = new StrongholdThrows(data, "Locator", "overworld", "trip");
    const id = store.begin({ x: 1, y: 70, z: 1 });
    const b = bearing(0, 0, 0, -500);
    store.observe(id, "uuid", b.start, b.end);
    store.finish(id, "observed");
    data.close();
    data = SqlBotData.create(options);
    assert.equal(new StrongholdThrows(data, "Locator", "overworld", "trip").read()[0]?.throw_id, id);
    assert.equal(data.read("SELECT bearing_degrees FROM stronghold_throws")[0]?.bearing_degrees, 0);
    for (const args of [
      ["Other", "overworld", "trip"],
      ["Locator", "the_nether", "trip"],
      ["Locator", "overworld", "another"],
    ])
      assert.equal(new StrongholdThrows(data, args[0]!, args[1]!, args[2]!).read().length, 0);
    using other = SqlBotData.create({ ...options, identity: { ...options.identity, worldId: "two" } });
    assert.equal(other.read("SELECT * FROM stronghold_throws").length, 0);
  } finally {
    data.close();
    rmSync(root, { recursive: true, force: true });
  }
});
test("cancelling the wait preserves later airborne measurements and removes flight listeners at disappearance", async () => {
  using data = makeData();
  const f = fixture();
  using flights = new StrongholdEyeFlights(f.bot);
  const store = new StrongholdThrows(data, "Locator", "overworld", "trip");
  flights.start(store);
  assert.equal(store.read()[0]?.state, "pending");
  const entity = eye();
  f.bot.emit("entitySpawn", entity as never);
  entity.position = new Vec3(0, 74, -3);
  f.bot.emit("entityMoved", entity as never);
  const stop = new AbortController();
  const waiting = flights.wait(stop.signal);
  stop.abort(new Error("cancelled for test"));
  await assert.rejects(waiting, /cancelled for test/);
  assert.equal(store.read()[0]?.end_json?.z, -3);
  entity.position = new Vec3(0, 79, -12);
  f.bot.emit("entityMoved", entity as never);
  f.bot.emit("entityGone", entity as never);
  await flights.wait();
  assert.equal(store.read().length, 1);
  assert.equal(store.read()[0]?.end_json?.z, -12);
  assert.equal(store.read()[0]?.state, "observed");
  assert.equal(f.activations(), 1);
  for (const event of ["entitySpawn", "entityMoved", "entityGone", "end"] as const)
    assert.equal(f.bot.listenerCount(event), 0);
});
test("unrelated eyes are ignored and runtime disposal persists an incomplete observation before DB close", async () => {
  using data = makeData();
  const f = fixture();
  const flights = new StrongholdEyeFlights(f.bot);
  const store = new StrongholdThrows(data, "Locator", "overworld", "trip");
  flights.start(store);
  const unrelated = eye(99);
  unrelated.position = new Vec3(50, 70, 0);
  f.bot.emit("entitySpawn", unrelated as never);
  assert.equal(store.read()[0]?.entity_uuid, null);
  const entity = eye();
  f.bot.emit("entitySpawn", entity as never);
  f.bot.emit("entityGone", unrelated as never);
  assert.equal(store.read()[0]?.state, "tracking");
  flights[Symbol.dispose]();
  assert.equal(store.read()[0]?.state, "incomplete");
  assert.equal(f.bot.listenerCount("entityMoved"), 0);
});
test("pre-aborted waits return without attaching abort listeners", async () => {
  const signal = AbortSignal.abort(new Error("already cancelled"));
  await assert.rejects(awaitFlight(Promise.resolve(), signal), /already cancelled/);
});
test("published input rejects unknown arguments and defaults the durable search", () => {
  assert.deepEqual(locateStrongholdInputSchema.parse({}), {
    phase: "estimate",
    continue_without_recommended_items: false,
    search_id: "stronghold",
    search_radius: 128,
  });
  for (const input of [{ search_id: " " }, { search_radius: 0 }, { x: 10 }])
    assert.equal(locateStrongholdInputSchema.safeParse(input).success, false);
});
test("masonry alone is not confirmation; a loaded frame produces a typed durable final event", async () => {
  using data = makeData();
  const f = fixture();
  using flights = new StrongholdEyeFlights(f.bot);
  let material = registry.blocksByName.stone_bricks!.minStateId;
  f.bot.world.getColumns = () =>
    [
      {
        chunkX: 0,
        chunkZ: 0,
        column: {
          minY: 0,
          sections: [
            {
              solidBlockCount: 1,
              data: {},
              palette: [material],
              get: (pos: Vec3) => (pos.x === 1 && pos.y === 5 && pos.z === 1 ? material : 0),
            },
          ],
        },
      },
    ] as never;
  assert.equal(loadedStrongholdFrame(f.bot, f.bot.entity.position, 128), null);
  const navigation = { navigate: async () => ({ status: "completed", elapsedMs: 1 }) } as unknown as NavigationRuntime;
  const action = createLocateStrongholdAction(f.bot, navigation, data, flights);
  const missing = await action.begin(action.parse({}), new AbortController().signal, () => {})({});
  assert.equal(missing.status, "failed");
  assert.match("error" in missing ? missing.error : "", /No carried Eyes/);
  const store = new StrongholdThrows(data, "Locator", "overworld", "stronghold");
  const id = store.begin({ x: 0, y: 70, z: 0 });
  store.observe(id, id, { x: 0, y: 71, z: 0 }, { x: 0, y: 65, z: 0 });
  store.finish(id, "observed");
  material = registry.blocksByName.end_portal_frame!.minStateId;
  const result = await action.begin(
    action.parse({ phase: "locate", continue_without_recommended_items: true }),
    new AbortController().signal, () => {},
  )({});
  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.confirmation?.position, { x: 1, y: 5, z: 1 });
  locateStrongholdResultSchema.parse(result);
  const row = data.read("SELECT * FROM events WHERE event_type = 'stronghold_located'")[0]!;
  botEventSchema.parse({
    eventId: row.event_id,
    botId: row.bot_id,
    type: row.event_type,
    observedAt: row.observed_at,
    summary: row.summary,
    payload: JSON.parse(String(row.payload_json)),
  });
  assert.equal(f.activations(), 0);
});

test("saved bearings resume navigation without requiring or spending another eye", async () => {
  using data = makeData();
  const f = fixture();
  using flights = new StrongholdEyeFlights(f.bot);
  const store = new StrongholdThrows(data, "Locator", "overworld", "trip");
  for (const b of [bearing(0, 0, 500, 0), bearing(0, 32, 500, 0)]) {
    const id = store.begin(b.start);
    store.observe(id, id, b.start, b.end);
    store.finish(id, "observed");
  }
  const saved = store.read();
  let walked = false;
  const navigation = {
    navigate: async () => {
      walked = true;
      return { status: "stopped", reason: "fixture route obstruction", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  const action = createLocateStrongholdAction(f.bot, navigation, data, flights);
  const estimated = await action.begin(action.parse({ search_id: "trip" }), new AbortController().signal, () => {})({});
  assert.equal(estimated.status, "succeeded");
  assert.equal(estimated.phase, "estimate");
  assert.equal(estimated.confirmation, null);
  assert.ok(Math.abs(estimated.journey!.horizontalDistanceBlocks - 500) < 1e-6);
  assert.match(action.formatResult(estimated), /Stock up for the Ender Dragon/);
  assert.equal(walked, false);
  const blocked = await action.begin(
    action.parse({ search_id: "trip", phase: "locate" }),
    new AbortController().signal, () => {},
  )({});
  assert.notEqual(blocked.status, "succeeded");
  assert.match("error" in blocked ? blocked.error : "", /STRONGHOLD_MISSING_SUPPLIES/);
  assert.equal(walked, false);
  assert.deepEqual(store.read(), saved);
  locateStrongholdResultSchema.parse(estimated);
  locateStrongholdResultSchema.parse(blocked);
  const stock = [
    "carved_pumpkin",
    "bow",
    "arrow",
    "cooked_beef",
    "iron_helmet",
    "diamond_chestplate",
    "iron_leggings",
    "netherite_boots",
    "iron_sword",
    "shield",
  ];
  f.bot.inventory.slots = [
    null,
    ...stock.map((name) => ({
      name,
      count: name === "arrow" ? 64 : name === "cooked_beef" ? 16 : 1,
    })),
  ] as never;
  const equipped = await action.begin(
    action.parse({ search_id: "trip", phase: "locate" }),
    new AbortController().signal, () => {},
  )({});
  assert.equal(walked, true, "A complete checklist needs no override.");
  assert.match("error" in equipped ? equipped.error : "", /fixture route obstruction/);
  const result = await action.begin(
    action.parse({ search_id: "trip", phase: "locate", continue_without_recommended_items: true }),
    new AbortController().signal, () => {},
  )({});
  assert.equal(walked, true, JSON.stringify(result));
  assert.equal(result.status, "partial");
  assert.match("error" in result ? result.error : "", /fixture route obstruction/);
  assert.ok(result.estimate && Math.abs(result.estimate.x - 500) < 1e-6);
  assert.deepEqual(store.read(), saved);
  assert.equal(f.activations(), 0);
  assert.equal(data.read("SELECT * FROM events").length, 0);
});

test("supply checklist rejects partial stacks, unsafe food, raw pumpkins and weak equipment", () => {
  const { bot } = fixture();
  bot.inventory.slots = [
    { name: "bow", count: 1 }, // Uncrafted output must not satisfy the checklist.
    { name: "arrow", count: 63 },
    { name: "rotten_flesh", count: 64 },
    { name: "pumpkin", count: 1 },
    { name: "stone_sword", count: 1 },
    { name: "golden_chestplate", count: 1 },
    { name: "shield", count: 1 },
  ] as never;
  const supplies = strongholdSupplies(bot);
  assert.equal(supplies.filter((item) => item.carried >= item.required).length, 1);
  assert.equal(supplies.find((item) => item.recommendation === "Shield")?.carried, 1);
});

test("locate cannot skip the estimate phase even with a supply override", async () => {
  using data = makeData();
  const { bot } = fixture();
  using flights = new StrongholdEyeFlights(bot);
  const action = createLocateStrongholdAction(bot, {} as NavigationRuntime, data, flights);
  const result = await action.begin(
    action.parse({ phase: "locate", continue_without_recommended_items: true }),
    new AbortController().signal, () => {},
  )({});
  assert.equal(result.status, "failed");
  assert.match("error" in result ? result.error : "", /Complete phase: "estimate"/);
  assert.deepEqual(result.throwIds, []);
});

test("a descending vertical eye leads to local survey, without another throw", async () => {
  using data = makeData();
  const f = fixture();
  using flights = new StrongholdEyeFlights(f.bot);
  const store = new StrongholdThrows(data, "Locator", "overworld", "trip");
  const id = store.begin({ x: 0, y: 70, z: 0 });
  store.observe(id, id, { x: 0, y: 71, z: 0 }, { x: 0, y: 65, z: 0 });
  store.finish(id, "observed");
  let routes = 0;
  const navigation = {
    navigate: async () => {
      routes++;
      return routes === 1
        ? { status: "completed", elapsedMs: 1 }
        : { status: "stopped", reason: "survey boundary", elapsedMs: 1 };
    },
  } as unknown as NavigationRuntime;
  const action = createLocateStrongholdAction(f.bot, navigation, data, flights);
  const result = await action.begin(
    action.parse({ search_id: "trip", phase: "locate", continue_without_recommended_items: true }),
    new AbortController().signal, () => {},
  )({});
  assert.equal(routes, 2, JSON.stringify(result));
  assert.deepEqual(result.estimate, { x: 0, z: 0 });
  assert.equal(result.confirmation, null);
  assert.equal(result.status, "partial");
  assert.equal(f.activations(), 0);
});

test("a cancelled body can move before the spent eye's spawn packet arrives", async () => {
  using data = makeData();
  const f = fixture();
  using flights = new StrongholdEyeFlights(f.bot);
  const store = new StrongholdThrows(data, "Locator", "overworld", "trip");
  flights.start(store);
  f.bot.entity.position = new Vec3(20, 70, 0);
  const entity = eye();
  f.bot.emit("entitySpawn", entity as never);
  assert.equal(store.read()[0]?.entity_uuid, entity.uuid);
  f.bot.emit("entityGone", entity as never);
  await flights.wait();
});
