/** Run one frontier expansion against a real disposable Mine Labs world. */
import {
  EXPLORE_FRONTIER,
  createMinecraftRuntime,
  exploreFrontierResultSchema,
} from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";

import type { MineAiScenarioContext } from "./scenario-client.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const runtime = await createMinecraftRuntime(bot, {
    botData: {
      storage: { kind: "temporary" },
      identity: {
        worldId: "explore-scenario",
        scope: { kind: "bot", botId: bot.username },
      },
    },
  });
  const {
    expect_biome_status: expectedBiomeStatus,
    expect_airborne_entry: expectAirborneEntry,
    ...request
  } = context.scenario.params;
  let observedAirborneEntry = false;
  const observeAirborneEntry = () => {
    const feet = bot.entity.position.floored();
    if (
      !bot.entity.onGround &&
      bot.world.getColumnAt(feet) &&
      bot.registry.biomes[bot.world.getBiome(feet)]?.name === request.biome
    )
      observedAirborneEntry = true;
  };
  if (expectAirborneEntry === true) bot.on("physicsTick", observeAirborneEntry);
  try {
    const requestedChunks = typeof request.chunks === "number" ? request.chunks : 1;
    const start = bot.entity.position.clone();
    context.log(`explore_frontier ${JSON.stringify(request)}`);
    const action = runtime.actions.find((candidate) => candidate.name === EXPLORE_FRONTIER);
    if (!action) throw new Error(`${EXPLORE_FRONTIER} is not available`);
    const output = await runtime.run(action, request, context.signal);
    const result = exploreFrontierResultSchema.parse(output.result);
    const error = "error" in result ? result.error : "";
    context.log(`${result.status} (${output.durationMs} ms)${error ? ` — ${error}` : ""}`);

    const moved = bot.entity.position.distanceTo(start);
    const expanded = "explored" in result ? result.explored.expandedChunks : 0;
    if (typeof request.biome === "string") {
      const biome = result.explored.biome;
      context.log(JSON.stringify(result.explored));
      const actualBiome = bot.registry.biomes[bot.world.getBiome(bot.entity.position.floored())]?.name;
      const entered =
        result.status === "succeeded" &&
        biome?.status === "entered" &&
        biome.name === request.biome &&
        actualBiome === request.biome &&
        bot.entity.onGround &&
        (expectAirborneEntry !== true || observedAirborneEntry);
      const exhausted =
        result.status === "partial" &&
        biome?.status === "not_observed" &&
        expanded >= requestedChunks &&
        actualBiome !== request.biome &&
        error.includes("EXPLORATION_BIOME_NOT_OBSERVED");
      const passed = expectedBiomeStatus === "not_observed" ? exhausted : entered;
      return {
        status: passed ? "succeeded" : "failed",
        detail: `${biome?.status}; feet biome ${actualBiome}; grounded ${bot.entity.onGround}; airborne entry ${observedAirborneEntry}; expanded ${expanded}; moved ${moved.toFixed(1)} blocks; ${error}`,
      };
    }
    return result.status === "succeeded" && expanded >= requestedChunks
      ? { status: "succeeded", detail: `expanded ${expanded} chunk column(s); moved ${moved.toFixed(1)} blocks` }
      : { status: "failed", detail: error || `expanded ${expanded}/${requestedChunks} chunk columns` };
  } finally {
    if (expectAirborneEntry === true) bot.off("physicsTick", observeAirborneEntry);
    await runtime.close();
  }
}
