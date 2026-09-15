import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { openRuntime } from "../../src/runtime.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const runtime = await openRuntime(context, "stone-from-water");
  let emptyArrivals = 0;
  const stop = new AbortController();
  const unsubscribe = runtime.navigation.onEvent((event) => {
    if (event.kind !== "goal_arrived" || event.result !== "continue") return;
    emptyArrivals += 1;
    // Diagnostic verdict, not a runtime deadline: a single block has no reason
    // to report twenty arrivals without producing its item.
    if (emptyArrivals === 20) stop.abort("Twenty arrivals did not complete one stone collection.");
  });
  try {
    const collect = runtime.actions.find((action) => action.name === "collect_block")!;
    const output = await runtime.run(
      collect,
      {
        block_name: "stone",
        count: 1,
        x: 1,
        y: -59,
        z: 0,
        scaffold: false,
      },
      AbortSignal.any([context.signal, stop.signal]),
    );
    return {
      status: output.result.status === "succeeded" ? "succeeded" : "failed",
      detail: JSON.stringify({
        emptyArrivals,
        output,
        health: context.bot.health,
        position: context.bot.entity.position,
      }),
    };
  } finally {
    unsubscribe();
    await runtime.close();
  }
}
