import type { Bot } from "mineflayer";
import type { CombatController } from "../../survival/control/combat/contract.js";
import { PerchObservation } from "../../survival/perception/combat/perch.js";
import { defineAction } from "../action.js";
import {
  endCombatActionResult,
  endCombatActionResultSchema,
  formatEndCombatResult,
  interruptedEndCombatResult,
} from "../end-combat-result.js";
import {
  PREPARE_DRAGON_PERCH,
  PREPARE_DRAGON_PERCH_DESCRIPTION,
  prepareDragonPerchCheckpointSchema,
  prepareDragonPerchInputSchema,
} from "./contract.js";

export * from "./contract.js";

export function createPrepareDragonPerchAction(
  bot: Bot,
  combat: CombatController,
) {
  return defineAction({
    checkpointSchema: prepareDragonPerchCheckpointSchema,
    name: PREPARE_DRAGON_PERCH,
    description: PREPARE_DRAGON_PERCH_DESCRIPTION,
    inputSchema: prepareDragonPerchInputSchema,
    resultSchema: endCombatActionResultSchema,
    formatResult: formatEndCombatResult,
    execution: { kind: "resumable_task" },
    annotations: {
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    },
    parse: (input) => prepareDragonPerchInputSchema.parse(input),
    begin: (request, lifetime, observe) => {
      const observation = new PerchObservation(bot, request.entity_id);
      lifetime.addEventListener("abort", () => observation[Symbol.dispose](), {
        once: true,
      });
      observe(() => ({
        baseline: {
          targetId: request.entity_id,
          dimension: observation.dimension,
          health: observation.healthBefore,
        },
        checkpoint: {
          preparedPosition: observation.preparedPosition
            ? {
                x: observation.preparedPosition.x,
                y: observation.preparedPosition.y,
                z: observation.preparedPosition.z,
              }
            : null,
          stage: observation.stage,
          blockedBy: observation.blockedBy,
        },
        completion: {
          kind: "event",
          observed:
            (observation.stage === "ready" && observation.preparedPosition !== null) ||
            observation.landingObserved,
          owes: "Observed low staging readiness or the dragon's landing approach; preparation never claims an attack.",
        },
      }));
      return async ({ signal = lifetime }) => {
        try {
          return endCombatActionResult(
            await combat.runEnd(
              {
                kind: "prepare_perch",
                targetId: request.entity_id,
                observation,
              },
              signal,
            ),
          );
        } catch (cause) {
          if (!signal.aborted) throw cause;
          return interruptedEndCombatResult(
            {
              outcome: "stopped",
              attacks: observation.attacks,
              healthBefore: observation.healthBefore,
              healthAfter: observation.healthAfter,
              perch: {
                preparedPosition: observation.preparedPosition,
                stage: observation.stage,
                blockedBy: observation.blockedBy,
                timing: observation.timing,
              },
              reason: `Perch preparation was interrupted during ${observation.stage}${observation.preparedPosition ? ` after preparing ${observation.preparedPosition}` : ""}${observation.blockedBy ? `; blocked by ${observation.blockedBy}` : ""}. Historical preparation is retained without claiming current readiness. No attack was requested.`,
            },
            signal.reason,
          );
        }
      };
    },
  });
}
