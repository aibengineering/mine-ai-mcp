import { craftCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { observeInventoryProgress } from "../progress.js";
import type { NavigationRuntime } from "../../navigation/index.js";
import { planCraftingFromInventory, type CraftPreparation, type CraftTarget } from "../../utils/craft-plan.js";
import type { Position3 } from "../../utils/index.js";
import { executeCraftPlan } from "../../world/crafting.js";
import { carriedCount, settledNow, settleInventoryMinimum, type SettledInventoryCount } from "../../world/index.js";
import type { WorldBlock } from "../../world/placement.js";
import { defineAction, type ActionContext } from "../action.js";
import { markdownCodeBlock, unconfirmedCount } from "../markdown.js";
import { formatWorkstation, useTemporaryWorkstation, workstationOperations } from "../temporary-workstation.js";
import {
  craftItemAnnotations,
  craftItemOutcomes,
  parseCraftItemRequest,
  CRAFT_ITEM,
  CRAFT_ITEM_DESCRIPTION,
  craftItemInputSchema,
  craftItemResultSchema,
  type CraftEvidence,
  type CraftItemRequest,
  type CraftItemResult,
} from "./contract.js";
import { prepareCraftingStation } from "./crafting-station.js";

type FailedCraftPreparation = Exclude<CraftPreparation, { readonly kind: "ready" }>;

interface ResolvedCraftItem extends CraftTarget {
  readonly inventoryBefore: number;
}

interface CraftItemObservation {
  readonly item: string;
  readonly requested: number;
  readonly inventoryBefore: number;
  /** Omitted only when no preparation or crafting changed inventory. */
  readonly after?: SettledInventoryCount;
  readonly usedForWorkstation?: number;
}

interface CraftEvidenceInput {
  readonly items: readonly CraftItemObservation[];
  readonly completedSteps?: number;
  readonly preparation?: CraftPreparation;
  readonly craftingTablePlaced?: Position3;
}

function craftEvidence({
  items,
  completedSteps = 0,
  preparation,
  craftingTablePlaced,
}: CraftEvidenceInput): CraftEvidence {
  return {
    ...(craftingTablePlaced ? { craftingTablePlaced } : {}),
    items: items.map(
      ({
        item,
        requested,
        inventoryBefore,
        after = { count: inventoryBefore, confirmed: true },
        usedForWorkstation = 0,
      }) => ({
        item,
        requested,
        gained: Math.max(0, after.count - inventoryBefore + usedForWorkstation),
        usedForWorkstation,
        inventoryBefore,
        inventoryAfter: after.count,
        confirmed: after.confirmed,
      }),
    ),
    completedSteps,
    plan: preparation?.plan,
  };
}

function preparationFailureResult(
  preparation: FailedCraftPreparation,
  evidence: CraftEvidenceInput,
): Extract<CraftItemResult, { status: "failed" }> {
  let error: string;

  switch (preparation.kind) {
    case "uncraftable":
      error = craftItemOutcomes.uncraftable(preparation.items);
      break;
    case "missing_materials":
      error = craftItemOutcomes.missingMaterials(preparation.plan.missingMaterials);
      break;
    case "planner_failed":
      error = craftItemOutcomes.plannerFailed(preparation.items);
      break;
  }

  return {
    status: "failed",
    error,
    craft: craftEvidence({ ...evidence, preparation }),
  };
}

/** Plan the complete batch before consuming anything, then settle every requested inventory gain. */
export async function craftItem(
  bot: Bot,
  navigation: NavigationRuntime,
  request: CraftItemRequest,
  context: ActionContext,
): Promise<CraftItemResult> {
  observeInventoryProgress(context, bot, request.items, () => "crafting", "All requested net item gains are still carried after crafting and workstation cleanup.");
  if (!request.temporaryWorkstation) return craftBatch(bot, request, context);
  const tablesBefore = carriedCount(bot, "crafting_table");
  const result = await useTemporaryWorkstation(
    bot,
    "crafting_table",
    context,
    workstationOperations(bot, navigation),
    (table) => craftBatch(bot, request, context, table),
    (error) => ({
      status: "failed",
      error,
      craft: craftEvidence({
        items: request.items.map(({ itemName, count }) => ({
          item: itemName,
          requested: count,
          inventoryBefore: carriedCount(bot, itemName),
        })),
      }),
    }),
  );
  // The batch's baseline was taken after placement. Restore the caller's baseline
  // and final count without counting the recovered table as newly crafted output.
  if (result.workstation) {
    for (const item of result.craft.items) {
      if (item.item !== "crafting_table") continue;
      item.inventoryBefore = tablesBefore;
      item.inventoryAfter = carriedCount(bot, item.item);
      item.usedForWorkstation = result.workstation.recovered ? 0 : 1;
    }
    result.craft.craftingTablePlaced = result.workstation.position;
  }
  return result;
}

async function craftBatch(
  bot: Bot,
  request: CraftItemRequest,
  context: ActionContext,
  providedTable?: WorldBlock,
): Promise<CraftItemResult> {
  context.signal?.throwIfAborted();
  const items: ResolvedCraftItem[] = [];
  const requestedItems: CraftItemObservation[] = [];
  const unknownItems: string[] = [];

  for (const requested of request.items) {
    const target = bot.registry.itemsByName[requested.itemName];
    if (!target) {
      unknownItems.push(requested.itemName);
      requestedItems.push({ item: requested.itemName, requested: requested.count, inventoryBefore: 0 });
      continue;
    }
    const inventoryBefore = carriedCount(bot, target.name);
    items.push({
      id: target.id,
      name: target.name,
      count: requested.count,
      inventoryBefore,
    });
    requestedItems.push({ item: target.name, requested: requested.count, inventoryBefore });
  }

  if (unknownItems.length > 0) {
    return {
      status: "failed",
      error: craftItemOutcomes.unknownItems(unknownItems),
      craft: craftEvidence({ items: requestedItems }),
    };
  }

  const initialPlan = planCraftingFromInventory(bot, items);
  if (initialPlan.kind !== "ready") return preparationFailureResult(initialPlan, { items: requestedItems });
  const station = providedTable
    ? { kind: "ready" as const, craftingTable: providedTable, usedCarriedTable: 0, craftingTablePlaced: undefined }
    : await prepareCraftingStation(bot, items, initialPlan.plan.requiresCraftingTable, context.signal);
  if (station.kind === "plan_failed") {
    const failure = preparationFailureResult(station.preparation, { items: requestedItems });
    return {
      ...failure,
      error: `No crafting table is in reach or carried. Preparing one for this batch: ${failure.error}`,
    };
  }
  if (station.kind === "failed") {
    return {
      status: "failed",
      error: station.error,
      craft: craftEvidence({
        items: items.map(({ name, count, inventoryBefore }) => ({
          item: name,
          requested: count,
          inventoryBefore,
          after: settledNow(bot, name),
        })),
        preparation: initialPlan,
      }),
    };
  }
  // Workstation preparation can consume materials; plan the batch against what remains.
  const preparation = planCraftingFromInventory(bot, items);
  const { craftingTable, craftingTablePlaced, usedCarriedTable } = station;
  if (preparation.kind !== "ready") {
    return preparationFailureResult(preparation, {
      craftingTablePlaced,
      items: items.map(({ name, count, inventoryBefore }) => ({
        item: name,
        requested: count,
        inventoryBefore,
        after: settledNow(bot, name),
        usedForWorkstation: name === "crafting_table" ? usedCarriedTable : 0,
      })),
    });
  }
  const execution = await executeCraftPlan(bot, preparation.applications, craftingTable, context.signal);
  // Wait for each requested gain after the server corrects optimistic clicks.
  const settled = await Promise.all(
    items.map(async ({ name, count, inventoryBefore }) => ({
      item: name,
      requested: count,
      inventoryBefore,
      usedForWorkstation: name === "crafting_table" ? usedCarriedTable : 0,
      after: await settleInventoryMinimum(
        bot,
        name,
        inventoryBefore + count - (name === "crafting_table" ? usedCarriedTable : 0),
        { signal: context.signal },
      ),
    })),
  );
  const observed = craftEvidence({
    items: settled,
    completedSteps: execution.completedSteps,
    preparation,
    craftingTablePlaced,
  });

  if (execution.kind === "failed") {
    return {
      status: execution.completedSteps > 0 ? "partial" : "failed",
      error: craftItemOutcomes.executionFailed(execution.cause),
      craft: observed,
    };
  }

  const shortfalls = observed.items.filter(({ gained, requested }) => gained < requested);
  if (shortfalls.length > 0) {
    return {
      status: "partial",
      error: craftItemOutcomes.resultNotObserved(shortfalls),
      craft: observed,
    };
  }
  return { status: "succeeded", craft: observed };
}

export function formatCraftItemResult(result: CraftItemResult): string {
  const { craft } = result;
  const lines = [
    ...formatWorkstation(result.workstation),
    result.status === "succeeded"
      ? `Crafted all **${craft.items.length} requested item types** from the bot's inventory.`
      : `**Observed stop:** ${result.error}`,
    ...craft.items.map(
      ({ item, requested, gained, inventoryBefore, inventoryAfter, confirmed, usedForWorkstation }) =>
        `- ${item}: gained ${gained}/${requested}; inventory ${inventoryBefore} → ${inventoryAfter}${unconfirmedCount(confirmed)}${usedForWorkstation ? `; used ${usedForWorkstation} for the workstation` : ""}`,
    ),
    `- Recipe steps completed: ${craft.completedSteps}${craft.plan ? `/${craft.plan.steps.length}` : ""}`,
    ...(craft.craftingTablePlaced
      ? [
          `- Placed a carried crafting table at \`${craft.craftingTablePlaced.x}, ${craft.craftingTablePlaced.y}, ${craft.craftingTablePlaced.z}\` for this batch`,
        ]
      : []),
  ];
  if (craft.plan) {
    lines.push(`- Crafting table required: ${craft.plan.requiresCraftingTable}`);
    lines.push(
      `- Required leaf materials: ${craft.plan.requiredMaterials.length > 0 ? craft.plan.requiredMaterials.map(({ item, count }) => `${item} ×${count}`).join(", ") : "none"}`,
    );
    lines.push(
      `- Carried leaf materials reserved: ${craft.plan.carriedMaterials.length > 0 ? craft.plan.carriedMaterials.map(({ item, count }) => `${item} ×${count}`).join(", ") : "none"}`,
    );
    if (craft.plan.missingMaterials.length > 0) {
      lines.push(
        `- Missing leaves: ${craft.plan.missingMaterials.map(({ item, count }) => `${item} ×${count}`).join(", ")}`,
      );
    }
    lines.push("", "Selected recipe paths:", "", markdownCodeBlock(craft.plan.tree));
  }
  return lines.join("\n");
}

export function createCraftItemAction(bot: Bot, navigation: NavigationRuntime) {
  return defineAction({
    checkpointSchema: craftCheckpointSchema,
    name: CRAFT_ITEM,
    description: CRAFT_ITEM_DESCRIPTION,
    inputSchema: craftItemInputSchema,
    resultSchema: craftItemResultSchema,
    formatResult: formatCraftItemResult,
    execution: { kind: "task" },
    annotations: craftItemAnnotations,
    parse: parseCraftItemRequest,
    execute: (request, context) => craftItem(bot, navigation, request, context),
  });
}
