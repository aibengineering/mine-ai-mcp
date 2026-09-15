import { MemoryWorld as GoalTestWorld } from "../../navigation/world/memory-world.js";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture, type FakeStack } from "../../test-support/bot.js";
import { parsePlaceBlockRequest } from "./contract.js";
import { formatPlaceBlockResult, executePlaceBlock, type PlaceBlockDependencies } from "./place-block.js";

const goalTestWorld = new GoalTestWorld();

function key(position: Vec3): string {
  return `${position.x},${position.y},${position.z}`;
}

function testWorld(targetName = "air", carried = 2) {
  const target = new Vec3(2, 64, 0);
  const blocks = new Map<string, any>([
    [key(target), { name: targetName, boundingBox: targetName === "air" ? "empty" : "block", position: target }],
    [key(target.offset(0, -1, 0)), { name: "stone", boundingBox: "block", position: target.offset(0, -1, 0) }],
  ]);
  const items: FakeStack[] = carried > 0 ? [{ name: "cobblestone", count: carried }] : [];
  const bot = botFixture(
    { items, position: { x: 0, y: 64, z: 0 } },
    { blockAt: (position: Vec3) => blocks.get(key(position)) ?? { name: "air", boundingBox: "empty", position } },
  );
  /** What the server's own broadcast does: change the count, then say so. */
  const takeOneFromInventory = () => {
    items[0]!.count -= 1;
    if (items[0]!.count === 0) items.pop();
    bot.inventory.emit("updateSlot");
  };
  const dependencies: PlaceBlockDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    placeBlock: async (_bot, placement) => {
      assert.deepEqual(placement.support.position, target.offset(0, -1, 0));
      assert.deepEqual(placement.face, new Vec3(0, 1, 0));
      takeOneFromInventory();
      const placed = { name: "cobblestone", boundingBox: "block", position: target };
      blocks.set(key(target), placed);
      return { kind: "placed", block: placed } as never;
    },
    placeNearby: async () => {
      const chosen = new Vec3(1, 64, 0);
      takeOneFromInventory();
      const placed = { name: "cobblestone", boundingBox: "block", position: chosen };
      blocks.set(key(chosen), placed);
      return { kind: "placed", position: chosen, block: placed as never };
    },
  };
  return { bot, blocks, dependencies, target, takeOneFromInventory };
}

test("parses one normalized block name and exact absolute target", () => {
  assert.deepEqual(parsePlaceBlockRequest({ block_name: "Minecraft:Cobble Stone", x: 2, y: 64, z: 0 }), {
    blockName: "cobble_stone",
    target: { x: 2, y: 64, z: 0 },
  });
  assert.deepEqual(parsePlaceBlockRequest({ block_name: "crafting_table" }), {
    blockName: "crafting_table",
    target: null,
  });
  assert.throws(() => parsePlaceBlockRequest({ block_name: "crafting_table", x: 1 }), /all of x, y, and z/);
});

test("chooses a cell beside the bot when no target is given", async () => {
  const { bot, dependencies } = testWorld();
  const result = await executePlaceBlock(bot, { blockName: "cobblestone", target: null }, {}, dependencies);

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.placement.target, { x: 1, y: 64, z: 0 });
  assert.equal(result.placement.placed, true);
  assert.equal(result.placement.inventoryAfter, 1);
});

test("places against the supporting block below and verifies world and inventory evidence", async () => {
  const { bot, dependencies } = testWorld();
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    dependencies,
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(result.placement, {
    dimension: "overworld",
    requestedBlock: "cobblestone",
    target: { x: 2, y: 64, z: 0 },
    beforeBlock: "air",
    afterBlock: "cobblestone",
    inventoryBefore: 2,
    inventoryAfter: 1,
    confirmed: true,
    placed: true,
    support: { x: 2, y: 63, z: 0 },
    face: { x: 0, y: 1, z: 0 },
  });
  assert.match(formatPlaceBlockResult(result), /Placed \*\*cobblestone\*\*/);
});

test("an exact target inside the bot's body requires movement before placement", async () => {
  const { bot, dependencies, target } = testWorld();
  bot.entity.position = target.offset(0.5, 0, 0.5);
  let moved = false;
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target },
    {},
    {
      ...dependencies,
      navigate: async ({ goal }) => {
        const feet = { x: 3, y: 64, z: 0 };
        const node = { feet, remainingScaffolds: 0, overlayId: "0" };
        for (const y of [64, 63.875]) {
          const straddling = goal.resolve({ position: new Vec3(3.1, y, 0.5), stance: "supported" } as never);
          const clear = goal.resolve({ position: new Vec3(3.4, y, 0.5), stance: "supported" } as never);
          assert.equal(straddling.kind, "active");
          assert.equal(clear.kind, "active");
          if (straddling.kind === "active" && clear.kind === "active") {
            assert.equal(
              straddling.isSatisfied(node, goalTestWorld),
              false,
              `the actual body overlaps at floor y=${y}`,
            );
            assert.equal(clear.isSatisfied(node, goalTestWorld), true);
            assert.notEqual(straddling.revision, clear.revision);
          }
        }
        moved = true;
        bot.entity.position = target.offset(1.5, 0, 0.5);
        return { status: "completed", elapsedMs: 0 };
      },
      placeBlock: async (...args) => {
        assert.equal(moved, true);
        return dependencies.placeBlock(...args);
      },
    },
  );
  assert.equal(result.status, "succeeded");
});

test("a reported arrival that still overlaps the target does not send a placement", async () => {
  const { bot, dependencies, target } = testWorld();
  bot.entity.position = target.offset(0.5, 0, 0.5);
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target },
    {},
    {
      ...dependencies,
      placeBlock: async () => {
        throw new Error("must not place through the bot");
      },
    },
  );
  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /body still intersects/);
});

/** Place the block and report it, but leave the slot for the server to redraw later. */
function placeWithoutSlotUpdate(target: Vec3, blocks: Map<string, any>): PlaceBlockDependencies["placeBlock"] {
  return async () => {
    const placed = { name: "cobblestone", boundingBox: "block", position: target };
    blocks.set(key(target), placed);
    return { kind: "placed", block: placed } as never;
  };
}

test("waits for the slot update the server sends after the block update", async () => {
  const { bot, blocks, dependencies, target, takeOneFromInventory } = testWorld();
  // The block update resolved `placeBlock`; the slot that loses the block is
  // broadcast two ticks later.
  setTimeout(takeOneFromInventory, 100);

  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    { ...dependencies, placeBlock: placeWithoutSlotUpdate(target, blocks) },
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    [result.placement.inventoryBefore, result.placement.inventoryAfter, result.placement.confirmed],
    [2, 1, true],
  );
});

test("says so rather than presenting a placement count the server never confirmed", async () => {
  const { bot, blocks, dependencies, target } = testWorld();

  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    { ...dependencies, placeBlock: placeWithoutSlotUpdate(target, blocks) },
  );

  assert.equal(result.status, "succeeded");
  assert.deepEqual(
    [result.placement.inventoryBefore, result.placement.inventoryAfter, result.placement.confirmed],
    [2, 2, false],
  );
  assert.match(formatPlaceBlockResult(result), /had not confirmed this count within the deadline/);
});

test("treats an already matching target as satisfied without consuming inventory", async () => {
  const { bot, dependencies } = testWorld("cobblestone");
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    dependencies,
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.placement.placed, false);
  assert.equal(result.placement.inventoryAfter, 2);
  assert.match(formatPlaceBlockResult(result), /already present/);
});

test("refuses to overwrite an occupied target", async () => {
  const { bot, dependencies } = testWorld("dirt");
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    dependencies,
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /^\[PLACE_TARGET_OCCUPIED\]/);
  assert.equal(result.placement.afterBlock, "dirt");
});

test("refuses placement when the carried block is absent", async () => {
  const { bot, dependencies } = testWorld("air", 0);
  const result = await executePlaceBlock(
    bot,
    { blockName: "cobblestone", target: { x: 2, y: 64, z: 0 } },
    {},
    dependencies,
  );

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.match(result.error, /^\[PLACE_ITEM_MISSING\]/);
});
