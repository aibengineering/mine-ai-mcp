import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ActionOutput } from "../action.js";
import { registryNameSchema } from "../registry-name.js";

export const USE_CONTAINER = "use_container" as const;
export const USE_CONTAINER_DESCRIPTION =
  "Inspect, deposit or withdraw multiple item quantities, or compact and order every item in one location-owned storage container. Verifies the observed result and records the complete slot layout for later SQL queries.";

const requestedItemInputSchema = z.strictObject({
  item_name: registryNameSchema.describe("Exact Minecraft registry item name."),
  count: z.number().int().positive().safe().describe("Requested item quantity."),
});

export const useContainerInputSchema = z
  .strictObject({
    operation: z
      .enum(["inspect", "deposit", "withdraw", "organize"])
      .default("inspect")
      .describe("Inspect, transfer item quantities, or compact and order the container contents."),
    x: z.number().int().safe().describe("Container block X coordinate."),
    y: z.number().int().safe().describe("Container block Y coordinate."),
    z: z.number().int().safe().describe("Container block Z coordinate."),
    items: z.array(requestedItemInputSchema).min(1).optional().describe("Item quantities to deposit or withdraw."),
    item_order: z
      .array(registryNameSchema)
      .optional()
      .describe("Every distinct item in the container, once, in the desired packed order."),
  })
  .superRefine((value, context) => {
    if (value.operation === "inspect") {
      if (value.items !== undefined) {
        context.addIssue({ code: "custom", path: ["items"], message: "Inspect does not accept items." });
      }
      if (value.item_order !== undefined) {
        context.addIssue({ code: "custom", path: ["item_order"], message: "Inspect does not accept item_order." });
      }
      return;
    }

    if (value.operation === "organize") {
      if (value.items !== undefined) {
        context.addIssue({ code: "custom", path: ["items"], message: "Organize accepts item_order, not items." });
      }
      if (value.item_order === undefined) {
        context.addIssue({ code: "custom", path: ["item_order"], message: "Organize requires item_order." });
      } else if (new Set(value.item_order).size !== value.item_order.length) {
        context.addIssue({ code: "custom", path: ["item_order"], message: "Organize requires each item once." });
      }
      return;
    }

    if (value.items === undefined) {
      context.addIssue({ code: "custom", path: ["items"], message: `${value.operation} requires items.` });
    } else {
      const totals = new Map<string, number>();
      for (const item of value.items) {
        const total = (totals.get(item.item_name) ?? 0) + item.count;
        if (!Number.isSafeInteger(total)) {
          context.addIssue({
            code: "custom",
            path: ["items"],
            message: "Combined item counts must remain safe integers.",
          });
          break;
        }
        totals.set(item.item_name, total);
      }
    }
    if (value.item_order !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["item_order"],
        message: `${value.operation} accepts items, not item_order.`,
      });
    }
  });

interface ContainerPositionRequest {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface RequestedContainerItem {
  readonly itemName: string;
  readonly count: number;
}

export type UseContainerRequest =
  | (ContainerPositionRequest & { readonly operation: "inspect" })
  | (ContainerPositionRequest & {
      readonly operation: "deposit" | "withdraw";
      readonly items: readonly RequestedContainerItem[];
    })
  | (ContainerPositionRequest & {
      readonly operation: "organize";
      readonly itemOrder: readonly string[];
    });

export function parseUseContainerRequest(input: unknown): UseContainerRequest {
  const value = useContainerInputSchema.parse(input ?? {});
  const position = { x: value.x, y: value.y, z: value.z };
  if (value.operation === "inspect") return { operation: "inspect", ...position };
  if (value.operation === "organize") {
    return {
      operation: "organize",
      itemOrder: value.item_order!,
      ...position,
    };
  }

  const combined = new Map<string, number>();
  for (const item of value.items!) {
    combined.set(item.item_name, (combined.get(item.item_name) ?? 0) + item.count);
  }
  return {
    operation: value.operation,
    items: [...combined].map(([itemName, count]) => ({ itemName, count })),
    ...position,
  };
}

const containerPositionSchema = z.strictObject({
  dimension: z.string(),
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
});

const requestedItemSchema = z.strictObject({
  item: z.string(),
  requested: z.number().int().positive(),
});

export const containerContentSchema = z.strictObject({
  slot: z.number().int().nonnegative(),
  item: z.string(),
  count: z.number().int().positive(),
});

const inspectTargetSchema = containerPositionSchema.extend({ operation: z.literal("inspect") });
const transferTargetSchema = containerPositionSchema.extend({
  operation: z.enum(["deposit", "withdraw"]),
  items: z.array(requestedItemSchema).min(1),
});
const organizeTargetSchema = containerPositionSchema.extend({
  operation: z.literal("organize"),
  itemOrder: z.array(z.string()),
});

export const containerTargetSchema = z.discriminatedUnion("operation", [
  inspectTargetSchema,
  transferTargetSchema,
  organizeTargetSchema,
]);

const containerObservationEvidenceShape = {
  blockName: z.string(),
  slotCount: z.number().int().nonnegative(),
  contents: z.array(containerContentSchema),
  observedAt: z.string(),
};

export const containerTransferResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("succeeded"),
    item: z.string(),
    requested: z.number().int().positive(),
    transferred: z.number().int().positive(),
  }),
  z.strictObject({
    status: z.literal("partial"),
    item: z.string(),
    requested: z.number().int().positive(),
    transferred: z.number().int().positive(),
    error: z.string(),
  }),
  z.strictObject({
    status: z.literal("failed"),
    item: z.string(),
    requested: z.number().int().positive(),
    transferred: z.literal(0),
    error: z.string(),
  }),
]);

const inspectEvidenceSchema = inspectTargetSchema.extend(containerObservationEvidenceShape);
const transferEvidenceSchema = transferTargetSchema.extend({
  ...containerObservationEvidenceShape,
  transfers: z.array(containerTransferResultSchema).min(1),
});
const organizeEvidenceSchema = organizeTargetSchema.extend({
  ...containerObservationEvidenceShape,
  plannedContents: z.array(containerContentSchema),
  matchedSlots: z.number().int().nonnegative(),
  contentsPreserved: z.boolean(),
  playerInventoryPreserved: z.boolean(),
  cursorEmpty: z.boolean(),
});

export const containerUseEvidenceSchema = z.discriminatedUnion("operation", [
  inspectEvidenceSchema,
  transferEvidenceSchema,
  organizeEvidenceSchema,
]);

export type ContainerTarget = z.output<typeof containerTargetSchema>;
export type ContainerTransferResult = z.output<typeof containerTransferResultSchema>;
export type ContainerUseEvidence = z.output<typeof containerUseEvidenceSchema>;

export const useContainerResultSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("succeeded"), container: containerUseEvidenceSchema }),
  z.strictObject({ status: z.literal("partial"), error: z.string(), container: containerUseEvidenceSchema }),
  z.strictObject({
    status: z.literal("failed"),
    error: z.string(),
    target: containerTargetSchema,
    container: containerUseEvidenceSchema.optional(),
  }),
]);

export type UseContainerResult = z.output<typeof useContainerResultSchema>;
export type UseContainerOutput = ActionOutput<typeof USE_CONTAINER, UseContainerResult>;

export const useContainerAnnotations = {
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true,
} satisfies ToolAnnotations;

function itemList(items: readonly string[]): string {
  return items.join(", ");
}

export const useContainerOutcomes = {
  unknownItems: (items: readonly string[]) =>
    `[UNKNOWN_CONTAINER_ITEMS] Minecraft has no item registry entries named: ${itemList(items)}.`,
  unavailable: (operation: "deposit" | "withdraw", item: string, available: number, requested: number) =>
    `[CONTAINER_${operation === "deposit" ? "DEPOSIT" : "WITHDRAW"}_SHORTAGE] Only ${item} x${available} was available; requested x${requested}.`,
  routeStopped: (reason: string) => `[CONTAINER_UNREACHABLE] Pathfinder could not reach the container: ${reason}.`,
  blockUnloaded: "[CONTAINER_BLOCK_UNLOADED] The target block was not loaded after navigation; stored memory was retained.",
  unsupportedBlock: (blockName: string) =>
    `[CONTAINER_NOT_PRESENT] The loaded target block is ${blockName}, not a supported location-owned container.`,
  openFailed: (cause: unknown) =>
    `[CONTAINER_OPEN_FAILED] Mineflayer could not open the observed container: ${cause instanceof Error ? cause.message : String(cause)}`,
  transferFailed: (operation: "deposit" | "withdraw", cause: unknown) =>
    `[CONTAINER_TRANSFER_FAILED] Mineflayer could not ${operation}: ${cause instanceof Error ? cause.message : String(cause)}`,
  transferIncomplete: (operation: "deposit" | "withdraw", transferred: number, requested: number) =>
    `[CONTAINER_TRANSFER_INCOMPLETE] Observed ${operation} transfer ${transferred}/${requested}.`,
  batchIncomplete: (items: readonly ContainerTransferResult[]) =>
    `[CONTAINER_BATCH_INCOMPLETE] Observed item transfers: ${items.map(({ item, transferred, requested }) => `${item} ${transferred}/${requested}`).join(", ")}.`,
  compactionFailed: (cause: unknown) =>
    `[CONTAINER_COMPACTION_FAILED] Mineflayer could not compact the remaining container stacks after withdrawal: ${cause instanceof Error ? cause.message : String(cause)}`,
  itemOrderMismatch: (observed: readonly string[], requested: readonly string[]) =>
    "[CONTAINER_ITEM_ORDER_MISMATCH] Organize requires every distinct observed item exactly once. " +
    `Observed ${JSON.stringify(observed)}; requested ${JSON.stringify(requested)}.`,
  organizeFailed: (cause: unknown) =>
    `[CONTAINER_ORGANIZE_FAILED] Mineflayer could not move a container stack: ${cause instanceof Error ? cause.message : String(cause)}`,
  organizeIncomplete: (
    matched: number,
    planned: number,
    contentsPreserved: boolean,
    playerInventoryPreserved: boolean,
    cursorEmpty: boolean,
  ) =>
    `[CONTAINER_ORGANIZE_INCOMPLETE] Observed ${matched}/${planned} planned occupied slots; ` +
    `container contents preserved=${contentsPreserved}, player inventory preserved=${playerInventoryPreserved}, cursor empty=${cursorEmpty}.`,
} as const;
