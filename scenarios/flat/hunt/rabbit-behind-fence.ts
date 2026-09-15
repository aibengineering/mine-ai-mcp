import { COLLECT_MOB_DROP } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { declaredEntitiesArranged, openRuntime, standStill } from "../../src/runtime.ts";

/** Verify that an impossible acquisition terminates without claiming or producing the requested drop. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  await declaredEntitiesArranged(context);
  if (!(await standStill(context))) return { status: "failed", detail: "Player did not settle." };
  const rabbitHide = bot.registry.itemsByName.rabbit_hide!;
  const before = bot.inventory.count(rabbitHide.id, null);
  let deaths = 0;
  const death = () => {
    deaths++;
  };
  bot.on("death", death);
  const runtime = await openRuntime(context, "rabbit-behind-fence");
  try {
    const hunt = runtime.actions.find((action) => action.name === COLLECT_MOB_DROP)!;
    const output = await runtime.run(hunt, { mob_name: "rabbit", drop_name: "rabbit_hide", count: 1 }, signal);
    // Keep the client alive for the fixture's declared one-second survival observation.
    for (let tick = 0; tick < 20 && deaths === 0; tick++) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const gained = bot.inventory.count(rabbitHide.id, null) - before;
    const evidence = { output, gained, deaths, health: bot.health };
    log(`UNREACHABLE_ACQUISITION ${JSON.stringify(evidence)}`);
    return {
      status:
        output.result.status !== "succeeded" && gained === 0 && deaths === 0 && bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify(evidence),
    };
  } finally {
    bot.off("death", death);
    await runtime.close();
  }
};
