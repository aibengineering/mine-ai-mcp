import type { BotEvents } from "mineflayer";
import { ScenarioCombat } from "../../src/combat.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Server-observed hits and arrivals of real arrows qualify the normal combat owner. */
export const run: MineAiScenario = async ({ bot, navigation, signal, scenario, log }) => {
  const target = bot.nearestEntity((entity) => entity.name === "blaze");
  if (!target) return { status: "failed", detail: "The arranged blaze was not observed" };
  const stop = new AbortController();
  const arrows: { id: number; position: { x: number; y: number; z: number }; pitch: number }[] = [];
  let hits = 0;
  let ticksAfterSixth = 0;
  const hurt: BotEvents["entityHurt"] = (entity) => {
    if (entity.id === target.id) hits++;
  };
  const spawn: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name === "arrow")
      arrows.push({ id: entity.id, position: { ...entity.position }, pitch: bot.entity.pitch });
  };
  const tick = () => {
    // Six shots are this fixture's ammunition budget; allow the last arrow to finish its flight.
    if (arrows.length >= 6 && ++ticksAfterSixth >= 20) stop.abort("Six-shot qualification finished");
  };
  bot.on("entityHurt", hurt);
  bot.on("entitySpawn", spawn);
  bot.on("physicsTick", tick);
  try {
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
    const outcome = await scenarioCombat1.controller.engage(
      target.id,
      AbortSignal.any([signal, stop.signal]),
      "pursue",
    );
    const clearance = scenario.name !== "bow-curved-occlusion" || arrows.every((arrow) => arrow.position.x > 1);
    const released = Object.values(bot.controlState).every((held) => !held);
    log(JSON.stringify({ arrows, hits, outcome, clearance, released }));
    return {
      status: outcome.kind === "died" && released ? "succeeded" : "failed",
      detail: JSON.stringify({ hits, arrows: arrows.length, outcome, clearance, released }),
    };
  } finally {
    bot.off("entityHurt", hurt);
    bot.off("entitySpawn", spawn);
    bot.off("physicsTick", tick);
  }
};
