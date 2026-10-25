import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { collectBlockInputSchema, formatCollectBlockResult, parseCollectBlockRequest } from "./index.js";
import type { Navigate, NavigationRuntime } from "../../navigation/index.js";
import { blockReader } from "../../navigation/mineflayer/world.js";
import { botFixture, type FakeStack } from "../../test-support/bot.js";
import { blockNamed } from "../../test-support/world.js";
import { collectBlock, inventoryStop, pursuedInventoryStop, settle } from "./collect-block.js";

test("capacity admission allows a clearing break with free space or a compatible partial stack", () => {
  let empty = 4;
  const stacks = [{ name: "cobbled_deepslate", count: 63, stackSize: 64 }];
  const bot = botFixture({ items: stacks });
  bot.inventory.emptySlotCount = () => empty;
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
  const bot = botFixture({
    items: stacks,
    entities: {
      7: { id: 7, name: "item", getDroppedItem: () => ({ name: "oak_log" }) },
      8: { id: 8, name: "item", getDroppedItem: () => ({ name: "birch_log" }) },
    },
  });
  bot.inventory.emptySlotCount = () => 0;
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
  const bot = botFixture({ items: stacks });
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
  assert.deepEqual(parseCollectBlockRequest({ block_name: "oak_log", x: 8, y: 64, z: -3 }), {
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

test("exact collection accepts one or omitted count and rejects larger counts at the input boundary", () => {
  const target = { block_name: "coal_ore", x: 6, y: -59, z: 0 };
  assert.equal(collectBlockInputSchema.parse(target).count, 1);
  assert.equal(collectBlockInputSchema.parse({ ...target, count: 1 }).count, 1);
  assert.equal(collectBlockInputSchema.parse({ block_name: "coal_ore", count: 3 }).count, 3);

  for (const count of [2, 3, 32]) {
    const result = collectBlockInputSchema.safeParse({ ...target, count });
    assert.ok(!result.success, "Contradictory exact-target count was accepted");
    assert.deepEqual(result.error.issues.map(({ path, message }) => ({ path, message })), [{
      path: ["count"],
      message: "Exact coordinates select one block. Omit count or set it to 1. To collect multiple blocks, omit x, y, and z.",
    }]);
  }
});

/**
 * The tool-loss-policy fixture's three cases, at the collection boundary: a
 * diamond pickaxe one use from breaking (`damage=1560`) breaks on the first
 * stone, and the bot carries a stone pickaxe, or nothing else. The tier rule
 * itself lives in tool-loss.test.ts; this pins that collection selects its
 * tools through the observer and lets `on_tool_loss` choose between stopping
 * the route and finishing with what remains.
 */
test("collection stops on the selected pickaxe's tier loss unless on_tool_loss continues", async () => {
  for (const { onToolLoss, backup } of [
    { onToolLoss: "stop", backup: true },
    { onToolLoss: "continue", backup: true },
    { onToolLoss: "stop", backup: false },
  ] as const) {
    const target = new Vec3(8, 64, 0);
    let targetBlock = "stone";
    // Real Prismarine blocks: break rules read what Mineflayer reports, such as `diggable`.
    const nameAt = (cell: Vec3) => (cell.equals(target) ? targetBlock : cell.y <= 63 ? "stone" : "air");
    const items: FakeStack[] = [{ name: "diamond_pickaxe", count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 1560 }];
    if (backup) items.push({ name: "stone_pickaxe", count: 1, slot: 9, maxDurability: 131, durabilityUsed: 0 });
    const bot = botFixture({ items, blocks: (cell) => blockNamed(nameAt(cell.floored()), cell.floored()) as never });
    let stopped: boolean | null = null;
    const route: Navigate = async ({ stopSignal, onToolSelected }) => {
      // The route swings the diamond pickaxe at the stone and it breaks.
      onToolSelected?.(bot.registry.itemsByName.diamond_pickaxe!.id);
      items.splice(0, 1);
      bot.inventory.emit("updateSlot", 36, null);
      await Promise.resolve();
      stopped = stopSignal?.aborted ?? false;
      if (stopped) return { status: "stopped", reason: String(stopSignal!.reason), elapsedMs: 1 };
      // Continuing, the remaining pickaxe finishes the block and the drop is picked up.
      targetBlock = "air";
      items.push({ name: "cobblestone", count: 1, slot: 10 });
      bot.entity.position.set(8.5, 64, 0.5);
      return { status: "completed", elapsedMs: 1 };
    };
    const navigation = {
      navigate: route,
      breakBlockInPlace: async () => ({ status: "broken" }),
      world: { blockAt: blockReader(bot), revision: 0, onChange: () => () => undefined },
      cancel: () => undefined,
    } as unknown as NavigationRuntime;
    const request = parseCollectBlockRequest({
      block_name: "stone", x: target.x, y: target.y, z: target.z, scaffold: false, on_tool_loss: onToolLoss,
    });
    const result = await collectBlock(bot, navigation, request, {});
    const label = `${onToolLoss} with${backup ? "" : "out"} a stone pickaxe: ${JSON.stringify(result)}`;
    if (onToolLoss === "continue") {
      assert.equal(stopped, false, label);
      assert.equal(result.status, "succeeded", label);
      assert.equal(result.collected.gained, 1, label);
    } else {
      assert.equal(stopped, true, label);
      assert.notEqual(result.status, "succeeded", label);
      const remains = backup ? /diamond_pickaxe was lost.*stone pickaxe remains/ : /diamond_pickaxe was lost.*no pickaxe remains/;
      assert.match("error" in result ? result.error : "", new RegExp(`TOOL_TIER_LOST.*${remains.source}`), label);
    }
  }
});
