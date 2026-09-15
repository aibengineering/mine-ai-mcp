/** Exercise collection followed by a full underground-to-chest deposit journey. */
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
  ore: z.string(),
  drop: z.string(),
  count: z.number().int().positive(),
  chest: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
});

function actionFailure(result: { readonly status: string; readonly error?: string }, stage: string): Error {
  return new Error(`${stage} ${result.status}: ${result.error ?? "no error evidence"}`);
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  using data = SqlBotData.create({
    storage: { kind: "temporary" },
    identity: {
      worldId: context.scenario.name ?? "ore-return",
      scope: { kind: "bot", botId: bot.username },
    },
  });

  try {
    await bot.waitForChunksToLoad();
    context.signal.throwIfAborted();

    const request = paramsSchema.parse(context.scenario.params);
    const runner = new ActionRunner();
    context.log(`collect ${request.count} ${request.ore} from the underground pocket`);
    const collected = await runner.run(
      createCollectBlockAction(bot, context.navigation),
      { block_name: request.ore, count: request.count, scaffold: true },
      context.signal,
    );
    if (collected.result.status !== "succeeded") {
      throw actionFailure(collected.result, "underground collection");
    }
    context.log(`collection succeeded in ${collected.durationMs} ms at ${bot.entity.position.toString()}`);

    const [chestX, chestY, chestZ] = request.chest;
    context.log(`return from underground and deposit ${request.count} ${request.drop} into the surface chest`);
    const deposited = await runner.run(
      createUseContainerAction(bot, context.navigation, data),
      {
        operation: "deposit",
        x: chestX,
        y: chestY,
        z: chestZ,
        items: [{ item_name: request.drop, count: request.count }],
      },
      context.signal,
    );
    if (deposited.result.status !== "succeeded") {
      throw actionFailure(deposited.result, "chest deposit");
    }

    const chest = bot.blockAt(new Vec3(chestX, chestY, chestZ));
    if (!chest) throw new Error("surface chest was not loaded for independent inspection");
    const window = await bot.openContainer(chest);
    const physicalCount = window
      .containerItems()
      .filter((item) => item.name === request.drop)
      .reduce((total, item) => total + item.count, 0);
    window.close();
    const rememberedCount = data.read(
      "SELECT item_count FROM observed_container_items WHERE item_name = ?",
      request.drop,
    )[0]?.item_count;

    if (physicalCount !== request.count || rememberedCount !== request.count) {
      throw new Error(
        `expected chest and memory to contain ${request.drop} x${request.count}; ` +
          `observed ${physicalCount} and ${String(rememberedCount)}`,
      );
    }

    return {
      status: "succeeded",
      detail:
        `collected underground and deposited ${request.drop} x${request.count} into the surface chest ` +
        `with matching physical and remembered contents; ${context.pathfinder.summary()}`,
    };
  } catch (cause) {
    const complaint = cause instanceof Error ? cause.message : String(cause);
    const detail = `${complaint}; ${context.pathfinder.summary()}`;
    context.log(detail);
    return { status: "failed", detail };
  }
}
