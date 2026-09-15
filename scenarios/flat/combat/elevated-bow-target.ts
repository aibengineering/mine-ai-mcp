import type { BotEvents } from "mineflayer";
import { ScenarioCombat } from "../../src/combat.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, navigation, signal }) => {
  const target = bot.nearestEntity((entity) => entity.name === "blaze");
  if (!target) return { status: "failed", detail: "No arranged blaze was observed." };
  const stop = new AbortController();
  let hits = 0;
  const hurt: BotEvents["entityHurt"] = (entity) => {
    if (entity.id !== target.id) return;
    hits++;
    stop.abort("fixture observed the requested ranged hit");
  };
  bot.on("entityHurt", hurt);
  try {
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
    const outcome = await scenarioCombat1.controller.engage(
      target.id,
      AbortSignal.any([signal, stop.signal]),
      "pursue",
    );
    const released = Object.values(bot.controlState).every((held) => !held);
    return {
      status: hits > 0 && released ? "succeeded" : "failed",
      detail: `hits=${hits}, attacks=${outcome.attacks}, styles=${outcome.stylesUsed}, released=${released}, outcome=${JSON.stringify(outcome)}`,
    };
  } finally {
    bot.off("entityHurt", hurt);
  }
};
