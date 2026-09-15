import { crystalCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import type { CombatController } from "../../survival/control/combat/contract.js";
import { CrystalObservation } from "../../survival/perception/combat/crystal.js";

import { defineAction } from "../action.js";
import {
  endCombatActionResult,
  endCombatActionResultSchema,
  formatEndCombatResult,
  interruptedEndCombatResult,
} from "../end-combat-result.js";
import {
  DESTROY_END_CRYSTAL,
  DESTROY_END_CRYSTAL_DESCRIPTION,
  destroyEndCrystalInputSchema,
} from "./contract.js";
export * from "./contract.js";
export function createDestroyEndCrystalAction(bot: Bot, combat: CombatController) {
  return defineAction({
    checkpointSchema: crystalCheckpointSchema,
    name: DESTROY_END_CRYSTAL,
    description: DESTROY_END_CRYSTAL_DESCRIPTION,
    inputSchema: destroyEndCrystalInputSchema,
    resultSchema: endCombatActionResultSchema,
    formatResult: formatEndCombatResult,
    execution: { kind: "resumable_task" },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: true },
    parse: (input) => destroyEndCrystalInputSchema.parse(input),
    begin: (request, lifetime, observe) => {
      const observation = new CrystalObservation(bot, request.entity_id, request.weapon, request.approach);
      observe(() => ({
        baseline: { targetId: observation.targetId, dimension: observation.dimension },
        checkpoint: {
          phase: observation.phase,
          weapon: observation.weapon,
          approach: observation.approach,
          usedWeapon: observation.usedWeapon,
          attacks: observation.attacks,
          shot: observation.shot ? { ...observation.shot } : null,
          destroyed: observation.destroyed,
          melee: observation.meleeEvidence(),
        },
        completion: {
          kind: "event",
          observed: observation.destroyed,
          owes: "Observed destruction of the selected crystal, or a returned-to loaded native site verified empty after fresh server updates.",
        },
      }));
      lifetime.addEventListener("abort", () => observation[Symbol.dispose](), { once: true });
      return async ({ signal = lifetime }) => {
        try {
          return endCombatActionResult(
            await combat.runEnd({ kind: "crystal", targetId: request.entity_id, observation }, signal),
          );
        } catch (cause) {
          if (!signal.aborted) throw cause;
          return interruptedEndCombatResult(
            {
              outcome: observation.destroyed ? "crystal_destroyed" : "stopped",
              attacks: observation.attacks,
              healthBefore: null,
              healthAfter: null,
              reason: "Crystal observation was interrupted; released-shot evidence is retained.",
              crystal: {
                weapon: observation.weapon,
                approach: observation.approach,
                usedWeapon: observation.usedWeapon,
                phase: observation.phase,
                melee: observation.meleeEvidence(),
              },
            },
            signal.reason,
          );
        } finally {
          observation.pauseMeleeMeasurement();
        }
      };
    },
  });
}
