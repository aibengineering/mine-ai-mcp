/** Leave the flooded chamber breathing, with the declared health. */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { airSupplyTicks } from "../../../src/world/air-supply.ts";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  waitTicks: z.number().int().positive(),
  minHealth: z.number().min(0).max(20),
});

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const { bot } = context;
  const runtime = await openRuntime(context, "survival-breath");
  let died = false;
  const death = () => {
    died = true;
  };
  bot.on("death", death);
  try {
    for (let tick = 0; tick < params.waitTicks && !died; tick++) {
      context.signal.throwIfAborted();
      const air = airSupplyTicks(bot);
      const head = bot.blockAt(bot.entity.position.offset(0, bot.entity.height * 0.85, 0));
      if (air !== null && air >= 300 && head && !["water", "bubble_column"].includes(head.name)) {
        return {
          status: bot.health >= params.minHealth ? "succeeded" : "failed",
          detail: JSON.stringify({ air, health: bot.health, head: head.name, position: bot.entity.position }),
        };
      }
      await bot.waitForTicks(1);
    }
    return {
      status: "failed",
      detail: `Breathing goal unmet; air ${airSupplyTicks(bot)}, health ${bot.health}, died ${died}.`,
    };
  } finally {
    bot.off("death", death);
    await runtime.close();
  }
}
