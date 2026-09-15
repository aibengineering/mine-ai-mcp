import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const EQUIP = "equip" as const;
export const EQUIP_DESCRIPTION =
  "Equip carried items: wear armor in its slot, hold a tool or weapon, or put a shield in the off-hand. Use source_slot from view_status to choose a particular copy by its durability or other properties. Without source_slot, keep an already-equipped matching name or choose the first carried match. Each item's destination is inferred from its name unless given. Reports every equipment slot afterwards. Does not craft, fetch, or move.";

export const EQUIPMENT_DESTINATIONS = ["hand", "off-hand", "head", "torso", "legs", "feet"] as const;
export type EquipmentDestination = (typeof EQUIPMENT_DESTINATIONS)[number];

export const equipInputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        item_name: registryNameSchema.describe("Exact carried item registry name, such as iron_chestplate or shield."),
        source_slot: z.number().int().min(5).max(45).optional().describe(
          "Exact player inventory slot from view_status (5–45). Read when this entry executes; it must still contain item_name. No fallback to another copy. Entries execute in order and earlier equips can move items.",
        ),
        destination: z
          .enum(EQUIPMENT_DESTINATIONS)
          .optional()
          .describe(
            "Where it goes. Omitted, armor goes to its own slot, a shield to the off-hand, anything else to the hand.",
          ),
      }),
    )
    .min(1)
    .max(6)
    .describe("Items to equip, in order. A full set of armor plus a weapon and shield is six."),
});

export interface EquipRequestItem {
  readonly itemName: string;
  readonly destination: EquipmentDestination;
  readonly sourceSlot?: number;
}

export interface EquipRequest {
  readonly items: readonly EquipRequestItem[];
}

/** The slot an item is for when the caller did not say: armor by its suffix, a shield off-hand, everything else in hand. */
export function inferEquipmentDestination(itemName: string): EquipmentDestination {
  if (itemName.endsWith("_helmet") || itemName === "carved_pumpkin") return "head";
  if (itemName.endsWith("_chestplate") || itemName === "elytra") return "torso";
  if (itemName.endsWith("_leggings")) return "legs";
  if (itemName.endsWith("_boots")) return "feet";
  if (itemName === "shield") return "off-hand";
  return "hand";
}

export function parseEquipRequest(input: unknown): EquipRequest {
  const value = equipInputSchema.parse(input ?? {});
  return {
    items: value.items.map((item) => ({
      itemName: item.item_name,
      destination: item.destination ?? inferEquipmentDestination(item.item_name),
      ...(item.source_slot !== undefined && { sourceSlot: item.source_slot }),
    })),
  };
}

export const equipmentSlotsSchema = z.strictObject({
  hand: z.string().nullable(),
  offHand: z.string().nullable(),
  head: z.string().nullable(),
  torso: z.string().nullable(),
  legs: z.string().nullable(),
  feet: z.string().nullable(),
});

export const equipEvidenceSchema = z.strictObject({
  equipped: z.array(
    z.strictObject({
      item: z.string(),
      destination: z.enum(EQUIPMENT_DESTINATIONS),
      equipped: z.boolean(),
      sourceSlot: z.number().int().optional(),
      durabilityUsed: z.number().nullable().optional(),
      error: z.string().optional(),
    }),
  ),
  /** What every slot holds after the action. */
  equipment: equipmentSlotsSchema,
});

export const equipResultSchema = actionResultSchema({ equip: equipEvidenceSchema });

export type EquipmentSlots = z.output<typeof equipmentSlotsSchema>;
export type EquipEvidence = z.output<typeof equipEvidenceSchema>;
export type EquipResult = z.output<typeof equipResultSchema>;
export type EquipOutput = ActionOutput<typeof EQUIP, EquipResult>;

export const equipAnnotations = {
  destructiveHint: false,
  // A swap changes the source slot, so repeating an explicit selection can select another copy.
  idempotentHint: false,
  openWorldHint: false,
} satisfies ToolAnnotations;

export const equipOutcomes = {
  notCarried: (item: string) => `[EQUIP_NOT_CARRIED] No ${item} is carried.`,
  sourceMismatch: (item: string, sourceSlot: number, observed: string | null) =>
    `[EQUIP_SOURCE_MISMATCH] Slot ${sourceSlot} contains ${observed ?? "nothing"}, not ${item}.`,
  rejected: (item: string, cause: unknown) =>
    `[EQUIP_REJECTED] Mineflayer could not equip ${item}: ${cause instanceof Error ? cause.message : String(cause)}`,
  notObserved: (item: string, destination: string) =>
    `[EQUIP_NOT_OBSERVED] The ${destination} slot did not show the requested ${item} copy after equipping.`,
  incomplete: (failed: number, total: number) =>
    `[EQUIP_INCOMPLETE] ${failed} of ${total} item${total === 1 ? "" : "s"} could not be equipped.`,
} as const;
