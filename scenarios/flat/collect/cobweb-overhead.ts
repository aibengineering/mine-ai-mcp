import { ActionRunner, createCollectBlockAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  await context.bot.waitForTicks(5);
  const stop = new AbortController();
  const unsubscribe = context.pathfinder.onEvent((event) => {
    if (
      event.kind === "route_committed" &&
      event.plan.steps.some(
        (step) => step.id.startsWith("excavate:") && !step.operations.some((operation) => operation.kind === "break"),
      )
    ) {
      stop.abort("Excavation planned no break for the observed cobweb.");
    }
  });
  try {
    const result = await new ActionRunner().run(
      createCollectBlockAction(context.bot, context.navigation),
      { block_name: "cobweb", count: 1, scaffold: false },
      AbortSignal.any([context.signal, stop.signal]),
    );
    return { status: result.result.status === "succeeded" ? "succeeded" : "failed", detail: JSON.stringify(result) };
  } finally {
    unsubscribe();
  }
};
