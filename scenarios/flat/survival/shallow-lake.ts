import { airSupplyTicks } from "../../../src/world/air-supply.ts";
import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  const runtime = await openRuntime(context, "shallow-lake");
  try {
    const status = runtime.actions.find((action) => action.name === "view_status")!;
    for (let tick = 0; tick < 500; tick++) {
      signal.throwIfAborted();
      if (tick % 20 === 0)
        log(
          JSON.stringify({
            tick,
            oxygen: bot.oxygenLevel,
            metadata: bot.entity.metadata,
            position: bot.entity.position,
            owner: runtime.status(),
          }),
        );
      await bot.waitForTicks(1);
    }
    const output = await runtime.run(status, {}, signal);
    log(JSON.stringify(output));
    const air = airSupplyTicks(bot);
    return {
      status: bot.health > 0 && air !== null && air >= 300 ? "succeeded" : "failed",
      detail: JSON.stringify({ air, health: bot.health, output }),
    };
  } finally {
    await runtime.close();
  }
};
