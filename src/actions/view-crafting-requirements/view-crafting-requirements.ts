import type { Bot } from "mineflayer";
import { planCraftingFromInventory, type CraftTarget } from "../../utils/craft-plan.js";
import { defineAction, type ActionContext } from "../action.js";
import { markdownCodeBlock } from "../markdown.js";
import {
  parseViewCraftingRequirementsRequest,
  VIEW_CRAFTING_REQUIREMENTS,
  VIEW_CRAFTING_REQUIREMENTS_DESCRIPTION,
  viewCraftingRequirementsResultSchema,
  viewCraftingRequirementsAnnotations,
  viewCraftingRequirementsInputSchema,
  viewCraftingRequirementsOutcomes,
  type ViewCraftingRequirementsResult,
  type ViewCraftingRequirementsRequest,
} from "./contract.js";

/**
 * DESIGN TBD: Minecraft data exposes concrete recipe alternatives, while
 * Mineflayer's recipesAll API exposes only the already-expanded recipes. The
 * planner therefore cannot yet report one flexible ingredient group such as
 * "logs" or "stone-tool material", followed by the matching carried variants
 * it reserved and their shared shortfall. Preserve ingredient-choice groups
 * and allocations in the planner evidence, then render them here. Delete this
 * comment once that evidence replaces the concrete-only recipe-tree summary.
 */

/** Inspect the same all-or-nothing plan used by crafting without mutating the bot. */
export async function viewCraftingRequirements(
  bot: Bot,
  request: ViewCraftingRequirementsRequest,
  context: ActionContext,
): Promise<ViewCraftingRequirementsResult> {
  context.signal?.throwIfAborted();
  const targets: CraftTarget[] = [];
  const unknownItems: string[] = [];

  for (const requested of request.items) {
    const item = bot.registry.itemsByName[requested.itemName];
    if (!item) {
      unknownItems.push(requested.itemName);
      continue;
    }
    targets.push({ id: item.id, name: item.name, count: requested.count });
  }

  const items = request.items.map(({ itemName, count }) => ({ item: itemName, count }));
  if (unknownItems.length > 0) {
    return {
      status: "failed",
      error: viewCraftingRequirementsOutcomes.unknownItems(unknownItems),
      requirements: { items },
    };
  }

  const preparation = planCraftingFromInventory(bot, targets);
  if (preparation.kind === "planner_failed") {
    return {
      status: "failed",
      error: viewCraftingRequirementsOutcomes.plannerFailed(preparation.items),
      requirements: { items, plan: preparation.plan },
    };
  }
  return { status: "succeeded", requirements: { items, plan: preparation.plan } };
}

export function formatViewCraftingRequirementsResult(result: ViewCraftingRequirementsResult): string {
  const { requirements } = result;
  if (!requirements.plan) return `**Observed stop:** ${result.status === "succeeded" ? "No plan." : result.error}`;

  const { plan } = requirements;
  const lines = [
    result.status === "succeeded" ? `Crafting plan status: **${plan.status}**.` : `**Observed stop:** ${result.error}`,
    `- Requested: ${requirements.items.map(({ item, count }) => `${item} ×${count}`).join(", ")}`,
    `- Required leaf materials: ${plan.requiredMaterials.length > 0 ? plan.requiredMaterials.map(({ item, count }) => `${item} ×${count}`).join(", ") : "none"}`,
    `- Carried leaf materials reserved: ${plan.carriedMaterials.length > 0 ? plan.carriedMaterials.map(({ item, count }) => `${item} ×${count}`).join(", ") : "none"}`,
    `- Missing leaves: ${plan.missingMaterials.length > 0 ? plan.missingMaterials.map(({ item, count }) => `${item} ×${count}`).join(", ") : "none"}`,
    `- Crafting table required: ${plan.requiresCraftingTable}`,
    "",
    "Selected recipe paths:",
    "",
    markdownCodeBlock(plan.tree),
  ];
  return lines.join("\n");
}

export function createViewCraftingRequirementsAction(bot: Bot) {
  return defineAction({
    name: VIEW_CRAFTING_REQUIREMENTS,
    description: VIEW_CRAFTING_REQUIREMENTS_DESCRIPTION,
    inputSchema: viewCraftingRequirementsInputSchema,
    resultSchema: viewCraftingRequirementsResultSchema,
    formatResult: formatViewCraftingRequirementsResult,
    execution: { kind: "information" },
    annotations: viewCraftingRequirementsAnnotations,
    parse: parseViewCraftingRequirementsRequest,
    execute: (request, context) => viewCraftingRequirements(bot, request, context),
  });
}
