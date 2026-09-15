import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { parseViewStatusRequest, viewStatusResultSchema } from "./contract.js";
import { createViewStatusAction, formatViewStatusResult, observeLiveSituation } from "./view-status.js";
import { botFixture, registry } from "../../test-support/bot.js";
import { temporaryBotData } from "../../test-support/bot-data.js";
import { recordLastDeath } from "../../bot-data/index.js";

const idleActivity = () => ({ owner: "idle" as const, activeAction: null });

function stack(slot: number, name: string, count: number) {
  return { slot, name, count };
}

/** One loaded entity, typed as the live server types it: a numeric registry id plus Mineflayer's category. */
function loaded(id: number, name: string, position: Vec3) {
  const registered = registry.entitiesByName[name];
  if (!registered) throw new Error(`no entity named ${name} in the 1.21.4 registry`);
  return {
    id,
    name,
    metadata: [] as unknown[],
    entityType: registered.id,
    kind: registered.category,
    isValid: true,
    position,
  };
}

/**
 * A bot asleep at night beside its base, with players, mobs of every kind, and
 * two drops loaded. The far ones are outside the sixteen-block nearby range and
 * inside the loaded chunks, which is the distinction the mob summary exists for.
 */
function liveBot(): Bot {
  const slots: ({ name: string; count: number } | null)[] = new Array(46).fill(null);
  slots[5] = stack(5, "diamond_helmet", 1);
  slots[45] = stack(45, "shield", 1);
  return botFixture(
    {},
    {
      entity: { position: new Vec3(-9.5, 99, 18.68), yaw: Math.PI / 2, pitch: 0, onGround: true, isInWater: false },
      health: 18.08,
      food: 12,
      foodSaturation: 0.4,
      time: { timeOfDay: 13826 },
      isSleeping: true,
      isRaining: false,
      quickBarSlot: 0,
      inventory: {
        slots,
        items: () => [stack(36, "stone_pickaxe", 1), stack(9, "cobblestone", 64), stack(10, "cobblestone", 12)],
      },
      players: {
        TestBot: { username: "TestBot" },
        Scout: { username: "Scout", entity: { position: new Vec3(-12, 99, 14) } },
        Faraway: { username: "Faraway", entity: null },
      },
      entities: {
        1: loaded(1, "zombie", new Vec3(-4.5, 99, 18.68)),
        2: { ...loaded(2, "item", new Vec3(-9.5, 99, 20.68)), getDroppedItem: () => stack(0, "coal", 3) },
        3: { ...loaded(3, "item", new Vec3(40, 99, 20.68)), getDroppedItem: () => stack(0, "dirt", 1) },
        4: loaded(4, "cow", new Vec3(-8, 99, 18)),
        5: loaded(5, "cow", new Vec3(-9.5, 99, 30)),
        6: loaded(6, "bat", new Vec3(-9.5, 105, 18.68)),
        7: loaded(7, "villager", new Vec3(-15.5, 99, 18.68)),
        8: loaded(8, "cod", new Vec3(-9.5, 99, 8.68)),
        9: loaded(9, "rabbit", new Vec3(30, 99, 18.68)),
        10: loaded(10, "slime", new Vec3(-9.5, 99, 78.68)),
        11: loaded(11, "player", new Vec3(-12, 99, 14)),
      },
    },
  );
}

test("reports the observed clock without predicting daylight outside the Overworld", (t) => {
  // Servers may supply a custom dimension beyond Mineflayer's built-in union.
  for (const dimension of ["the_nether", "the_end", "custom_dimension"]) {
    const bot = liveBot();
    Object.assign(bot.game, { dimension });
    bot.time.timeOfDay = 11934;
    bot.isSleeping = false;
    const situation = observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);
    const result = viewStatusResultSchema.parse({ status: "succeeded", situation });
    assert.equal(result.situation.dimension, dimension, dimension);
    assert.deepEqual(
      result.situation.clock,
      {
        timeOfDay: 11934,
        phase: null,
        ticksUntilChange: null,
        minutesUntilChange: null,
        sleeping: false,
        raining: false,
      },
      dimension,
    );
    const markdown = formatViewStatusResult(result);
    assert.match(markdown, /World clock 11934/, dimension);
    assert.match(
      markdown,
      dimension === "custom_dimension"
        ? /daylight cycle unknown for this dimension/
        : /no daylight cycle in this dimension/,
      dimension,
    );
    assert.doesNotMatch(markdown, /night falls|day breaks|\(day\)|\(night\)/, dimension);
  }
});

test("reports vitals, the clock, position, inventory, and loaded neighbours from the live bot", (t) => {
  assert.deepEqual(parseViewStatusRequest(undefined), {});
  assert.deepEqual(parseViewStatusRequest({}), {});
  assert.throws(() => parseViewStatusRequest({ radius: 8 }), "the range is the action's, not the caller's");

  const data = temporaryBotData({ botId: "TestBot", closeAfter: t });
  const situation = observeLiveSituation(liveBot(), data, idleActivity);

  assert.equal(situation.botId, "TestBot");
  assert.deepEqual(situation.vitals, { health: 18.1, food: 12, saturation: 0.4, airSupplyTicks: null, burning: null });
  assert.deepEqual(situation.clock, {
    timeOfDay: 13826,
    phase: "night",
    ticksUntilChange: 9633,
    minutesUntilChange: 8,
    sleeping: true,
    raining: false,
  });
  assert.deepEqual(situation.position, {
    x: -9.5,
    y: 99,
    z: 18.68,
    chunkX: -1,
    chunkZ: 1,
    headingDegrees: 270,
    onGround: true,
    inWater: false,
    inLava: null,
  });
  assert.deepEqual(situation.inventory, {
    usedSlots: 3,
    freeSlots: 33,
    stacks: [
      { slot: 5, location: "head", name: "diamond_helmet", count: 1, held: false, durability: null },
      { slot: 9, location: "main", name: "cobblestone", count: 64, held: false, durability: null },
      { slot: 10, location: "main", name: "cobblestone", count: 12, held: false, durability: null },
      { slot: 36, location: "hotbar", name: "stone_pickaxe", count: 1, held: true, durability: null },
      { slot: 45, location: "off-hand", name: "shield", count: 1, held: false, durability: null },
    ],
  });
  // Players, the bot's own entity, and dropped items are in no mob category, and
  // the loaded-mob summary reaches entities the bounded threat list cannot: the
  // slime sixty blocks off is loaded but outside the sixteen-block hostile range.
  assert.deepEqual(situation.nearby, {
    rangeBlocks: 16,
    players: [
      { username: "Faraway", distance: null, position: null },
      { username: "Scout", distance: 5.3, position: { x: -12, y: 99, z: 14 } },
    ],
    hostiles: [{ name: "zombie", distance: 5, position: { x: -4.5, y: 99, z: 18.68 } }],
    mobs: [
      {
        name: "cow",
        age: "adult",
        kind: "animal",
        count: 2,
        nearest: { entityId: 4, distance: 1.6, position: { x: -8, y: 99, z: 18 } },
      },
      {
        name: "zombie",
        age: "adult",
        kind: "hostile",
        count: 1,
        nearest: { entityId: 1, distance: 5, position: { x: -4.5, y: 99, z: 18.68 } },
      },
      {
        name: "bat",
        age: "not_applicable",
        kind: "ambient",
        count: 1,
        nearest: { entityId: 6, distance: 6, position: { x: -9.5, y: 105, z: 18.68 } },
      },
      {
        name: "villager",
        age: "adult",
        kind: "passive",
        count: 1,
        nearest: { entityId: 7, distance: 6, position: { x: -15.5, y: 99, z: 18.68 } },
      },
      {
        name: "cod",
        age: "not_applicable",
        kind: "water_creature",
        count: 1,
        nearest: { entityId: 8, distance: 10, position: { x: -9.5, y: 99, z: 8.68 } },
      },
      {
        name: "rabbit",
        age: "adult",
        kind: "animal",
        count: 1,
        nearest: { entityId: 9, distance: 39.5, position: { x: 30, y: 99, z: 18.68 } },
      },
      {
        name: "slime",
        age: "not_applicable",
        kind: "mob",
        count: 1,
        nearest: { entityId: 10, distance: 60, position: { x: -9.5, y: 99, z: 78.68 } },
      },
    ],
    droppedItems: [
      { name: "coal", count: 3, distance: 2, position: { x: -9.5, y: 99, z: 20.68 } },
      { name: "dirt", count: 1, distance: 49.5, position: { x: 40, y: 99, z: 20.68 } },
    ],
  });
});

test("refreshes the queryable status and inventory rows in the same read", (t) => {
  const data = temporaryBotData({ botId: "TestBot", closeAfter: t });
  observeLiveSituation(liveBot(), data, idleActivity);

  assert.deepEqual(
    data.read(
      "SELECT bot_id, game_mode, time_of_day, is_sleeping, is_raining, on_ground, in_water, saturation FROM bot_status",
    ),
    [
      {
        bot_id: "TestBot",
        game_mode: "survival",
        time_of_day: 13826,
        is_sleeping: 1,
        is_raining: 0,
        on_ground: 1,
        in_water: 0,
        saturation: 0.4,
      },
    ],
  );
  assert.deepEqual(data.read("SELECT slot, location, item_name, count, held FROM bot_inventory ORDER BY slot"), [
    { slot: 5, location: "head", item_name: "diamond_helmet", count: 1, held: 0 },
    { slot: 9, location: "main", item_name: "cobblestone", count: 64, held: 0 },
    { slot: 10, location: "main", item_name: "cobblestone", count: 12, held: 0 },
    { slot: 36, location: "hotbar", item_name: "stone_pickaxe", count: 1, held: 1 },
    { slot: 45, location: "off-hand", item_name: "shield", count: 1, held: 0 },
  ]);
  assert.deepEqual(data.read("SELECT class, tier, item_name, durability_left FROM bot_tools WHERE item_name IS NOT NULL ORDER BY class"), [
    { class: "helmet", tier: "diamond", item_name: "diamond_helmet", durability_left: null },
    { class: "pickaxe", tier: "stone", item_name: "stone_pickaxe", durability_left: null },
    { class: "shield", tier: "other", item_name: "shield", durability_left: null },
  ]);
});

test("renders one compact Markdown situation report", async (t) => {
  const data = temporaryBotData({ botId: "TestBot", closeAfter: t });
  const action = createViewStatusAction(liveBot(), data, idleActivity);
  assert.equal(action.execution.kind, "information");
  assert.equal(action.annotations?.readOnlyHint, true);

  const result = await action.execute(action.parse({}), {});
  const markdown = formatViewStatusResult(result);

  assert.match(markdown, /Health 18\.1\/20, hunger 12\/20, saturation 0\.4/);
  assert.match(markdown, /Time of day 13826 \(night\); day breaks in 9633 ticks \(~8 min\)/);
  assert.match(markdown, /Sleeping: yes; raining: no/);
  assert.match(markdown, /`-9\.5, 99, 18\.68`, chunk `-1, 1`, heading 270°/);
  assert.match(markdown, /### Inventory \(3 of 36 slots used, 33 free\)/);
  assert.match(markdown, /- Held: stone_pickaxe x1/);
  assert.match(markdown, /- Worn: head diamond_helmet, off-hand shield/);
  assert.match(markdown, /- cobblestone x76 \(slots 9, 10\)/);
  assert.match(markdown, /- Players: Faraway \(online, not loaded nearby\); Scout 5\.3 blocks away at `-12, 99, 14`/);
  assert.match(markdown, /- Hostiles: zombie 5 blocks away/);
  assert.match(markdown, /- Loaded mobs \(every loaded chunk, any distance\):\n/);
  assert.match(markdown, /\n {2}- cow \(animal, adult\) x2, nearest #4 1\.6 at `-8, 99, 18`\n/);
  assert.match(markdown, /\n {2}- rabbit \(animal, adult\) x1, nearest #9 39\.5 at `30, 99, 18\.68`\n/);
  assert.match(markdown, /bat \(ambient\) x1/);
  assert.doesNotMatch(markdown, /not_applicable/);
  assert.match(markdown, /- Dropped items \(every loaded chunk, nearest 16\): coal x3 2 blocks away/);
  assert.match(markdown, /Refreshed `main\.bot_status` and `main\.bot_inventory`/);
});

test("public status reports own air, burning, lava, per-slot durability and live takeover ownership", async (t) => {
  const bot = liveBot();
  const metadata: unknown[] = [];
  const keys = registry.entitiesByName.player!.metadataKeys!;
  metadata[keys.indexOf("air_supply")] = -2;
  metadata[keys.indexOf("shared_flags")] = 1;
  Object.assign(bot.entity, { metadata, isInLava: true });
  // This value can come from another entity in older Mineflayer. It must not be used.
  bot.oxygenLevel = 20;
  Object.assign(bot.inventory.slots[5]!, { maxDurability: 363, durabilityUsed: 362 });
  Object.assign(bot.inventory.slots[45]!, { maxDurability: 336, durabilityUsed: 336 });
  const activeAction = { action: "hostile_reflex", startedAt: "2026-09-06T00:00:00.000Z" };
  let activity: ReturnType<typeof idleActivity> | { owner: "takeover"; activeAction: typeof activeAction } =
    idleActivity();
  const action = createViewStatusAction(
    bot,
    temporaryBotData({ botId: "TestBot", closeAfter: t }),
    () => activity,
  );
  assert.equal((await action.execute({}, {})).situation.activity.owner, "idle");
  activity = { owner: "takeover", activeAction };
  const result = viewStatusResultSchema.parse(await action.execute({}, {}));
  assert.equal(result.situation.vitals.airSupplyTicks, -2);
  assert.equal(result.situation.vitals.burning, true);
  assert.equal(result.situation.position.inLava, true);
  assert.deepEqual(result.situation.activity, activity);
  assert.deepEqual(result.situation.inventory.stacks.find((item) => item.slot === 5)?.durability, {
    remaining: 1,
    maximum: 363,
  });
  assert.deepEqual(result.situation.inventory.stacks.find((item) => item.slot === 45)?.durability, {
    remaining: 0,
    maximum: 336,
  });
  const rendered = formatViewStatusResult(result);
  assert.match(rendered, /Air supply: -2 ticks; burning: yes; in lava: yes/);
  assert.match(rendered, /Physical owner: takeover; action: hostile_reflex since 2026-09-06T00:00:00.000Z/);
  assert.match(rendered, /diamond_helmet \(slot 5, head\) 1\/363 remaining/);
  assert.match(rendered, /shield \(slot 45, off-hand\) 0\/336 remaining/);
});

test("missing own metadata remains unknown even with a full oxygenLevel; observed zero and false remain facts", (t) => {
  const bot = liveBot();
  bot.oxygenLevel = 20;
  const data = temporaryBotData({ botId: "TestBot", closeAfter: t });
  const unknown = observeLiveSituation(bot, data, idleActivity);
  assert.equal(unknown.vitals.airSupplyTicks, null);
  assert.equal(unknown.vitals.burning, null);
  assert.equal(unknown.position.inLava, null);
  assert.match(
    formatViewStatusResult({ status: "succeeded", situation: unknown }),
    /Air supply: unknown; burning: unknown; in lava: unknown/,
  );
  const metadata: unknown[] = [];
  const keys = registry.entitiesByName.player!.metadataKeys!;
  metadata[keys.indexOf("air_supply")] = 0;
  metadata[keys.indexOf("shared_flags")] = 0;
  Object.assign(bot.entity, { metadata, isInLava: false });
  const observed = observeLiveSituation(bot, data, idleActivity);
  assert.equal(observed.vitals.airSupplyTicks, 0);
  assert.equal(observed.vitals.burning, false);
  assert.equal(observed.position.inLava, false);
});

test("species-age groups expose a farther adult without losing the nearest baby or species total", (t) => {
  const bot = liveBot();
  const babyKey = registry.entitiesByName.piglin!.metadataKeys!.indexOf("baby");
  const pigs = [
    loaded(2942, "piglin", bot.entity.position.offset(1, 0, 0)),
    loaded(2941, "piglin", bot.entity.position.offset(3, 0, 0)),
    loaded(2943, "piglin", bot.entity.position.offset(4, 0, 0)),
    loaded(2944, "piglin", bot.entity.position.offset(5, 0, 0)),
  ];
  pigs[0]!.metadata[babyKey] = true;
  pigs[2]!.metadata[babyKey] = false;
  pigs[3]!.metadata[babyKey] = "unsupported";
  for (const pig of pigs) bot.entities[pig.id] = pig as unknown as Bot["entity"];
  const situation = observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);
  const groups = situation.nearby.mobs.filter((mob) => mob.name === "piglin");
  assert.deepEqual(
    groups.map(({ age, count, nearest }) => ({ age, count, id: nearest.entityId })),
    [
      { age: "baby", count: 1, id: 2942 },
      { age: "adult", count: 2, id: 2941 },
      { age: "unknown", count: 1, id: 2944 },
    ],
  );
  assert.equal(
    groups.reduce((total, group) => total + group.count, 0),
    4,
  );
  const result = { status: "succeeded" as const, situation };
  viewStatusResultSchema.parse(result);
  assert.match(formatViewStatusResult(result), /piglin \(hostile, age unknown\) x1/);
  assert.match(formatViewStatusResult(result), /piglin \(hostile, adult\) x2, nearest #2941/);
});

test("status exposes the retained death after the live position has changed", (t) => {
  const bot = liveBot();
  const data = temporaryBotData({ botId: "TestBot", closeAfter: t });
  recordLastDeath(data, {
    botId: "TestBot", dimension: "overworld", position: { x: 4.5, y: 63, z: -9.5 },
    observedAt: "2026-09-13T09:00:00.000Z", cause: "fell from a high place",
  });

  const situation = observeLiveSituation(bot, data, idleActivity);

  assert.deepEqual(situation.lastDeath, {
    dimension: "overworld", position: { x: 4.5, y: 63, z: -9.5 },
    observedAt: "2026-09-13T09:00:00.000Z", cause: "fell from a high place",
  });
  assert.match(formatViewStatusResult({ status: "succeeded", situation }), /Last death: `4.5, 63, -9.5`/);
});

test("End observations name dragon phases, render the estimated head, and report loaded cage evidence", (t) => {
  const bot = liveBot();
  const dragon = { ...loaded(20, "ender_dragon", new Vec3(30.5, 80, 0.5)), yaw: 0 };
  const phaseKey = registry.entitiesByName.ender_dragon!.metadataKeys!.indexOf("phase");
  const healthKey = registry.entitiesByName.ender_dragon!.metadataKeys!.indexOf("health");
  dragon.metadata[phaseKey] = 6;
  dragon.metadata[healthKey] = 150;
  bot.entities[20] = dragon as unknown as Bot["entity"];
  bot.entities[21] = loaded(21, "end_crystal", new Vec3(0.5, 83, 0.5)) as unknown as Bot["entity"];
  bot.entities[22] = loaded(22, "end_crystal", new Vec3(10.5, 83, 0.5)) as unknown as Bot["entity"];
  bot.entities[23] = loaded(23, "end_crystal", new Vec3(20.5, 83, 0.5)) as unknown as Bot["entity"];
  bot.blockAt = ((position: Vec3) => {
    if (position.x === 2 && position.y === 83 && position.z === 0) return { name: "iron_bars" };
    if (position.x === 18 && position.y === 82 && position.z === -2) return null;
    return { name: "air" };
  }) as Bot["blockAt"];

  const situation = observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);

  assert.deepEqual(
    situation.endFight.crystals.map(({ entityId, cage }) => ({ entityId, cage })),
    [
      { entityId: 21, cage: "present" },
      { entityId: 22, cage: "none_observed" },
      { entityId: 23, cage: "unknown" },
    ],
  );
  assert.equal(situation.endFight.dragons[0]?.phaseName, "sitting_scanning");
  assert.deepEqual(situation.endFight.dragons[0]?.headEstimate, { x: 30.5, y: 79, z: 7 });
  assert.equal(situation.endFight.dragons[0]?.landingHeadEstimate, null);
  const rendered = formatViewStatusResult({ status: "succeeded", situation });
  assert.match(rendered, /phase 6 \(sitting_scanning\).*estimated head `30.5, 79, 7`/);
  assert.match(rendered, /Crystal #21.*cage present/);
  assert.match(rendered, /Crystal #23.*cage unknown/);
  assert.match(rendered, /Bow tip: bows can hit caged crystals through gaps, but may waste arrows/);
  viewStatusResultSchema.parse({ status: "succeeded", situation });
});

test("landing head preparation is reported only from observed fountain geometry", (t) => {
  const bot = liveBot();
  const dragon = { ...loaded(20, "ender_dragon", new Vec3(30.5, 80, 0.5)), yaw: 0 };
  const phaseKey = registry.entitiesByName.ender_dragon!.metadataKeys!.indexOf("phase");
  dragon.metadata[phaseKey] = 2;
  bot.entities[20] = dragon as unknown as Bot["entity"];
  const base = new Vec3(0, 60, 0);
  bot.findBlocks = (() => [base]) as Bot["findBlocks"];
  bot.blockAt = ((position: Vec3) => {
    const pillar = position.x === 0 && position.z === 0 && position.y >= 60 && position.y <= 63;
    const rim = position.y === 60 && ((Math.abs(position.x) === 3 && position.z === 0) || (position.x === 0 && Math.abs(position.z) === 3));
    return { name: pillar || rim ? "bedrock" : "air" };
  }) as Bot["blockAt"];

  const observed = observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);
  assert.equal(observed.endFight.dragons[0]?.phaseName, "landing_approach");
  assert.equal(observed.endFight.dragons[0]?.headEstimate, null);
  assert.deepEqual(observed.endFight.dragons[0]?.landingHeadEstimate, { x: 0.5, y: 63, z: 7 });
  const rendered = formatViewStatusResult({ status: "succeeded", situation: observed });
  assert.match(rendered, /Predicted head after landing: `0.5, 63, 7`; direction may change/);
  assert.match(rendered, /prepare_dragon_perch.*attack_dragon_perch/);

  bot.findBlocks = (() => []) as Bot["findBlocks"];
  // The cached observation remains usable only while the actual fountain
  // blocks are loaded. A missing search result alone does not erase them.
  bot.blockAt = (() => null) as Bot["blockAt"];
  const unknown = observeLiveSituation(bot, temporaryBotData({ botId: "TestBot", closeAfter: t }), idleActivity);
  assert.equal(unknown.endFight.dragons[0]?.landingHeadEstimate, null);
});

/**
 * The water bucket is the one carried item that changes how far a route will
 * fall, and a model cannot read that off the stack list: three blocks without
 * one, eighty with. The report says so both ways round, and it names the
 * missing bucket rather than reporting a bare unavailable.
 */
test("reports which movements the carried inventory unlocks, and what blocks the rest", (t) => {
  const data = () => temporaryBotData({ botId: "TestBot", closeAfter: t });
  const report = (bot: Bot) =>
    formatViewStatusResult({ status: "succeeded", situation: observeLiveSituation(bot, data(), idleActivity) });

  const empty = liveBot();
  const dry = observeLiveSituation(empty, data(), idleActivity);
  assert.deepEqual(dry.mobility.bucketDrop, { available: false, maximumBlocks: 0, blockedBy: ["no_water_bucket"] });
  assert.deepEqual(dry.mobility.fallSave, { available: false, blockedBy: ["no_water_bucket"] });
  assert.equal(dry.mobility.waterBuckets, 0);
  assert.deepEqual(dry.mobility.scaffold, { available: true, item: "cobblestone", blocks: 76, blockedBy: [] });
  assert.equal(viewStatusResultSchema.parse({ status: "succeeded", situation: dry }).situation.mobility.maximumDrop, 3);
  const dryMarkdown = report(empty);
  assert.match(
    dryMarkdown,
    /- Water buckets carried: 0; no planned bucket drops or emergency fall saves \(no water bucket carried\)/,
  );
  assert.match(dryMarkdown, /- Scaffold placement \(pillar up, bridge gaps\): cobblestone x76/);

  const carried = liveBot();
  carried.inventory.items = () => [stack(36, "water_bucket", 1), stack(9, "cobblestone", 64)] as never;
  const wet = observeLiveSituation(carried, data(), idleActivity);
  assert.deepEqual(wet.mobility.bucketDrop, { available: true, maximumBlocks: 80, blockedBy: [] });
  assert.deepEqual(wet.mobility.fallSave, { available: true, blockedBy: [] });
  assert.equal(wet.mobility.waterBuckets, 1);
  // A stocked bot pays no standing text for a capability it already has.
  assert.match(report(carried), /### Mobility\n- Water buckets carried: 1\n- Scaffold placement/);

  // A full bucket is no help where the pour boils off before anything lands in it.
  Object.assign(carried.game, { dimension: "the_nether" });
  const nether = observeLiveSituation(carried, data(), idleActivity);
  assert.deepEqual(nether.mobility.bucketDrop.blockedBy, ["water_evaporates_here"]);
  assert.equal(nether.mobility.waterBuckets, 1);
  assert.match(
    report(carried),
    /- Water buckets carried: 1; no planned bucket drops or emergency fall saves \(water evaporates in this dimension\)/,
  );

  // Nothing admitted to place: the route keeps its drops and loses its climbs.
  const unarmed = liveBot();
  unarmed.inventory.items = () => [stack(36, "stone_pickaxe", 1)] as never;
  const noScaffold = observeLiveSituation(unarmed, data(), idleActivity);
  assert.deepEqual(noScaffold.mobility.scaffold, { available: false, item: null, blocks: 0, blockedBy: ["no_scaffold_block"] });
  assert.match(
    report(unarmed),
    /- Scaffold placement \(pillar up, bridge gaps\): unavailable \(no admitted scaffold block carried\)/,
  );
});
