/**
 * Three receipts on generated terrain, each checked against the count it
 * should have moved.
 *
 * Mineflayer resolves a physical act on the first witness the server sends -
 * `consume` on the eating-finished status, `placeBlock` on the block update -
 * and the packet that redraws the inventory slot follows a tick or so later.
 * Every receipt that counts an item now waits for the count it expects, on a
 * deadline of a few ticks.
 *
 * A superflat fixture cannot say whether that deadline is long enough. A
 * generated world is where a tick is expensive: chunks stream in, the
 * generator runs, and the server has other work between the witness and the
 * broadcast. So if a receipt here comes back unconfirmed, that is the finding,
 * and the thing to change is the constant in `settleInventoryCount` rather
 * than anything in this scenario.
 */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import {
  attachHighlighter,
  createCraftItemAction,
  createEatFoodAction,
  createPlaceBlockAction,
  ActionRunner,
  craftItemResultSchema,
  eatFoodResultSchema,
  placeBlockResultSchema,
} from "@aibengineering/mine-ai-mcp";

import { standStill } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  /**
   * Hunger to drain to before the bite. Anything under twenty lets the food
   * down; the exact number only has to leave room for what the food restores.
   */
  hungerTo: z.number().int().min(1).max(19),
  food: z.string().min(1),
  block: z.string().min(1),
  crafted: z.string().min(1),
  craftedCount: z.number().int().positive(),
});

/** How long the hunger effect is given to bring the bar down, in ticks. */
const STARVE_TIMEOUT_TICKS = 1_200;

/**
 * Drain hunger with the hunger effect, from the client, so the bite has
 * somewhere to go. The fixture ops the bot for exactly this.
 */
async function starve(context: MineAiScenarioContext, target: number): Promise<boolean> {
  const { bot } = context;
  bot.chat("/effect give @s minecraft:hunger 60 255 true");
  for (let waited = 0; waited < STARVE_TIMEOUT_TICKS; waited += 1) {
    context.signal.throwIfAborted();
    if (bot.food <= target) break;
    await bot.waitForTicks(1);
  }
  bot.chat("/effect clear @s minecraft:hunger");
  return bot.food <= target;
}

/**
 * What every receipt in this scenario has to show: the count moved by exactly
 * the amount the act was worth, and the server confirmed it inside the
 * deadline. Returns the complaint, or null.
 */
function countMoved(
  label: string,
  observed: { readonly before: number; readonly after: number; readonly confirmed: boolean },
  delta: number,
): string | null {
  const seen = `${label} ${observed.before} -> ${observed.after}, confirmed ${observed.confirmed}`;
  if (!observed.confirmed) return `${seen}: the server did not confirm the count within the settle deadline`;
  if (observed.after - observed.before !== delta) return `${seen}: expected a move of ${delta}`;
  return null;
}

// @function-metrics size=22 branches=7 fan-out=11 depth=3 interface=1 fan-in=0
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const params = paramsSchema.parse(context.scenario.params);
  const { highlighter } = attachHighlighter(bot);
  const runner = new ActionRunner({ highlighter });
  const seen: string[] = [];

  try {
    await bot.waitForChunksToLoad();
    if (!(await standStill(context))) {
      return {
        status: "failed",
        detail: `the bot never came to rest with vitals known; at ${bot.entity.position.floored()}, hunger ${bot.food}`,
      };
    }
    const feet = bot.entity.position.floored();
    // Recorded so a fixture on a new seed can pin the column the bot actually
    // stood on, the way the terrain fixtures record theirs.
    context.log(`stood at ${feet.x}, ${feet.y}, ${feet.z}`);
    seen.push(`stood at ${feet.x},${feet.y},${feet.z}`);

    if (!(await starve(context, params.hungerTo))) {
      return { status: "failed", detail: `hunger did not reach ${params.hungerTo}; it is ${bot.food}` };
    }

    const eaten = await runner.run(createEatFoodAction(bot), { food_name: params.food }, context.signal);
    const eating = eatFoodResultSchema.parse(eaten.result).eating;
    seen.push(`ate ${eating.food} ${eating.inventoryBefore}->${eating.inventoryAfter} in ${eaten.durationMs} ms`);
    if (!eating.consumed) return { status: "failed", detail: `no bite was taken; ${seen.join("; ")}` };
    const bite = countMoved(
      `eat ${eating.food}`,
      { before: eating.inventoryBefore, after: eating.inventoryAfter, confirmed: eating.confirmed },
      -1,
    );
    if (bite) return { status: "failed", detail: `${bite}; ${seen.join("; ")}` };

    // No coordinates: the action picks a clear cell beside the bot's feet
    // itself, which is the only placement a fixture can ask for on terrain it
    // has not surveyed.
    const put = await runner.run(
      createPlaceBlockAction(bot, context.navigation),
      { block_name: params.block },
      context.signal,
    );
    const placement = placeBlockResultSchema.parse(put.result).placement;
    seen.push(
      `placed ${placement.requestedBlock} at ${placement.target.x},${placement.target.y},${placement.target.z} ${placement.inventoryBefore}->${placement.inventoryAfter} in ${put.durationMs} ms`,
    );
    if (!placement.placed) return { status: "failed", detail: `nothing was placed; ${seen.join("; ")}` };
    const laid = countMoved(
      `place ${placement.requestedBlock}`,
      { before: placement.inventoryBefore, after: placement.inventoryAfter, confirmed: placement.confirmed },
      -1,
    );
    if (laid) return { status: "failed", detail: `${laid}; ${seen.join("; ")}` };

    const made = await runner.run(
      createCraftItemAction(bot, context.navigation),
      { items: [{ item_name: params.crafted, count: params.craftedCount }] },
      context.signal,
    );
    const crafted = craftItemResultSchema.parse(made.result).craft.items[0];
    if (!crafted) return { status: "failed", detail: `the craft reported no items; ${seen.join("; ")}` };
    seen.push(`crafted ${crafted.item} ${crafted.inventoryBefore}->${crafted.inventoryAfter} in ${made.durationMs} ms`);
    const gained = countMoved(
      `craft ${crafted.item}`,
      { before: crafted.inventoryBefore, after: crafted.inventoryAfter, confirmed: crafted.confirmed },
      params.craftedCount,
    );
    if (gained) return { status: "failed", detail: `${gained}; ${seen.join("; ")}` };

    return { status: "succeeded", detail: `every count settled: ${seen.join("; ")}` };
  } catch (cause) {
    const complaint = cause instanceof Error ? cause.message : String(cause);
    return { status: "failed", detail: `${complaint}; ${seen.join("; ") || "nothing observed"}` };
  }
}
