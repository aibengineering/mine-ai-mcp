import type { BotEvents } from "mineflayer";
import { ScenarioCombat } from "../../src/combat.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("Weapon transition fighter did not settle.");
  const target = bot.nearestEntity((entity) => entity.name === "blaze")!;
  using scenarioCombat1 = new ScenarioCombat(bot, navigation);
  const controller = scenarioCombat1.controller;
  const stop = new AbortController();
  let hits = 0;
  let arrows = 0;
  let afterHitTicks = 0;
  const states: unknown[] = [];
  const flags = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (entity.id !== target.id || source?.id !== bot.entity.id) return;
    if (++hits === 1) {
      // Isolate the loadout transition after a native shielded sword hit.
      // The stationary distant target removes aim and native flight randomness.
      bot.chat("/tp @e[tag=transition_target,limit=1] 14.5 -60 0.5");
    }
  };
  const spawned: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name === "arrow") arrows++;
  };
  const tick = () => {
    states.push({ phase: controller.execution(), held: bot.heldItem?.name, serverUse: bot.entity.metadata[flags] });
    // Ten seconds after contact allows several full draws and their flights.
    if (hits > 0 && ++afterHitTicks >= 200) stop.abort("Weapon transition did not finish in ten seconds.");
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
        afterHitTicks,
        statesCount: states.length,
        evidenceFile: await writeScenarioEvidence(context, "shielded-melee-to-bow.json", { states }),
      }),
    };
  } finally {
    bot.off("entityHurt", hurt);
    bot.off("entitySpawn", spawned);
    bot.off("physicsTick", tick);
  }
};
