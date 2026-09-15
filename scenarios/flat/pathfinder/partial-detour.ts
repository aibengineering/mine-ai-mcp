import {
  createMovements,
  createNavigateAction,
  ActionRunner,
} from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, navigation, pathfinder, signal, log }) => {
  const stop = pathfinder.onEvent((event) => {
    if (event.kind === "route_committed") log(JSON.stringify({ start: event.plan.start, end: event.plan.end }));
  });
  try {
    // Force partial search results in a small fixture; the live hillside used
    // the normal budgets and showed the same repeated 16-step reversals.
    const limits = { primaryTimeoutMs: 0, failureTimeoutMs: 1_000 };
    const action = createNavigateAction(bot, navigation, {
      createMovements: createMovements,
      navigate: (options) => navigation.navigate({ ...options, searchLimits: limits }),
    });
    const output = await new ActionRunner().run(action, { x: 20, y: -60, z: 0, range: 0 }, signal);
    return { status: output.result.status === "succeeded" ? "succeeded" : "failed", detail: JSON.stringify(output) };
  } finally {
    stop();
  }
};
