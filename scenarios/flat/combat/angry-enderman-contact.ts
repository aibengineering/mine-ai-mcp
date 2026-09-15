import type { BotEvents } from "mineflayer";
import { isThreat } from "../../../src/survival/perception/combat/threats.ts";
import { meleeDistance } from "../../../src/survival/weapons/melee.ts";
import { hasExposedBody } from "../../../src/world/entity-visibility.ts";
import { standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";
import { ScenarioCombat } from "../../src/combat.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("Contact fighter did not settle.");
  await wearArmor(context);
  const enderman = bot.nearestEntity((entity) => entity.name === "enderman")!;
  const zombie = bot.nearestEntity((entity) => entity.name === "zombie")!;
  await bot.equip(
    bot.inventory.items().find((item) => item.name === "shield")!,
    "off-hand",
  );
  const threats = { resolvedIds: new Set<number>(), attackerIds: new Set<number>() };
  const angry = (): boolean => isThreat(bot, enderman, threats);
  for (let ticks = 0; ticks < 60 && !angry(); ticks++) {
    signal.throwIfAborted();
    await bot.lookAt(enderman.position.offset(0, 2.6, 0), true);
    await bot.waitForTicks(1);
  }
  if (!angry())
    throw new Error(
      `Native gaze did not provoke the enderman: ${JSON.stringify({ kind: enderman.kind, position: enderman.position, metadata: enderman.metadata })}`,
    );
  const stop = new AbortController();
  const hitIds: number[] = [];
  const samples: unknown[] = [];
  using scenarioCombat1 = new ScenarioCombat(bot, navigation);
  const combat = scenarioCombat1.controller;
  let ticks = 0;
  let contactTicks = 0;
  const hurt: BotEvents["entityHurt"] = (entity, source) => {
    if (source?.id !== bot.entity.id) return;
    hitIds.push(entity.id);
    stop.abort("Observed native contact-defence hit.");
  };
  // Count actual attack opportunities, not a native teleport out of reach.
  // Forty reachable ticks permit shield readiness and a full sword cooldown.
  const tick = () => {
    const distance = meleeDistance(bot, enderman);
    const visible = hasExposedBody(bot, enderman);
    if (angry() && distance <= 3 && visible) contactTicks++;
    samples.push({
      tick: ticks++,
      contactTicks,
      phase: combat.execution(),
      position: enderman.position.clone(),
      distance,
      threat: angry(),
      visible,
    });
    if (contactTicks >= 40) stop.abort("No defensive answer during forty ticks in reach.");
  };
  bot.on("entityHurt", hurt);
  bot.on("physicsTick", tick);
  try {
    const outcome = await combat.engage(zombie.id, AbortSignal.any([signal, stop.signal]), "hold");
    return {
      status: hitIds[0] === enderman.id && bot.health >= 12 ? "succeeded" : "failed",
      detail: JSON.stringify({
        requested: zombie.id,
        angryContact: enderman.id,
        hitIds,
        ticks,
        contactTicks,
        health: bot.health,
        outcome,
        evidenceFile: await writeScenarioEvidence(context, "angry-enderman-contact.json", { samples }),
      }),
    };
  } finally {
    bot.off("entityHurt", hurt);
    bot.off("physicsTick", tick);
  }
};
