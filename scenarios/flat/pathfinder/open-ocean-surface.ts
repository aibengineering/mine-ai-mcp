import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** EnderSeeker request 47, 2026-09-09: feet Y=61.889 above deep water, surface Y=62. */
export const run: MineAiScenario = async ({ bot, navigation, signal, log }) => {
  await bot.waitForChunksToLoad();
  bot.chat("/tp @s 0.5 61.88919456061508 0.5");
  while (bot.entity.position.x > 1) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  // Let the native physics observe water before the action samples its stance.
  await bot.waitForTicks(1);
  const start = bot.entity.position.clone();
  assert.equal(start.floored().y, 61, "The trial must start below the surface node.");
  assert.equal(bot.entity.onGround, false);
  for (const y of [60, 61, 62]) assert.equal(bot.blockAt(new Vec3(0, y, 0))?.name, "water");
  assert.equal(bot.blockAt(new Vec3(0, 63, 0))?.name, "air");
  log(`OCEAN_START ${JSON.stringify({ start, health: bot.health })}`);

  let swims = 0;
  let firstSwimHeight: number | null = null;
  const failures: string[] = [];
  const stop = navigation.onEvent((event) => {
    if (event.kind === "step_started") log(`OCEAN_STEP ${JSON.stringify(event)}`);
    if (event.kind === "step_completed" && event.movement === "swim") {
      swims++;
      firstSwimHeight ??= bot.entity.position.y;
    }
    if (event.kind === "step_failed") failures.push(event.observation);
  });
  try {
    const output = await new ActionRunner().run(
      createNavigateAction(bot, navigation),
      { x: 12, y: 64, z: 0, range: 0.5, dig: true, scaffold: true, build: false },
      signal,
    );
    const grounded = bot.entity.onGround;
    const end = bot.entity.position.clone();
    const detail = JSON.stringify({
      start,
      end,
      grounded,
      health: bot.health,
      swims,
      firstSwimHeight,
      failures,
      output,
    });
    log(`OCEAN_RESULT ${detail}`);
    return {
      status: output.result.status === "succeeded" && grounded && bot.health === 20 ? "succeeded" : "failed",
      detail,
    };
  } finally {
    stop();
  }
};
