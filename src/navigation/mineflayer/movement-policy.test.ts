import { HORIZONTAL_TICKS_PER_BLOCK } from "../goals/index.js";
import { createMovements } from "../runtime.js";
import { BREAK_OPENS_INTO_LIQUID } from "../movements/policy.js";
import { MemoryWorld } from "../world/memory-world.js";
import { type LoadedBlock, loadedObservation } from "../world/world.js";
import { TERRAIN_BREAK_PENALTY } from "./movement-policy.js";
import { blockClass, observeMineflayerBlock } from "./world.js";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { botFixture, type FakeBot, type FakeStack } from "../../test-support/bot.js";
import { flatWorld } from "../../test-support/navigation.js";

/** Air around the origin: no liquid beside any cell these tests break. */
const world = flatWorld();

function loadedBlock(stateId: number): LoadedBlock {
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

/** A bot carrying `items`, whose every world block digs in half a second, as `name` does. */
function diggingBot(name: string, items: FakeStack[] = []): FakeBot {
  const bot = botFixture({ items });
  const block = bot.registry.blocksByName[name]!;
  bot.blockAt = () =>
    ({ type: block.id, digTime: () => 500, canHarvest: () => true }) as unknown as NonNullable<
      ReturnType<Bot["blockAt"]>
    >;
  return bot;
}

/** One block as Prismarine reports it at its default state. */
function observed(bot: FakeBot, name: string) {
  return observeMineflayerBlock(blockClass(bot).fromStateId(bot.registry.blocksByName[name]!.defaultState, 0));
}

test("builds an immutable Mineflayer-backed movement policy without a legacy Pathfinder", () => {
  const registry = minecraftData("1.21.4");
  const dirt = { type: registry.itemsByName.dirt.id, name: "dirt", count: 3 };
  const bot = diggingBot("wheat", [dirt]);

  const policy = createMovements(bot);

  assert.equal(Object.isFrozen(policy), true);
  assert.equal(policy.allowDigging, true);
  assert.equal(policy.allowDoors, true);
  assert.equal(policy.allowParkour, true);
  assert.equal(policy.allowSprinting, true);
  assert.equal(policy.maximumDrop, 3);
  assert.equal(policy.placementPenalty, 20);
  assert.equal(policy.scaffold?.itemType, dirt.type);
  assert.deepEqual(
    policy.evaluateBreak(loadedBlock(registry.blocksByName.wheat.defaultState), { x: 1, y: 64, z: 1 }, world).decision,
    { kind: "prohibited", reason: "movement policy prohibits breaking this block" },
  );
});

test("a caller's option changes only what it names", () => {
  assert.equal(createMovements(botFixture(), { allowSprinting: false }).allowSprinting, false);
  const priced = createMovements(botFixture(), { placementPenalty: 80 });
  assert.equal(priced.placementPenalty, 80);
  assert.equal(priced.allowPlacing, true, "pricing scaffold use does not disable necessary placement");
  const walking = createMovements(botFixture(), { allowDigging: false });
  assert.equal(walking.allowDigging, false);
  assert.equal(walking.allowDoors, true, "forbidding excavation does not disable door interaction");
});

test("the scaffold is whatever the inventory holds when it is read, and names the state each face gives", () => {
  const registry = minecraftData("1.21.4");
  const netherrack = { type: registry.itemsByName.netherrack.id, name: "netherrack", count: 32 };
  const nether = botFixture({ items: [netherrack] });
  assert.deepEqual(createMovements(nether).scaffold, {
    itemType: netherrack.type,
    stateId: registry.blocksByName.netherrack.defaultState,
  });
  assert.equal(createMovements(nether, { protectedScaffoldNames: ["netherrack"] }).scaffold, null);
  assert.equal(createMovements(nether, { scaffolding: false }).scaffold, null);

  // An axis block such as basalt is a different state per placement face.
  const basalt = registry.blocksByName.basalt;
  const axis = createMovements(
    botFixture({ items: [{ type: registry.itemsByName.basalt.id, name: "basalt", count: 9 }] }),
  );
  assert.deepEqual(axis.scaffold, {
    itemType: registry.itemsByName.basalt.id,
    stateId: basalt.defaultState,
    stateIdByAxis: { x: basalt.minStateId, y: basalt.defaultState, z: basalt.maxStateId },
  });
  const cobblestone = { type: registry.itemsByName.cobblestone.id, name: "cobblestone", count: 16 };
  assert.equal("stateIdByAxis" in (createMovements(botFixture({ items: [cobblestone] })).scaffold ?? {}), false);

  const carried = [
    { ...netherrack, count: 35 },
    cobblestone,
    { type: registry.itemsByName.basalt.id, name: "basalt", count: 3 },
  ];
  const policy = createMovements(botFixture({ items: carried }));
  assert.equal(policy.scaffold?.itemType, cobblestone.type, "policy order wins over the largest stack");
  carried.splice(1, 1);
  assert.equal(policy.scaffold?.itemType, netherrack.type);
  carried.shift();
  assert.equal(policy.scaffold?.itemType, registry.itemsByName.basalt.id);
  carried.length = 0;
  assert.equal(policy.scaffold, null);
  assert.equal(policy.allowPlacing, true);
});

test("prices a walking route's terrain damage well above a tie-break", () => {
  // Baritone's `blockBreakAdditionalPenalty` is two, about half a block of
  // sprinting, which only settles ties between equally fast routes. A bot told
  // to walk somewhere took that as licence to open a hole in a house wall
  // rather than use the door beside it, so the walking default is the price of
  // several blocks of travel instead.
  const bot = diggingBot("stone");
  const breaking = createMovements(bot).evaluateBreak(
    loadedBlock(bot.registry.blocksByName.stone.defaultState),
    { x: 1, y: 64, z: 1 },
    world,
  ).decision;

  assert.equal(breaking.kind, "penalized");
  if (breaking.kind !== "penalized") return;
  assert.equal(breaking.cost, TERRAIN_BREAK_PENALTY);
  assert.ok(breaking.cost > HORIZONTAL_TICKS_PER_BLOCK * 4);
});

/**
 * The refusal is named, and it comes with the tool the break would have used.
 * A route break stays refused; a caller that owns a *target* break tells this
 * prohibition apart from an unbreakable block and seals the cell first, which
 * is what makes obsidian beside lava obtainable at all.
 */
test("a break is refused exactly when it would open a path into liquid", () => {
  const bot = botFixture();
  const policy = createMovements(bot);
  const stone = loadedBlock(bot.registry.blocksByName.stone.defaultState);
  const water = bot.registry.blocksByName.water;
  const position = { x: 2, y: 40, z: 3 };
  const opensIntoLiquid = { kind: "prohibited", cause: "opens_into_liquid", reason: BREAK_OPENS_INTO_LIQUID };

  const source = new MemoryWorld();
  source.load({ x: 3, y: 40, z: 3 }, { stateId: water.minStateId, traits: { liquid: "water", liquidSource: true } });
  const evaluation = policy.evaluateBreak(stone, position, source);
  assert.deepEqual(evaluation.decision, opensIntoLiquid);
  assert.ok(evaluation.tool.expectedTicks > 1);

  // Stable downward-flowing water is not a source, and Baritone mines beside it.
  const flowing = { stateId: water.minStateId + 1, traits: { liquid: "water" as const, liquidSource: false } };
  const falling = new MemoryWorld();
  falling.load({ x: 3, y: 40, z: 3 }, flowing);
  falling.load({ x: 3, y: 39, z: 3 }, flowing);
  assert.equal(policy.evaluateBreak(stone, position, falling).decision.kind, "penalized");

  // The new downward path is refused for any liquid, at any level, on any side
  // of the cell above it, whether or not that cell is walkable.
  const nylium = loadedBlock(bot.registry.blocksByName.warped_nylium.defaultState);
  for (const aboveName of ["air", "nether_sprouts"])
    for (const liquidName of ["water", "lava"])
      for (const level of [0, 3, 8])
        for (const [dx, dz] of [
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ] as const) {
          const beside = new MemoryWorld();
          beside.load({ x: 2, y: 41, z: 3 }, observed(bot, aboveName));
          beside.load(
            { x: 2 + dx, y: 41, z: 3 + dz },
            observeMineflayerBlock(
              blockClass(bot).fromStateId(bot.registry.blocksByName[liquidName]!.minStateId + level, 0),
            ),
          );
          assert.deepEqual(
            policy.evaluateBreak(nylium, position, beside).decision,
            opensIntoLiquid,
            `${aboveName}, ${liquidName}[level=${level}], offset ${dx},${dz}`,
          );
        }

  // A solid cell above still separates the upper liquid, so nothing opens.
  const separated = new MemoryWorld();
  separated.load({ x: 2, y: 41, z: 3 }, observed(bot, "stone"));
  separated.load(
    { x: 3, y: 41, z: 3 },
    observeMineflayerBlock(blockClass(bot).fromStateId(bot.registry.blocksByName.lava.minStateId + 3, 0)),
  );
  assert.equal(policy.evaluateBreak(stone, position, separated).decision.kind, "penalized");
});

test("uses the production world policy to reject lava steps", () => {
  const bot = botFixture();
  const lava = loadedBlock(bot.registry.blocksByName.lava.defaultState);
  const observation = { ...lava, traits: { ...lava.traits, liquid: "lava" as const } };
  const lavaWorld = { blockAt: () => observation, subscribe: () => () => {}, revision: 0 };

  assert.equal(createMovements(bot).decideStep(1, 64, 1, lavaWorld).kind, "prohibited");
});

test("routes preserve what a player built or uses, while terrain stays diggable", () => {
  const bot = botFixture();
  const policy = createMovements(bot);
  const position = { x: 0, y: 64, z: 0 };
  for (const name of ["chest", "crafting_table", "barrel", "furnace", "shulker_box"]) {
    const block = observed(bot, name);
    assert.equal(block.traits.interactive, true, name);
    assert.equal(policy.evaluateBreak(block, position, world).decision.kind, "prohibited", name);
  }
  assert.equal(policy.evaluateBreak(observed(bot, "stone"), position, world).decision.kind, "penalized");

  // A spawner is preserved too, until removing it is what was asked for.
  const spawner = observed(bot, "spawner");
  assert.equal(policy.evaluateBreak(spawner, position, world).decision.kind, "prohibited");
  assert.equal(
    createMovements(bot, { isRequestedBreak: () => true }).evaluateBreak(spawner, position, world).decision.kind,
    "penalized",
  );
});


test("scaffold admission follows other mobs moving into and out of a placement cell", () => {
  const bot = botFixture();
  const target = { x: 1, y: 64, z: 0 };
  const mob = Object.assign({}, bot.entity, { id: 77, name: "enderman", type: "mob", isValid: true,
    width: 0.6, height: 2.9, position: bot.entity.position.clone().set(1.1, 64, 0.5) });
  bot.entities[mob.id] = mob;
  const policy = createMovements(bot);
  const occupied = policy.decidePlace(target.x, target.y, target.z, world);
  assert.equal(occupied.kind, "prohibited");
  if (occupied.kind === "prohibited") assert.match(occupied.reason, /enderman #77/);
  mob.position.x = 3;
  assert.equal(policy.decidePlace(target.x, target.y, target.z, world).kind, "allowed");
  mob.position.x = 1.1;
  assert.equal(policy.decidePlace(target.x, target.y, target.z, world).kind, "prohibited");
});
