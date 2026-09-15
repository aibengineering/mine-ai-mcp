import { standStill, wearArmor } from "../../src/runtime.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";

/** A native angry quarry and an existing shelter; the controller chooses how to finish. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("The shelter start did not settle.");
  await wearArmor(context);
  using combat = new ScenarioCombat(bot, navigation);
  const target = bot.nearestEntity((entity) => entity.name === "enderman");
  if (!target) throw new Error("The quarry is missing.");
  const decisions: unknown[] = [];
  const remove = combat.controller.onDecision((event) => decisions.push(event));
  let minimumHealth = bot.health;
  const observe = () => { minimumHealth = Math.min(minimumHealth, bot.health); };
  bot.on("physicsTick", observe);
  try {
    bot.chat("/damage @e[type=minecraft:enderman,limit=1,sort=nearest] 1 minecraft:player_attack by @s");
    await bot.waitForTicks(5);
    const outcome = await combat.controller.engage(target.id, signal, "pursue");
    return { status: outcome.kind === "died" && minimumHealth > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({ outcome, minimumHealth, position: bot.entity.position,
        evidenceFile: await writeScenarioEvidence(context, "shelter-recovery.json", { decisions }) }) };
  } finally { remove(); bot.off("physicsTick", observe); }
};
