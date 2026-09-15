import { z } from "zod";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** A deliberately quiet source qualifies the bounded camping contract. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const { quarryAppears } = z
    .object({ quarryAppears: z.boolean().default(false) })
    .parse(context.scenario.params ?? {});
  await bot.waitForChunksToLoad();
  await using runtime = await openRuntime(context, "spawner-camp");
  const hunt = runtime.actions.find((a) => a.name === "collect_mob_drop")!;
  const startedAt = Date.now();
  const result = await runtime.run(
    hunt,
    { mob_name: "sheep", drop_name: "white_wool", count: 1, camp_spawner: true, observe_for_ms: 1500 },
    signal,
  );
  const termination = Reflect.get(result.result, "termination");
  const wool = bot.inventory.count(bot.registry.itemsByName.white_wool!.id, null);
  const returnedCorrectly = quarryAppears
    ? result.result.status === "succeeded" && wool >= 1
    : termination === "observation_exhausted" && wool === 0;
  return {
    status: returnedCorrectly && bot.health > 0 ? "succeeded" : "failed",
    detail: JSON.stringify({ elapsedMs: Date.now() - startedAt, health: bot.health, wool, result }),
  };
};
