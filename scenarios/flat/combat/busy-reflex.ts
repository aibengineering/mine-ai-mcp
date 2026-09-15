/**
 * The bot is part-way through an action that is not navigation, and a zombie
 * walks up to it.
 *
 * Smelting is the useful shape here: it takes the bot to a furnace, opens a
 * window, and then waits out a long cook with the pathfinder idle. The old
 * takeover watched `pathfinder.active`, so this whole cook was a blind spot.
 * The fixture requires the exposed bot to finish the requested cook and
 * survive. Preemption, fighting and continuation are implementation choices.
 */
import { SMELT_ITEM, smeltItemResultSchema } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { describe, readEncounters } from "./reflex.ts";

const paramsSchema = z.strictObject({
  itemName: z.string(),
  count: z.number().int().positive(),
  fuelItemName: z.string(),
  furnace: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
});

// @function-metrics size=20 branches=6 fan-out=8 depth=3 interface=3 fan-in=0
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const runtime = await openRuntime(context, "combat-busy");
  let died = false;
  const death = () => {
    died = true;
  };
  context.bot.on("death", death);
  try {
    const smeltAction = runtime.actions.find((action) => action.name === SMELT_ITEM);
    if (!smeltAction) throw new Error("The busy-reflex scenario could not find its production smelt action.");

    const [x, y, zPosition] = params.furnace;
    const smelt = await runtime.run(
      smeltAction,
      {
        item_name: params.itemName,
        count: params.count,
        fuel_item_name: params.fuelItemName,
        x,
        y,
        z: zPosition,
      },
      context.signal,
    );
    if ("kind" in smelt.result) {
      return {
        status: "failed",
        detail: `The cook did not complete: ${JSON.stringify(smelt.result)}`,
      };
    }
    const result = smeltItemResultSchema.parse(smelt.result);
    if (result.status !== "succeeded") return { status: "failed", detail: `The cook did not succeed: ${result.error}` };
    const encounters = await readEncounters(context, runtime);
    if (context.bot.currentWindow) {
      return { status: "failed", detail: "The completed cook left its furnace window open." };
    }

    return {
      status: !died && context.bot.health > 0 ? "succeeded" : "failed",
      detail: `Cook completed and furnace closed; health ${context.bot.health}; died ${died}; interruptions ${smelt.interruptions?.join("; ") ?? "none"}; ${encounters.map(describe).join(" | ")}`,
    };
  } finally {
    context.bot.off("death", death);
    await runtime.close();
  }
}
