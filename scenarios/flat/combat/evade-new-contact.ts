import type { MineAiScenario } from "../../src/scenario-client.ts";
import { openRuntime, standStill } from "../../src/runtime.ts";
import { readEncounters, hurt } from "./reflex.ts";

/** Survive native contact from both sides; the runtime chooses its response. */
export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  await standStill(context);
  if (!(await hurt(context, 11))) return { status: "failed", detail: "Could not arrange wounded health." };
  const blazes = Object.values(bot.entities).filter((entity) => entity.name === "blaze");
  if (blazes.length !== 2) return { status: "failed", detail: "Both declared blazes must be present." };
  const runtime = await openRuntime(context, "new-blaze-contact");
  let died = false;
  const death = () => {
    died = true;
  };
  bot.on("death", death);
  try {
    bot.chat("/execute as @e[type=blaze] run data merge entity @s {NoAI:0b}");
    for (let tick = 0; tick < 400 && !died; tick++) {
      context.signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const encounters = await readEncounters(context, runtime);
    return {
      status: !died && bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({ died, health: bot.health, encounters }),
    };
  } finally {
    bot.off("death", death);
    await runtime.close();
  }
};
