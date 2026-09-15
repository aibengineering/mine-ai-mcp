import type { BotEvents } from "mineflayer";
import { ScenarioCombat } from "../../src/combat.ts";

import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, navigation, signal }) => {
  const target = bot.nearestEntity((entity) => entity.name === "chicken");
  if (!target) return { status: "failed", detail: "No arranged chicken observed." };
  const stop = new AbortController();
  let arrows = 0;
  let obstructedArrows = 0;
  let hits = 0;
  const spawn: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name !== "arrow") return;
    arrows++;
    const eye = bot.entity.position.offset(0, 1.62, 0);
    const aim = target.position.offset(0, Math.max(0.5, target.height / 2), 0);
    const delta = aim.minus(eye);
    if (bot.world.raycast(eye, delta.scaled(1 / delta.norm()), delta.norm())) {
      obstructedArrows++;
      stop.abort("observed an arrow spawned toward obstructing terrain");
    }
  };
  const hurt: BotEvents["entityHurt"] = (entity) => {
    if (entity.id !== target.id) return;
    hits++;
    stop.abort("observed target hit");
  };
  bot.on("entitySpawn", spawn);
  bot.on("entityHurt", hurt);
  const start = bot.entity.position.clone();
  try {
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
    const outcome = await scenarioCombat1.controller.engage(
      target.id,
      AbortSignal.any([signal, stop.signal]),
      "pursue",
    );
    await bot.waitForTicks(5);
    const moved = start.distanceTo(bot.entity.position);
    const released = Object.values(bot.controlState).every((held) => !held);
    return {
      status: hits > 0 && released ? "succeeded" : "failed",
      detail: `arrows=${arrows}, obstructedArrows=${obstructedArrows}, hits=${hits}, moved=${moved}, released=${released}, outcome=${JSON.stringify(outcome)}`,
    };
  } finally {
    bot.off("entitySpawn", spawn);
    bot.off("entityHurt", hurt);
  }
};
