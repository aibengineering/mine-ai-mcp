import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { botFixture } from "../../test-support/bot.js";
import { type LoadedBlock, loadedObservation } from "../../navigation/world/world.js";
import { TERRAIN_BREAK_PENALTY } from "../../navigation/mineflayer/movement-policy.js";
import { blockClass, observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import { createCollectionMovements, type CollectionMovementOptions } from "./collection-movements.js";
import { flatWorld } from "../../test-support/navigation.js";
import { createMovements } from "../../navigation/runtime.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";

/** Air around the origin: no liquid beside any cell these tests break. */
const world = flatWorld();

function observation(stateId: number): LoadedBlock {
  return loadedObservation(stateId, [], {
    empty: false,
    liquid: null,
    liquidSource: false,
    waterlogged: false,
    waterloggable: false,
    climbable: false,
    openable: false,
    open: false,
    activationGroup: null,
    upperHalf: false,
    falling: false,
    yielding: false,
    damaging: false,
    interactive: false,
    parkourTakeoff: "normal",
    safeToBreak: true,
  });
}

function collectionBot(harvestable: boolean) {
  // A pickaxe is what makes stone harvestable; without one the registry says no tool can.
  const items = [
    { name: "dirt", count: 2 },
    { name: "cobblestone", count: 3 },
  ];
  if (harvestable) items.push({ name: "iron_pickaxe", count: 1 });
  return botFixture({ items });
}

/** The policy Collect builds, with only the constraint under test named. */
function collectionPolicy(bot: Bot, options: Partial<CollectionMovementOptions> = {}) {
  return createCollectionMovements(bot, {
    exactTarget: null,
    matchingStateIds: new Set(),
    protectedBlockNames: [],
    protectedScaffoldNames: [],
    scaffolding: false,
    ...options,
  });
}

test("expresses Collect's constraints through the production policy factory", () => {
  const bot = collectionBot(true);
  const policy = collectionPolicy(bot, {
    protectedBlockNames: ["oak_log"],
    protectedScaffoldNames: ["cobblestone"],
    scaffolding: true,
  });

  assert.equal(policy.maximumDrop, 3);
  assert.equal(policy.allowDoors, true);
  assert.equal(policy.allowParkour, true);
  assert.equal(policy.scaffold?.itemType, bot.registry.itemsByName.dirt.id);
  assert.equal(
    policy.evaluateBreak(observation(bot.registry.blocksByName.oak_log.defaultState), { x: 2, y: 64, z: 0 }, world)
      .decision.kind,
    "prohibited",
  );
  // A walking route pays a stiff penalty per block destroyed so it goes round a
  // wall instead of through it. Collection's whole purpose is removing blocks,
  // so it carries Baritone's mining figure instead — the same penalty on a
  // collect route would price its own job out of every plan.
  const breaking = policy.evaluateBreak(
    observation(bot.registry.blocksByName.stone.defaultState),
    { x: 0, y: 63, z: 0 },
    world,
  ).decision;
  assert.deepEqual(breaking, { kind: "penalized", reason: "prefer a route that preserves terrain", cost: 2 });
  assert.ok(breaking.kind === "penalized" && breaking.cost < TERRAIN_BREAK_PENALTY);
});

test("collects a requested door without giving navigation permission to mine other passages", () => {
  const bot = collectionBot(true);
  const birch = observation(bot.registry.blocksByName.birch_door.defaultState);
  const oak = observation(bot.registry.blocksByName.oak_door.defaultState);
  const birchDoor = { ...birch, traits: { ...birch.traits, openable: true } };
  const oakDoor = { ...oak, traits: { ...oak.traits, openable: true } };
  const position = { x: 2, y: 64, z: 0 };
  const policy = collectionPolicy(bot, { matchingStateIds: new Set([birch.stateId]) });
  assert.equal(policy.allowDoors, true);
  assert.equal(policy.evaluateBreak(birchDoor, position, world).decision.kind, "penalized");
  assert.equal(policy.evaluateBreak(oakDoor, position, world).decision.kind, "prohibited");
  assert.equal(createMovements(bot).evaluateBreak(birchDoor, position, world).decision.kind, "prohibited");

  const wet = new MemoryWorld();
  wet.load(
    { x: 3, y: 64, z: 0 },
    { stateId: bot.registry.blocksByName.lava.minStateId, traits: { liquid: "lava", liquidSource: true } },
  );
  const flood = policy.evaluateBreak(birchDoor, position, wet).decision;
  assert.equal(flood.kind === "prohibited" && flood.cause, "opens_into_liquid");
  assert.equal(
    policy.evaluateBreak({ ...birchDoor, traits: { ...birchDoor.traits, safeToBreak: false } }, position, world)
      .decision.kind,
    "prohibited",
  );
  const protectedDoor = collectionPolicy(bot, {
    matchingStateIds: new Set([birch.stateId]),
    protectedBlockNames: ["birch_door"],
  });
  assert.equal(protectedDoor.evaluateBreak(birchDoor, position, world).decision.kind, "prohibited");
});

test("requires a harvestable route block and disables scaffolding when requested", () => {
  const bot = collectionBot(false);
  const policy = collectionPolicy(bot);

  assert.equal(policy.scaffold, null);
  assert.equal(policy.allowPlacing, false);
  assert.deepEqual(
    policy.evaluateBreak(observation(bot.registry.blocksByName.stone.defaultState), { x: 2, y: 64, z: 0 }, world)
      .decision,
    { kind: "prohibited", reason: "no carried tool can harvest this block" },
  );
});

test("evaluates a break from the registry with one inventory sweep, then from cache", () => {
  const bot = collectionBot(true);
  let blockReads = 0;
  let inventoryReads = 0;
  const originalBlockAt = bot.blockAt.bind(bot);
  const originalItems = bot.inventory.items.bind(bot.inventory);
  bot.blockAt = ((...args: Parameters<Bot["blockAt"]>) => {
    blockReads += 1;
    return originalBlockAt(...args);
  }) as Bot["blockAt"];
  bot.inventory.items = (() => {
    inventoryReads += 1;
    return originalItems();
  }) as Bot["inventory"]["items"];
  const policy = collectionPolicy(bot);

  policy.evaluateBreak(observation(bot.registry.blocksByName.stone.defaultState), { x: 2, y: 64, z: 0 }, world);
  policy.evaluateBreak(observation(bot.registry.blocksByName.stone.defaultState), { x: 3, y: 64, z: 0 }, world);

  assert.equal(blockReads, 0);
  assert.equal(inventoryReads, 1);
});

test("only the requested interactive block state may be broken, and only at a named cell", () => {
  const bot = collectionBot(true);
  const Block = blockClass(bot);
  const chestBlock = Block.fromStateId(bot.registry.blocksByName.chest.defaultState, 0);
  const chest = observeMineflayerBlock(chestBlock);
  const table = observeMineflayerBlock(Block.fromStateId(bot.registry.blocksByName.crafting_table.defaultState, 0));
  const position = { x: 2, y: 64, z: 0 };

  for (const [requested, other] of [
    [chest, table],
    [table, chest],
  ]) {
    const policy = collectionPolicy(bot, { matchingStateIds: new Set([requested!.stateId]) });
    assert.equal(policy.evaluateBreak(requested!, position, world).decision.kind, "penalized");
    assert.equal(policy.evaluateBreak(other!, position, world).decision.kind, "prohibited");
  }

  // An exact target names one cell; another chest of the same state is not it.
  bot.blockAt = () => chestBlock;
  const exact = collectionPolicy(bot, {
    exactTarget: new Vec3(4, 64, 0),
    matchingStateIds: new Set([chest.stateId]),
  });
  assert.equal(exact.evaluateBreak(chest, { x: 4, y: 64, z: 0 }, world).decision.kind, "penalized");
  assert.equal(exact.evaluateBreak(chest, position, world).decision.kind, "prohibited");
});
