import assert from "node:assert/strict";
import test from "node:test";
import minecraftData from "minecraft-data";
import { botFixture } from "../test-support/bot.js";
import { formatToolChange, harvestTier, snapshotTools, toolChanges } from "./tool-tiers.js";

const registry = minecraftData("1.21.4");

test("uses registry harvest capability separately from mining speed", () => {
  const bot = botFixture({ registry } as never);
  assert.equal(harvestTier(bot, "golden_pickaxe"), harvestTier(bot, "wooden_pickaxe"));
  assert.ok(harvestTier(bot, "stone_pickaxe") > harvestTier(bot, "golden_pickaxe"));
  assert.ok(registry.materials["mineable/pickaxe"]![registry.itemsByName.golden_pickaxe!.id]! >
    registry.materials["mineable/pickaxe"]![registry.itemsByName.diamond_pickaxe!.id]!);
});

test("snapshots the best carried tier and exact remaining durability", () => {
  const bot = botFixture({ registry } as never);
  bot.inventory.items = () => [
    { name: "golden_pickaxe", slot: 9, maxDurability: 32, durabilityUsed: 0 },
    { name: "stone_pickaxe", slot: 10, maxDurability: 131, durabilityUsed: 126 },
    { name: "iron_pickaxe", slot: 11, maxDurability: 250, durabilityUsed: 240 },
    { name: "diamond_helmet", slot: 5, maxDurability: 363, durabilityUsed: 3 },
    { name: "water_bucket", slot: 12 },
  ] as never;
  const snapshot = snapshotTools(bot);
  assert.deepEqual(snapshot.tools.find((entry) => entry.class === "pickaxe"), {
    class: "pickaxe", tier: "iron", item: "iron_pickaxe", slot: 11, durabilityLeft: 10, maximumDurability: 250,
  });
  assert.equal(snapshot.tools.find((entry) => entry.class === "water_bucket")?.tier, "other");
  assert.equal(snapshot.armour.find((entry) => entry.class === "helmet")?.durabilityLeft, 360);
});

test("reports replacement and wear without inferring a break from batched inventory updates", () => {
  const before = { tools: [{ class: "pickaxe", tier: "diamond", item: "diamond_pickaxe", slot: 36, durabilityLeft: 1, maximumDurability: 1561 }], armour: [] } as never;
  const replacement = { tools: [{ class: "pickaxe", tier: "stone", item: "stone_pickaxe", slot: 9, durabilityLeft: 131, maximumDurability: 131 }], armour: [] } as never;
  const worn = { tools: [{ class: "pickaxe", tier: "stone", item: "stone_pickaxe", slot: 9, durabilityLeft: 120, maximumDurability: 131 }], armour: [] } as never;
  const changed = toolChanges(before, replacement)[0]!;
  assert.equal(changed.reason, "replaced");
  assert.equal(formatToolChange(changed), "pickaxe: diamond → stone");
  assert.equal(formatToolChange(toolChanges(replacement, worn)[0]!), "pickaxe durability 131 → 120");
});
