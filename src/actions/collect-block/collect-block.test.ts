import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { formatCollectBlockResult, parseCollectBlockRequest } from "./index.js";
import type { Bot } from "mineflayer";
import { inventoryStop, pursuedInventoryStop, settle } from "./collect-block.js";

test("capacity admission allows a clearing break with free space or a compatible partial stack", () => {
  let empty = 4;
  const stacks = [{ name: "cobbled_deepslate", count: 63, stackSize: 64 }];
  const bot = {
    inventory: { inventoryStart: 9, inventoryEnd: 45, emptySlotCount: () => empty, items: () => stacks },
  } as unknown as Bot;
  const request = parseCollectBlockRequest({ block_name: "deepslate", count: 1 });
  const collectable = new Set(["cobbled_deepslate"]);
  assert.equal(inventoryStop(bot, request, collectable), null);
  empty = 0;
  assert.equal(inventoryStop(bot, request, collectable), null);
  stacks[0]!.count = 64;
  assert.match(inventoryStop(bot, request, collectable) ?? "", /INVENTORY_FULL.*no room in a stack of cobbled_deepslate/);
  assert.equal(inventoryStop(bot, { ...request, allowFullInventory: true }, collectable), null);
});

/**
 * The stall behind "mine one log, stand on it for five minutes, mine another":
 * a spare birch slot satisfied the set-wide check while the oak log on the
 * ground had nowhere to go, so the run waited for the server to despawn it.
 */
test("a running collection asks whether the drop being walked to can enter, not whether any matching stack can", () => {
  const stacks = [{ name: "birch_log", count: 3, stackSize: 64 }];
  const bot = {
    inventory: { inventoryStart: 9, inventoryEnd: 45, emptySlotCount: () => 0, items: () => stacks },
    entities: {
      7: { id: 7, name: "item", getDroppedItem: () => ({ name: "oak_log" }) },
      8: { id: 8, name: "item", getDroppedItem: () => ({ name: "birch_log" }) },
    },
  } as unknown as Bot;
  const request = parseCollectBlockRequest({ block_name: "logs", count: 4 });
  const collectable = new Set(["oak_log", "birch_log"]);
  const drop = (entityId: number) => ({ kind: "drop" as const, entityId, position: { x: 0, y: 64, z: 0 } });
  // With nothing on the ground yet, only the set can be asked, and birch answers for it.
  assert.equal(pursuedInventoryStop(bot, request, collectable, []), null);
  assert.equal(pursuedInventoryStop(bot, request, collectable, [drop(8)]), null);
  assert.match(
    pursuedInventoryStop(bot, request, collectable, [drop(7)]) ?? "",
    /INVENTORY_FULL.*no room in a stack of oak_log/,
  );
  assert.equal(pursuedInventoryStop(bot, { ...request, allowFullInventory: true }, collectable, [drop(7)]), null);
});

test("sixteen obsidian cannot conceal a casting bucket absent from the final inventory", () => {
  const stacks = [{ name: "obsidian", count: 16 }];
  const bot = { inventory: { items: () => stacks } } as unknown as Bot;
  const request = parseCollectBlockRequest({ block_name: "obsidian", count: 16 });
  const result = settle(bot, request, { water_bucket: 1 }, new Set(["obsidian"]), new Vec3(0, 0, 0), {
    status: "satisfied",
    broken: [],
    reason: null,
  });
  assert.equal(result.status, "partial");
  assert.equal(result.collected.gained, 16);
  assert.match(result.error ?? "", /CASTING_BUCKET_MISSING.*1 to 0/);
  stacks.push({ name: "bucket", count: 1 });
  assert.equal(
    settle(bot, request, { water_bucket: 1 }, new Set(["obsidian"]), new Vec3(0, 0, 0), {
      status: "satisfied",
      broken: [],
      reason: null,
    }).status,
    "succeeded",
  );
});

test("collect_block presents collection evidence as Markdown", () => {
  const markdown = formatCollectBlockResult({
    status: "partial",
    error: "One drop was not recovered.",
    collected: {
      requested: 3,
      gained: 2,
      gainedByItem: { oak_log: 2 },
      blocksBroken: 3,
      brokenAt: [
        { x: 102, y: 4, z: 92, distanceFromStart: 1.4 },
        { x: 102, y: 5, z: 92, distanceFromStart: 2.1 },
        { x: 86, y: -55, z: 94, distanceFromStart: 61.3 },
      ],
    },
  });

  assert.match(markdown, /Inventory gained: 2/);
  assert.match(markdown, /Matching blocks broken: 3\n  - 102,4,92 \(1\.4 blocks from the start\)\n  - 102,5,92/);
  assert.match(markdown, /86,-55,94 \(61\.3 blocks from the start\)/);
  assert.match(markdown, /`oak_log`: 2/);
  assert.match(markdown, /Observed stop.*One drop was not recovered/s);
});

test("collect_block parses MCP arguments into its normalized action model", () => {
  assert.deepEqual(
    parseCollectBlockRequest({
      block_name: " MINECRAFT:OAK_LOG ",
      count: 4,
      scaffold: false,
      allow_full_inventory: true,
    }),
    {
      selector: "oak_log",
      requested: 4,
      exactTarget: null,
      scaffolding: false,
      allowFullInventory: true,
      onToolLoss: "stop",
    },
  );
  // Naming a cell means that one block, whatever count was asked for.
  assert.deepEqual(parseCollectBlockRequest({ block_name: "oak_log", count: 4, x: 8, y: 64, z: -3 }), {
    selector: "oak_log",
    requested: 1,
    exactTarget: new Vec3(8, 64, -3),
    scaffolding: true,
    allowFullInventory: false,
    onToolLoss: "stop",
  });
  assert.throws(() => parseCollectBlockRequest({ block_name: "minecraft:" }), /must identify a block/);
  assert.throws(
    () => parseCollectBlockRequest({ block_name: "minecraft:water" }),
    /minecraft:water is not a mineable block/,
  );
});
