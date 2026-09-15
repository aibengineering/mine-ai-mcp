import type { BotEvents } from "mineflayer";
import { ScenarioCombat } from "../../src/combat.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("Bow fighter did not settle on the ledge.");
  const target = bot.nearestEntity((entity) => entity.name === "blaze")!;
  using scenarioCombat1 = new ScenarioCombat(bot, navigation);
  const controller = scenarioCombat1.controller;
  const stop = new AbortController();
  let hits = 0;
  let arrows = 0;
  let ticks = 0;
  const states: unknown[] = [];
  const flags = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id === target.id && source?.id === bot.entity.id) hits++;
  };
  const spawned: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name === "arrow") arrows++;
  };
  const tick = () => {
    states.push({ phase: controller.execution(), held: bot.heldItem?.name, serverUse: bot.entity.metadata[flags] });
    // Ten seconds permits at least six full draws against this stationary target.
    if (++ticks >= 200) stop.abort("No observed bow kill within ten seconds.");
  };
  bot.on("entityHurt", hurt);
  bot.on("entitySpawn", spawned);
  bot.on("physicsTick", tick);
  try {
    const outcome = await controller.engage(target.id, AbortSignal.any([signal, stop.signal]), "pursue");
    return {
      status: outcome.kind === "died" && bot.health > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({
        outcome,
        hits,
        arrows,
        ticks,
        statesCount: states.length,
        evidenceFile: await writeScenarioEvidence(context, "bow-after-refused-backstop.json", { states }),
      }),
    };
  } finally {
    bot.off("entityHurt", hurt);
    bot.off("entitySpawn", spawned);
    bot.off("physicsTick", tick);
  }
};
