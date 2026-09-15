/** Prove two navigate calls can leave a cavern without opening the lake above it. */
import { once } from "node:events";
import type { Bot } from "mineflayer";
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import { createNavigateAction, ActionRunner } from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const EXIT = new Vec3(81, -51, 0);
const EXIT_RANGE = 2;
const HOME = new Vec3(0, -51, 10);
const HOME_RANGE = 2;

function occupiesWater(bot: Bot): boolean {
  const feet = bot.entity.position.floored();
  return [bot.blockAt(feet), bot.blockAt(feet.offset(0, 1, 0))].some(
    (block) => block?.name === "water" || block?.name === "bubble_column",
  );
}

async function waitForObservedPosition(bot: Bot, position: Vec3): Promise<void> {
  while (bot.blockAt(position) === null) await once(bot.world, "chunkColumnLoad");
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  try {
    await bot.waitForChunksToLoad();
    await waitForObservedPosition(bot, EXIT);
    context.signal.throwIfAborted();

    const runner = new ActionRunner();
    const navigate = createNavigateAction(bot, context.navigation);

    context.log(`navigate through the cavern to the distant dry exit at ${EXIT}`);
    const exitOutput = await runner.run(
      navigate,
      { x: EXIT.x, y: EXIT.y, z: EXIT.z, range: EXIT_RANGE },
      context.signal,
    );
    const exitResult = exitOutput.result;
    if (!("navigation" in exitResult)) {
      return { status: "failed", detail: exitResult.error };
    }

    const exitRemaining = exitResult.navigation.remainingDistance;
    if (exitRemaining === null) return { status: "failed", detail: "Unexpected dimension change on the exit leg." };
    const dryAtExit = !occupiesWater(bot);
    const exitDetail =
      `exit leg ${exitResult.status} in ${exitResult.navigation.elapsedMs} ms; ` +
      `${exitRemaining.toFixed(1)} from exit; ${dryAtExit ? "dry" : "still in water"}`;
    context.log(exitDetail);

    if (exitResult.status !== "succeeded" || exitRemaining > EXIT_RANGE || !dryAtExit) {
      return {
        status: "failed",
        detail:
          (exitResult.status === "succeeded" ? exitDetail : `${exitDetail}; ${exitResult.error}`) +
          `; ${context.pathfinder.summary()}`,
      };
    }

    context.log(`navigate over land from the exit to home at ${HOME}`);
    const homeOutput = await runner.run(
      navigate,
      { x: HOME.x, y: HOME.y, z: HOME.z, range: HOME_RANGE },
      context.signal,
    );
    const homeResult = homeOutput.result;
    if (!("navigation" in homeResult)) {
      return { status: "failed", detail: homeResult.error };
    }

    const homeRemaining = homeResult.navigation.remainingDistance;
    if (homeRemaining === null) return { status: "failed", detail: "Unexpected dimension change on the home leg." };
    const dryAtHome = !occupiesWater(bot);
    const detail =
      `${exitDetail}; home leg ${homeResult.status} in ${homeResult.navigation.elapsedMs} ms; ` +
      `${homeRemaining.toFixed(1)} from home; ${dryAtHome ? "dry" : "in water"}; ` +
      context.pathfinder.summary();
    context.log(detail);

    return homeResult.status === "succeeded" && homeRemaining <= HOME_RANGE && dryAtHome
      ? { status: "succeeded", detail }
      : {
          status: "failed",
          detail: homeResult.status === "succeeded" ? detail : `${detail}; ${homeResult.error}`,
        };
  } catch (cause) {
    if (context.signal.aborted) throw cause;
    return { status: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}
