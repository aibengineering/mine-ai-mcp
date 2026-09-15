import type { Bot } from "mineflayer";
import type { ClientCompletion } from "mine-labs/client";
import { createMinecraftRuntime } from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const SURVIVAL_MS = 40_000;

function occupiesWater(bot: Bot): boolean {
  const feet = bot.entity.position.floored();
  return [bot.blockAt(feet), bot.blockAt(feet.offset(0, 1, 0))].some(
    (block) => block?.name === "water" || block?.name === "bubble_column",
  );
}

type UnderwaterWait = "survived" | "died" | "cancelled";

function waitUnderwater(bot: Bot, signal: AbortSignal): Promise<UnderwaterWait> {
  if (bot.health <= 0) return Promise.resolve("died");
  if (signal?.aborted) return Promise.resolve("cancelled");

  return new Promise((resolve) => {
    const settle = (outcome: UnderwaterWait): void => {
      clearTimeout(survivalTimer);
      bot.removeListener("death", onDeath);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    const onDeath = (): void => settle("died");
    const onAbort = (): void => settle("cancelled");
    const survivalTimer = setTimeout(() => settle("survived"), SURVIVAL_MS);

    bot.once("death", onDeath);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The bot spawns at the bottom of a deep pool with no action running. The
 * runtime's idle water-surface rise has to keep it breathing on its own.
 * `navigate` no longer takes a target in open water, so the pool is
 * entered by spawning in it rather than by walking in.
 */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  let runtime: Awaited<ReturnType<typeof createMinecraftRuntime>> | undefined;
  try {
    runtime = await createMinecraftRuntime(bot, {
      botData: {
        storage: { kind: "temporary" },
        identity: {
          worldId: "idle-underwater-survival-scenario",
          scope: { kind: "bot", botId: bot.username },
        },
      },
    });
    context.signal.throwIfAborted();
    await bot.waitForTicks(5);
    if (!occupiesWater(bot)) {
      return { status: "failed", detail: `The bot did not spawn in water; it stands at ${bot.entity.position}.` };
    }

    const healthBefore = bot.health;
    context.log(`idle in the pool for ${SURVIVAL_MS} ms at health ${healthBefore}`);
    const outcome = await waitUnderwater(bot, context.signal);
    const detail = `${outcome}; health ${healthBefore} -> ${bot.health}; ${occupiesWater(bot) ? "in water" : "out of the water"}`;
    return outcome === "survived" && bot.health >= healthBefore - 2
      ? { status: "succeeded", detail }
      : { status: "failed", detail };
  } finally {
    await runtime?.close();
  }
}
