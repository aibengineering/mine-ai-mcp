import type { Bot } from "mineflayer";
import { planCraftingFromInventory, type CraftPreparation, type CraftTarget } from "../../utils/craft-plan.js";
import type { Position3 } from "../../utils/index.js";
import { carriedCount, placeCarriedBlockNearby, settleInventoryCount, type WorldBlock } from "../../world/index.js";
import { executeCraftPlan } from "../../world/crafting.js";
import { craftItemOutcomes } from "./contract.js";

type CraftingStation =
  | {
      readonly kind: "ready";
      readonly craftingTable: WorldBlock | null;
      readonly craftingTablePlaced?: Position3;
      readonly usedCarriedTable: number;
    }
  | { readonly kind: "failed"; readonly error: string }
  | { readonly kind: "plan_failed"; readonly preparation: Exclude<CraftPreparation, { kind: "ready" }> };

/** Obtain a usable table without spending the batch's reserved ingredients. */
export async function prepareCraftingStation(
  bot: Bot,
  items: readonly CraftTarget[],
  required: boolean,
  signal?: AbortSignal,
): Promise<CraftingStation> {
  if (!required) return { kind: "ready", craftingTable: null, usedCarriedTable: 0 };
  const nearby = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table!.id, maxDistance: 4 });
  if (nearby) return { kind: "ready", craftingTable: nearby, usedCarriedTable: 0 };
  const carriedBefore = carriedCount(bot, "crafting_table");
  if (carriedBefore === 0) {
    const definition = bot.registry.itemsByName.crafting_table!;
    const table = { id: definition.id, name: definition.name, count: 1 };
    const joint = planCraftingFromInventory(bot, [table, ...items]);
    if (joint.kind !== "ready") return { kind: "plan_failed", preparation: joint };
    const bootstrap = planCraftingFromInventory(bot, [table]);
    if (bootstrap.kind !== "ready") return { kind: "plan_failed", preparation: bootstrap };
    const made = await executeCraftPlan(bot, bootstrap.applications, null, signal);
    if (made.kind === "failed") return { kind: "failed", error: craftItemOutcomes.executionFailed(made.cause) };
    const observed = await settleInventoryCount(bot, table.name, 1, { signal });
    if (observed.count < 1)
      return { kind: "failed", error: "The crafting table made for this batch was not observed." };
  }
  const placement = await placeCarriedBlockNearby(bot, "crafting_table", { signal });
  if (placement.kind !== "placed") return { kind: "failed", error: craftItemOutcomes.craftingTableRequired };
  await settleInventoryCount(bot, "crafting_table", Math.max(0, carriedBefore - 1), { signal });
  return {
    kind: "ready",
    craftingTable: placement.block,
    craftingTablePlaced: placement.position,
    usedCarriedTable: carriedBefore > 0 ? 1 : 0,
  };
}
