import { standStill, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { writeScenarioEvidence } from "../../src/scenario-evidence.ts";
import type { CombatOutcome } from "../../../src/survival/control/combat/contract.ts";

/** Two native encounters share finite supplies; successful tactics are unrestricted. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("Fighter did not settle.");
  await wearArmor(context);
  using combat = new ScenarioCombat(bot, navigation);
  const outcomes: CombatOutcome[] = [];
  const decisions: unknown[] = [];
  const remove = combat.controller.onDecision((event) => decisions.push(event));
  try {
    for (let encounter = 0; encounter < 2; encounter++) {
      const target = bot.nearestEntity((entity) => entity.name === "enderman" &&
        entity.isValid && !combat.perception.resolvedIds.has(entity.id));
      if (!target) break;
      const outcome = await combat.controller.engage(target.id, signal, "pursue");
      outcomes.push(outcome);
      if (outcome.kind !== "died") break;
    }
    return {
      status: outcomes.length === 2 && outcomes.every((outcome) => outcome.kind === "died") && bot.health > 0
        ? "succeeded" : "failed",
      detail: JSON.stringify({ outcomes, health: bot.health,
        evidenceFile: await writeScenarioEvidence(context, "enderman-shelter-pair.json", { decisions }) }),
    };
  } finally { remove(); }
};
