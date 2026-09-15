/** Reproduce the live handoff from tree collection to viewing a ground-level chest. */
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { z } from "zod";
import {
  ActionRunner,
  createCollectBlockAction,
  createUseContainerAction,
  SqlBotData,
} from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  logs: z.number().int().positive(),
  chest: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
});

function failure(result: { readonly status: string; readonly error?: string }, stage: string): Error {
  return new Error(`${stage} ${result.status}: ${result.error ?? "no error evidence"}`);
}

function position(bot: MineAiScenarioContext["bot"]): string {
  const feet = bot.entity.position.floored();
  const support = bot.blockAt(feet.offset(0, -1, 0));
  return `${feet.toString()} over ${support?.name ?? "unloaded"}`;
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  using data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: {
      worldId: context.scenario.name ?? "tree-canopy-chest-handoff",
      scope: { kind: "bot", botId: bot.username },
    },
  });
  try {
    await bot.waitForChunksToLoad();
    context.signal.throwIfAborted();
    const request = paramsSchema.parse(context.scenario.params);
    const runner = new ActionRunner();

    context.log(`collect tree logs before returning to the chest; start ${position(bot)}`);
    const collected = await runner.run(
      createCollectBlockAction(bot, context.navigation),
      { block_name: "logs", count: request.logs, scaffold: true },
      context.signal,
    );
    const afterCollect = position(bot);
    context.log(`collection ${collected.result.status} after ${collected.durationMs} ms at ${afterCollect}`);
    if (collected.result.status !== "succeeded") throw failure(collected.result, "tree collection");

    const [x, y, z] = request.chest;
    context.log(`inspect the ground chest at ${request.chest.join(",")}`);
    const inspected = await runner.run(
      createUseContainerAction(bot, context.navigation, data),
      { operation: "inspect", x, y, z },
      context.signal,
    );
    if (inspected.result.status !== "succeeded") throw failure(inspected.result, "chest inspection");

    const chest = bot.blockAt(new Vec3(x, y, z));
    if (chest?.name !== "chest")
      throw new Error(`expected a chest after inspection; observed ${chest?.name ?? "unloaded"}`);
    const final = position(bot);
    return {
      status: "succeeded",
      detail:
        `collected oak_log x${request.logs} at ${afterCollect}, then inspected the ground chest and settled ${final}; ` +
        context.pathfinder.summary(),
    };
  } catch (cause) {
    const complaint = cause instanceof Error ? cause.message : String(cause);
    return {
      status: "failed",
      detail: `${complaint}; last position ${position(bot)}; ${context.pathfinder.summary()}`,
    };
  }
}
