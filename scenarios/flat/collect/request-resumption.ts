import {
  ActionRunner,
  createCollectBlockAction,
  createNavigateAction,
} from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Interrupt real physical work after observed progress; the fixture's claim only pauses the body. */
export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await bot.waitForTicks(5);
  const runner = new ActionRunner();
  const coal = bot.registry.itemsByName.coal!.id;
  let interrupted = false;
  const interruptCollection = () => {
    if (interrupted || bot.inventory.count(coal, null) !== 1) return;
    interrupted = true;
    runner.claim("fixture_reflex", "Pause after the first observed coal pickup", async () => {
      await bot.waitForTicks(3);
      return { value: null, continuation: { kind: "resume" as const } };
    });
  };
  bot.on("physicsTick", interruptCollection);
  let collected;
  try {
    collected = await runner.run(
      createCollectBlockAction(bot, context.navigation),
      { block_name: "coal_ore", count: 2, scaffold: false },
      context.signal,
    );
  } finally {
    bot.off("physicsTick", interruptCollection);
  }
  const count = bot.inventory.count(coal, null);
  if (
    !interrupted ||
    collected.result.status !== "succeeded" ||
    count !== 2 ||
    !("collected" in collected.result) ||
    collected.result.collected.blocksBroken !== 2
  ) {
    return { status: "failed", detail: JSON.stringify({ count, interrupted, collected }) };
  }

  const start = bot.entity.position.clone();
  let routeInterrupted = false;
  const interruptNavigation = () => {
    if (routeInterrupted || bot.entity.position.distanceTo(start) < 3) return;
    routeInterrupted = true;
    runner.claim("fixture_reflex", "Pause after observed route progress", async () => {
      await bot.waitForTicks(3);
      return { value: null, continuation: { kind: "resume" as const } };
    });
  };
  bot.on("physicsTick", interruptNavigation);
  let navigated;
  try {
    navigated = await runner.run(
      createNavigateAction(bot, context.navigation),
      { x: 30, y: -59, z: 0, range: 0, dig: false, scaffold: false },
      context.signal,
    );
  } finally {
    bot.off("physicsTick", interruptNavigation);
  }
  const reportedStart = "navigation" in navigated.result ? navigated.result.navigation.start : null;
  const passed =
    routeInterrupted &&
    navigated.result.status === "succeeded" &&
    reportedStart !== null &&
    Math.hypot(reportedStart.x - start.x, reportedStart.y - start.y, reportedStart.z - start.z) < 0.001;
  return { status: passed ? "succeeded" : "failed", detail: JSON.stringify({ count, collected, navigated, start }) };
};
