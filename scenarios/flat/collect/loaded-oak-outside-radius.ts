import { ActionRunner, createCollectBlockAction } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  await bot.waitForTicks(5);
  const target = new Vec3(70, -59, 0);
  if (bot.blockAt(target)?.name !== "oak_log") {
    return { status: "failed", detail: "Fixture oak was not loaded before collection." };
  }
  const stop = new AbortController();
  const branches: string[] = [];
  const unsubscribe = context.pathfinder.onEvent((event) => {
    if (event.kind === "search_started" && event.goal.startsWith("mine-branch:")) {
      branches.push(event.goal);
      stop.abort("Exploration ignored the already loaded oak.");
    }
  });
  try {
    const result = await new ActionRunner().run(
      createCollectBlockAction(bot, context.navigation),
      { block_name: "oak_log", count: 1, scaffold: false },
      AbortSignal.any([context.signal, stop.signal]),
    );
    if (result.result.status !== "succeeded" || branches.length > 0) {
      return { status: "failed", detail: `${JSON.stringify(result)}; exploration=${JSON.stringify(branches)}` };
    }
    const exact = new Vec3(140, -59, 0);
    if (bot.blockAt(exact)?.name !== "oak_log" || bot.entity.position.distanceTo(exact) <= 64) {
      return { status: "failed", detail: "Second oak must be loaded and beyond the former exact-target radius." };
    }
    const exactResult = await new ActionRunner().run(
      createCollectBlockAction(bot, context.navigation),
      { block_name: "oak_log", count: 1, scaffold: false, x: exact.x, y: exact.y, z: exact.z },
      AbortSignal.any([context.signal, stop.signal]),
    );
    return {
      status: exactResult.result.status === "succeeded" && branches.length === 0 ? "succeeded" : "failed",
      detail: `automatic=${JSON.stringify(result)}; exact=${JSON.stringify(exactResult)}; exploration=${JSON.stringify(branches)}`,
    };
  } finally {
    unsubscribe();
  }
};
