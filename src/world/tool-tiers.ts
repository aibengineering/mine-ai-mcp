import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { z } from "zod";

export const TOOL_CLASSES = ["pickaxe", "shovel", "axe", "sword", "hoe", "shears", "bow", "shield", "bucket", "water_bucket", "lava_bucket", "powder_snow_bucket"] as const;
export const ARMOUR_CLASSES = ["helmet", "chestplate", "leggings", "boots"] as const;
export type ToolClass = typeof TOOL_CLASSES[number];
export type ArmourClass = typeof ARMOUR_CLASSES[number];
export type EquipmentClass = ToolClass | ArmourClass;
export type EquipmentTier = "wooden" | "stone" | "iron" | "golden" | "diamond" | "netherite" | "leather" | "chainmail" | "turtle" | "other" | "none";

export interface ToolSnapshotEntry {
  class: EquipmentClass;
  tier: EquipmentTier;
  item: string | null;
  slot: number | null;
  durabilityLeft: number | null;
  maximumDurability: number | null;
}

export interface ToolSnapshot {
  tools: ToolSnapshotEntry[];
  armour: ToolSnapshotEntry[];
}

export const toolSnapshotEntrySchema = z.strictObject({
  class: z.enum([...TOOL_CLASSES, ...ARMOUR_CLASSES]),
  tier: z.enum(["wooden", "stone", "iron", "golden", "diamond", "netherite", "leather", "chainmail", "turtle", "other", "none"]),
  item: z.string().nullable(), slot: z.number().int().nullable(),
  durabilityLeft: z.number().int().nonnegative().nullable(), maximumDurability: z.number().int().positive().nullable(),
});
export const toolSnapshotSchema = z.strictObject({ tools: z.array(toolSnapshotEntrySchema), armour: z.array(toolSnapshotEntrySchema) });
export const toolChangeSchema = z.strictObject({
  class: z.enum([...TOOL_CLASSES, ...ARMOUR_CLASSES]), before: toolSnapshotEntrySchema, now: toolSnapshotEntrySchema,
  reason: z.enum(["broke", "replaced", "durability_used", "durability_restored", "acquired", "lost"]),
});

export interface ToolChange {
  class: EquipmentClass;
  before: ToolSnapshotEntry;
  now: ToolSnapshotEntry;
  reason: "broke" | "replaced" | "durability_used" | "durability_restored" | "acquired" | "lost";
}

const materialPrefix = /^(wooden|stone|iron|golden|diamond|netherite|leather|chainmail|turtle)_/;

function equipmentClass(name: string): EquipmentClass | null {
  if (name === "water_bucket" || name === "lava_bucket" || name === "powder_snow_bucket") return name;
  for (const value of [...TOOL_CLASSES, ...ARMOUR_CLASSES]) {
    if (name === value || name.endsWith(`_${value}`)) return value;
  }
  return null;
}

function equipmentTier(name: string): EquipmentTier {
  if (name === "shears" || name === "bow" || name === "shield" || name.endsWith("_bucket")) return "other";
  return (materialPrefix.exec(name)?.[1] as EquipmentTier | undefined) ?? "other";
}

function durability(item: Item): Pick<ToolSnapshotEntry, "durabilityLeft" | "maximumDurability"> {
  const maximum = item.maxDurability;
  const used = item.durabilityUsed;
  return Number.isFinite(maximum) && maximum > 0 && Number.isFinite(used)
    ? { durabilityLeft: Math.max(0, maximum - used), maximumDurability: maximum }
    : { durabilityLeft: null, maximumDurability: null };
}

/**
 * The registry's block material maps encode both speed and harvest capability.
 * Gold has wooden harvest capability despite its greater mining speed, so the
 * `incorrect_for_*` membership is the ordering source rather than item names.
 */
export function harvestTier(bot: Pick<Bot, "registry">, itemName: string): number {
  const id = bot.registry.itemsByName[itemName]?.id;
  if (id === undefined) return 0;
  const materials = bot.registry.materials as Record<string, Record<number, number> | undefined>;
  if (materials["incorrect_for_diamond_tool"]?.[id] !== undefined || itemName.startsWith("netherite_")) return 4;
  if (materials["incorrect_for_iron_tool"]?.[id] !== undefined) return 3;
  if (materials["incorrect_for_stone_tool"]?.[id] !== undefined) return 2;
  if (materials["incorrect_for_wooden_tool"]?.[id] !== undefined) return 1;
  return 0;
}

function speed(bot: Pick<Bot, "registry">, itemName: string, kind: EquipmentClass): number {
  const id = bot.registry.itemsByName[itemName]?.id;
  if (id === undefined) return 0;
  const materials = bot.registry.materials as Record<string, Record<number, number> | undefined>;
  return materials[`mineable/${kind}`]?.[id] ?? 0;
}

function empty(kind: EquipmentClass): ToolSnapshotEntry {
  return { class: kind, tier: "none", item: null, slot: null, durabilityLeft: null, maximumDurability: null };
}

const tierStrength: Record<EquipmentTier, number> = {
  none: 0, other: 1, wooden: 2, leather: 2, golden: 3, chainmail: 4, stone: 4,
  turtle: 5, iron: 5, diamond: 6, netherite: 7,
};

function capability(bot: Pick<Bot, "registry">, entry: ToolSnapshotEntry): number {
  if (!entry.item) return 0;
  return entry.class === "pickaxe" || entry.class === "shovel" || entry.class === "axe"
    ? harvestTier(bot, entry.item) : tierStrength[entry.tier];
}

/** Current best carried item per class. Worn armour is included because its slots are part of inventory. */
export function snapshotTools(bot: Bot): ToolSnapshot {
  const items = [...(bot.inventory?.items() ?? [])];
  // Mineflayer removes a stack from slots before placing it on the cursor
  // during equip/moveSlotItem. It is still carried throughout that transfer.
  const selected = bot.inventory?.selectedItem;
  if (selected && !items.includes(selected)) items.push(selected);
  for (const slot of [5, 6, 7, 8, 45]) {
    const item = bot.inventory?.slots?.[slot];
    if (item && !items.some((entry) => entry.slot === slot)) items.push(item);
  }
  const candidates = items.flatMap((item) => {
    const kind = equipmentClass(item.name);
    if (!kind) return [];
    return [{
      class: kind,
      tier: equipmentTier(item.name),
      item: item.name,
      slot: Number.isInteger(item.slot) ? item.slot : null,
      ...durability(item),
    } satisfies ToolSnapshotEntry];
  });
  const choose = (kind: EquipmentClass) => candidates.filter((entry) => entry.class === kind).sort((a, b) =>
    capability(bot, b) - capability(bot, a) ||
    ((kind === "pickaxe" || kind === "shovel" || kind === "axe") ? speed(bot, b.item!, kind) - speed(bot, a.item!, kind) : 0) ||
    (b.durabilityLeft ?? Number.MAX_SAFE_INTEGER) - (a.durabilityLeft ?? Number.MAX_SAFE_INTEGER) ||
    b.item!.localeCompare(a.item!),
  )[0] ?? empty(kind);
  return { tools: TOOL_CLASSES.map(choose), armour: ARMOUR_CLASSES.map(choose) };
}

export function toolChanges(before: ToolSnapshot, now: ToolSnapshot): ToolChange[] {
  const old = new Map([...before.tools, ...before.armour].map((entry) => [entry.class, entry]));
  return [...now.tools, ...now.armour].flatMap((entry): ToolChange[] => {
    const previous = old.get(entry.class) ?? empty(entry.class);
    if (previous.item === entry.item && previous.durabilityLeft === entry.durabilityLeft) return [];
    const reason: ToolChange["reason"] = previous.item === null ? "acquired"
      : entry.item === null ? "lost"
      : previous.item !== entry.item ? "replaced"
      : (entry.durabilityLeft ?? 0) > (previous.durabilityLeft ?? 0) ? "durability_restored" : "durability_used";
    return [{ class: entry.class, before: previous, now: entry, reason }];
  });
}

export function formatToolChange(change: ToolChange): string {
  const label = change.class;
  if (change.reason === "durability_used" || change.reason === "durability_restored") return `${label} durability ${change.before.durabilityLeft} → ${change.now.durabilityLeft}`;
  return `${label}: ${change.before.tier} → ${change.now.tier}${change.reason === "broke" ? ` (${change.before.item} broke)` : ""}`;
}
