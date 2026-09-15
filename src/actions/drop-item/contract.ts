import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { actionResultSchema, type ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const DROP_ITEM = "drop_item" as const;
export const DROP_ITEM_DESCRIPTION =
  "Drop carried items on the ground, or hand them to a nearby player by walking to them first and tossing at their feet. " +
  "Each named item is tossed stack by stack and verified gone from the inventory. Worn armour and the off-hand are never " +
  "dropped, and the held item only with allow_equipped. With in_a_hole, dig a dry two-block-deep hole beside the bot " +
  "(excavating a wall opening underground when needed), verify the items landed below pickup height, then plug the hole " +
  "with a carried block and step back from it so a later collect_block does not walk straight into the pit. Cannot combine in_a_hole with to_player. " +
  "To free inventory space, prefer depositing into a chest with use_container: dropped items despawn after five " +
  "minutes, can be taken by anyone, and may be picked straight back up by this bot. Drop only when no container is in " +
  "reach, when carrying the items to one is not worth the trip, or when the items are genuinely rubbish. " +
  "Does not craft, fetch, or place containers.";

/** Worn armour is never tossed: losing it mid-fight costs the run, and re-equipping is not this action's job. */
export const NEVER_DROPPED_SLOTS = ["head", "torso", "legs", "feet", "off-hand"] as const;

export const dropItemInputSchema = z
  .strictObject({
    items: z
      .array(
        z.strictObject({
          item_name: registryNameSchema.describe(
            "Exact carried item registry name, such as cobblestone or rotten_flesh.",
          ),
          count: z
            .number()
            .int()
            .positive()
            .optional()
            .describe("How many to drop. Omitted, every carried stack of that item goes."),
        }),
      )
      .min(1)
      .max(12)
      .describe("Items to drop, in order."),
    to_player: z
      .string()
      .min(1)
      .max(32)
      .optional()
      .describe(
        "Player to hand the items to. The bot walks within reach of them, faces them, and tosses. Omitted, the items are " +
          "dropped where the bot already stands.",
      ),
    allow_equipped: z
      .boolean()
      .default(false)
      .describe(
        "Permit dropping the item currently held in hand. Worn armour and the off-hand are refused regardless.",
      ),
    in_a_hole: z
      .boolean()
      .default(false)
      .describe(
        "Create a dry, enclosed disposal pit below pickup height beside the bot, digging a wall opening if needed, then toss into it. Afterwards the pit is plugged with a carried block and the bot steps back from it. Fails without tossing if adjacent terrain cannot safely contain the pit. Cannot be combined with to_player.",
      ),
  })
  .refine((value) => !value.in_a_hole || value.to_player === undefined, {
    message: "in_a_hole cannot be combined with to_player.",
    path: ["in_a_hole"],
  });

export interface DropRequestItem {
  readonly itemName: string;
  readonly count: number | null;
}

export interface DropItemRequest {
  readonly items: readonly DropRequestItem[];
  readonly destination:
    { readonly kind: "ground" } | { readonly kind: "player"; readonly name: string } | { readonly kind: "hole" };
  readonly allowEquipped: boolean;
}

export function parseDropItemRequest(input: unknown): DropItemRequest {
  const value = dropItemInputSchema.parse(input ?? {});
  return {
    items: value.items.map((item) => ({ itemName: item.item_name, count: item.count ?? null })),
    destination: value.in_a_hole
      ? { kind: "hole" }
      : value.to_player
        ? { kind: "player", name: value.to_player }
        : { kind: "ground" },
    allowEquipped: value.allow_equipped,
  };
}

export const droppedItemSchema = z.strictObject({
  item: z.string(),
  /** How many the caller asked for; null when they asked for every stack. */
  requested: z.number().int().nullable(),
  carriedBefore: z.number().int(),
  carriedAfter: z.number().int(),
  dropped: z.number().int(),
  error: z.string().optional(),
});

export const dropRecipientSchema = z.strictObject({
  name: z.string(),
  /** Distance from the bot to the player at the moment the items were tossed. */
  distance: z.number(),
  position: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }),
});

export const holeClosureSchema = z.strictObject({
  /** Carried block used to plug the hole; null when nothing placeable was carried. */
  item: z.string().nullable(),
  /** Blocks placed into the hole's shaft above the discards. */
  placed: z.number().int(),
  /** Horizontal distance from the hole's column once the bot stepped back. */
  distance: z.number(),
  /** Why the hole stayed open or the bot stayed beside it. */
  error: z.string().optional(),
});

export const dropItemEvidenceSchema = z.strictObject({
  dropped: z.array(droppedItemSchema),
  freeSlotsBefore: z.number().int(),
  freeSlotsAfter: z.number().int(),
  /** Where the bot stood when it tossed, so the drops can be walked back to. */
  droppedAt: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }),
  recipient: dropRecipientSchema.nullable(),
  /** Bottom air cell of the two-block-deep disposal hole, when requested. */
  hole: z.strictObject({ x: z.number(), y: z.number(), z: z.number() }).nullable(),
  /** How the hole was closed after the toss, so the bot does not walk back into it. */
  holeClosure: holeClosureSchema.nullable(),
});

export const dropItemResultSchema = actionResultSchema({ drop: dropItemEvidenceSchema });

export type DroppedItem = z.output<typeof droppedItemSchema>;
export type DropRecipient = z.output<typeof dropRecipientSchema>;
export type HoleClosure = z.output<typeof holeClosureSchema>;
export type DropItemEvidence = z.output<typeof dropItemEvidenceSchema>;
export type DropItemResult = z.output<typeof dropItemResultSchema>;
export type DropItemOutput = ActionOutput<typeof DROP_ITEM, DropItemResult>;

export const dropItemAnnotations = {
  // Dropped items despawn and can be taken by anyone; this is not undoable.
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} satisfies ToolAnnotations;

export const dropItemOutcomes = {
  notCarried: (item: string) => `[DROP_NOT_CARRIED] No ${item} is carried.`,
  worn: (item: string, slot: string) =>
    `[DROP_WORN] ${item} is worn in the ${slot} slot and is never dropped; unequip it first with equip.`,
  held: (item: string) => `[DROP_HELD] ${item} is held in hand; pass allow_equipped to drop it.`,
  rejected: (item: string, cause: unknown) =>
    `[DROP_REJECTED] Mineflayer could not toss ${item}: ${cause instanceof Error ? cause.message : String(cause)}`,
  notObserved: (item: string, remaining: number) =>
    `[DROP_NOT_OBSERVED] The inventory still holds ${item} x${remaining} after tossing.`,
  playerNotFound: (name: string) =>
    `[DROP_PLAYER_NOT_FOUND] No player named ${name} is loaded nearby; move closer or check the name.`,
  playerUnreachable: (name: string, reason: string) =>
    `[DROP_PLAYER_UNREACHABLE] Pathfinder could not reach ${name}: ${reason}.`,
  playerLeft: (name: string) => `[DROP_PLAYER_LEFT] ${name} stopped being observed before the items were tossed.`,
  incomplete: (failed: number, total: number) =>
    `[DROP_INCOMPLETE] ${failed} of ${total} item${total === 1 ? "" : "s"} could not be dropped.`,
} as const;
