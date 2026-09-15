import type { Bot } from "mineflayer";
import type { CombatController } from "../../survival/control/combat/contract.js";
import { DragonShotObservation } from "../../survival/perception/combat/dragon-shot.js";
import { defineAction } from "../action.js";
import { dragonShotCheckpointSchema } from "../checkpoint-schemas.js";
import { endCombatActionResult, endCombatActionResultSchema, formatEndCombatResult, interruptedEndCombatResult } from "../end-combat-result.js";
import { SHOOT_DRAGON, SHOOT_DRAGON_DESCRIPTION, shootDragonInputSchema } from "./contract.js";
export * from "./contract.js";

export function createShootDragonAction(bot: Bot, combat: CombatController) {
  return defineAction({
    name: SHOOT_DRAGON, description: SHOOT_DRAGON_DESCRIPTION,
    inputSchema: shootDragonInputSchema, resultSchema: endCombatActionResultSchema,
    checkpointSchema: dragonShotCheckpointSchema, formatResult: formatEndCombatResult,
    execution: { kind: "resumable_task" },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    parse: input => shootDragonInputSchema.parse(input),
    begin: (request, lifetime, observe) => {
      const observation = new DragonShotObservation(bot, request.entity_id, request.hitbox_margin);
      lifetime.addEventListener("abort", () => observation[Symbol.dispose](), { once: true });
      observe(() => ({
        baseline: { targetId: request.entity_id, dimension: observation.dimension, health: observation.healthBefore },
        checkpoint: { ...observation.evidence, attacks: observation.attacks, health: observation.healthAfter, died: observation.died },
        completion: { kind: "event", observed: observation.damageObserved > 0 || observation.died,
          owes: "Observed selected-dragon health loss after release or native dragon death; arrow release and disappearance alone do not confirm damage." },
      }));
      return async ({ signal = lifetime }) => {
        try {
          return endCombatActionResult(await combat.runEnd({ kind: "dragon_bow", targetId: request.entity_id, observation }, signal));
        } catch (cause) {
          if (!signal.aborted) throw cause;
          return interruptedEndCombatResult({ outcome: observation.died ? "dragon_died" : "stopped",
            attacks: observation.attacks, healthBefore: observation.healthBefore, healthAfter: observation.healthAfter,
            reason: "Dragon shot interrupted; any released arrow remains recorded.", bow: observation.evidence }, signal.reason);
        }
      };
    },
  });
}
