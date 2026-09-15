import { dragonCheckpointSchema } from "../checkpoint-schemas.js";
import type { CombatController } from "../../survival/control/combat/contract.js";

import type { Bot } from "mineflayer";
import { PerchObservation } from "../../survival/perception/combat/perch.js";
import { defineAction } from "../action.js";
import {
  endCombatActionResult,
  endCombatActionResultSchema,
  formatEndCombatResult,
  interruptedEndCombatResult,
} from "../end-combat-result.js";
import {
  ATTACK_DRAGON_PERCH,
  ATTACK_DRAGON_PERCH_DESCRIPTION,
  attackDragonPerchInputSchema,
} from "./contract.js";
export * from "./contract.js";
export function createAttackDragonPerchAction(bot: Bot, combat: CombatController) {
  return defineAction({
    checkpointSchema: dragonCheckpointSchema,
    name: ATTACK_DRAGON_PERCH,
    description: ATTACK_DRAGON_PERCH_DESCRIPTION,
    inputSchema: attackDragonPerchInputSchema,
    resultSchema: endCombatActionResultSchema,
    formatResult: formatEndCombatResult,
    execution: { kind: "resumable_task" },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    parse: (input) => attackDragonPerchInputSchema.parse(input),
    begin: (request, lifetime, observe) => {
      const observation = new PerchObservation(bot, request.entity_id);
      lifetime.addEventListener("abort", () => observation[Symbol.dispose](), { once: true });
      observe(() => ({
        baseline: { targetId: request.entity_id, dimension: observation.dimension, health: observation.healthBefore },
        checkpoint: {
          entered: observation.entered,
          ended: observation.ended,
          died: observation.died,
          attacks: observation.attacks,
          health: observation.healthAfter,
          stage: observation.stage,
          preparedPosition: observation.preparedPosition ? { x: observation.preparedPosition.x, y: observation.preparedPosition.y, z: observation.preparedPosition.z } : null,
          blockedBy: observation.blockedBy,
        },
        completion: {
          kind: "event",
          observed: (observation.ended && observation.handoffComplete) || observation.died,
          owes: "Observed takeoff and clear supported withdrawal after this perch, or observed dragon death.",
        },
      }));
      return async ({ signal = lifetime }) => {
        try {
          return endCombatActionResult(
            await combat.runEnd({ kind: "perch", targetId: request.entity_id, observation }, signal),
          );
        } catch (cause) {
          if (!signal.aborted) throw cause;
          return interruptedEndCombatResult(
            {
              outcome: observation.died ? "dragon_died" : observation.ended ? "perch_ended" : "stopped",
              attacks: observation.attacks,
              healthBefore: observation.healthBefore,
              healthAfter: observation.healthAfter,
              perch: {
                preparedPosition: observation.preparedPosition,
                stage: observation.stage,
                blockedBy: observation.blockedBy,
                timing: observation.timing,
              },
              reason: "The requested perch was interrupted; its observed effects are retained.",
            },
            signal.reason,
          );
        }
      };
    },
  });
}
