/** Exercise the current survival progression as one dependent action journey. */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import {
  attachHighlighter,
  ActionRunner,
  createCollectBlockAction,
  createCraftItemAction,
  createNavigateAction,
  createPlaceBlockAction,
  createSmeltItemAction,
} from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  table: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  furnace: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  logs: z.number().int().positive(),
  dirt: z.number().int().positive(),
  stone: z.number().int().positive(),
  coal: z.number().int().positive(),
  rawIron: z.number().int().positive(),
  diamonds: z.number().int().positive(),
});

interface StageOutput {
  readonly durationMs: number;
  readonly result: { readonly status: string; readonly error?: string };
}

async function requireStage(
  context: MineAiScenarioContext,
  name: string,
  run: () => Promise<StageOutput>,
): Promise<number> {
  context.log(`${name}: starting`);
  const output = await run();
  const error = output.result.error ? ` — ${output.result.error}` : "";
  context.log(`${name}: ${output.result.status} in ${output.durationMs} ms${error}`);
  if (output.result.status !== "succeeded") {
    throw new Error(`${name} ${output.result.status}: ${output.result.error ?? "no error evidence"}`);
  }
  return output.durationMs;
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const { highlighter } = attachHighlighter(bot);
  const runner = new ActionRunner({ highlighter });
  const collect = createCollectBlockAction(bot, context.navigation);
  const craft = createCraftItemAction(bot, context.navigation);
  const navigate = createNavigateAction(bot, context.navigation);
  const place = createPlaceBlockAction(bot, context.navigation);
  const smelt = createSmeltItemAction(bot, context.navigation);
  const stages: string[] = [];

  try {
    await bot.waitForChunksToLoad();
    context.signal.throwIfAborted();
    if (bot.game.difficulty !== "peaceful") {
      throw new Error(`expected peaceful difficulty; Mineflayer observed ${bot.game.difficulty}`);
    }

    const request = paramsSchema.parse(context.scenario.params);
    const stage = async (name: string, work: () => Promise<StageOutput>) => {
      const durationMs = await requireStage(context, name, work);
      stages.push(`${name} ${durationMs} ms`);
    };

    await stage("collect logs", () =>
      runner.run(collect, { block_name: "logs", count: request.logs, scaffold: false }, context.signal),
    );
    await stage("craft table", () =>
      runner.run(craft, { items: [{ item_name: "crafting_table", count: 1 }] }, context.signal),
    );

    const [tableX, tableY, tableZ] = request.table;
    await stage("place table", () =>
      runner.run(place, { block_name: "crafting_table", x: tableX, y: tableY, z: tableZ }, context.signal),
    );
    await stage("craft wooden tools", () =>
      runner.run(
        craft,
        {
          items: [
            { item_name: "wooden_pickaxe", count: 1 },
            { item_name: "wooden_shovel", count: 1 },
          ],
        },
        context.signal,
      ),
    );
    await stage("pick up crafting table", () =>
      runner.run(
        collect,
        { block_name: "crafting_table", x: tableX, y: tableY, z: tableZ, scaffold: false },
        context.signal,
      ),
    );
    await stage("collect dirt", () =>
      runner.run(collect, { block_name: "dirt", count: request.dirt, scaffold: false }, context.signal),
    );
    await stage("collect stone", () =>
      runner.run(collect, { block_name: "stone", count: request.stone, scaffold: false }, context.signal),
    );
    await stage("return to crafting table", () =>
      runner.run(navigate, { x: tableX, y: tableY, z: tableZ, range: 2 }, context.signal),
    );
    await stage("place table", () =>
      runner.run(place, { block_name: "crafting_table", x: tableX, y: tableY, z: tableZ }, context.signal),
    );
    await stage("craft stone tools", () =>
      runner.run(
        craft,
        {
          items: [
            { item_name: "stone_pickaxe", count: 1 },
            { item_name: "stone_shovel", count: 1 },
          ],
        },
        context.signal,
      ),
    );
    await stage("craft furnace", () =>
      runner.run(craft, { items: [{ item_name: "furnace", count: 1 }] }, context.signal),
    );

    const [furnaceX, furnaceY, furnaceZ] = request.furnace;
    await stage("stage furnace placement", () =>
      runner.run(navigate, { x: furnaceX - 3, y: furnaceY, z: furnaceZ, range: 0 }, context.signal),
    );
    await stage("place furnace", () =>
      runner.run(place, { block_name: "furnace", x: furnaceX, y: furnaceY, z: furnaceZ }, context.signal),
    );
    await stage("pick up crafting table", () =>
      runner.run(
        collect,
        { block_name: "crafting_table", x: tableX, y: tableY, z: tableZ, scaffold: false },
        context.signal,
      ),
    );
    await stage("collect coal", () =>
      runner.run(collect, { block_name: "coal_ore", count: request.coal, scaffold: false }, context.signal),
    );
    await stage("collect raw iron", () =>
      runner.run(collect, { block_name: "iron_ore", count: request.rawIron, scaffold: false }, context.signal),
    );
    await stage("smelt iron", () =>
      runner.run(
        smelt,
        {
          item_name: "raw_iron",
          count: request.rawIron,
          fuel_item_name: "coal",
          x: furnaceX,
          y: furnaceY,
          z: furnaceZ,
        },
        context.signal,
      ),
    );
    await stage("pick up furnace", () =>
      runner.run(
        collect,
        { block_name: "furnace", x: furnaceX, y: furnaceY, z: furnaceZ, scaffold: false },
        context.signal,
      ),
    );
    await stage("place table", () =>
      runner.run(place, { block_name: "crafting_table", x: tableX, y: tableY, z: tableZ }, context.signal),
    );
    await stage("craft iron pickaxe", () =>
      runner.run(craft, { items: [{ item_name: "iron_pickaxe", count: 1 }] }, context.signal),
    );
    await stage("pick up crafting table", () =>
      runner.run(
        collect,
        { block_name: "crafting_table", x: tableX, y: tableY, z: tableZ, scaffold: false },
        context.signal,
      ),
    );
    await stage("collect diamond", () =>
      runner.run(collect, { block_name: "diamond_ore", count: request.diamonds, scaffold: false }, context.signal),
    );

    return {
      status: "succeeded",
      detail: `peaceful progression reached diamond; ${stages.join("; ")}; ${context.pathfinder.summary()}`,
    };
  } catch (cause) {
    const complaint = cause instanceof Error ? cause.message : String(cause);
    return {
      status: "failed",
      detail: `${complaint}; completed stages: ${stages.join("; ") || "none"}; ${context.pathfinder.summary()}`,
    };
  }
}
