import type { ClientCompletion } from "mine-labs/client";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as runPathfinderScenario } from "./pathfinder-runner.ts";

const MINIMUM_CONTINUOUS_SPEED = 0.035;

/**
 * Prove that a sprint-to-step-up handoff keeps momentum without losing the
 * narrow landing on the turn which follows it.
 */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  let handoffSpeed: number | undefined;
  const completion = await runPathfinderScenario(context, {
    onCandidateEvent(event) {
      if (
        handoffSpeed === undefined &&
        event.kind === "step_started" &&
        event.stepId.startsWith("0,-59,0>1,-58,0:step_up:")
      ) {
        handoffSpeed = Math.hypot(context.bot.entity.velocity.x, context.bot.entity.velocity.z);
      }
    },
  });
  if (completion.status !== "succeeded") return completion;
  if (handoffSpeed === undefined) {
    return {
      status: "failed",
      detail: `The sprint-to-step-up handoff was not observed; ${completion.detail}`,
    };
  }
  const speedDetail = `step-up inherited ${handoffSpeed.toFixed(3)} blocks/tick`;
  if (handoffSpeed <= MINIMUM_CONTINUOUS_SPEED) {
    return {
      status: "failed",
      detail:
        `The bot settled before step-up (${speedDetail}, required > ${MINIMUM_CONTINUOUS_SPEED.toFixed(3)}); ` +
        completion.detail,
    };
  }
  return { status: "succeeded", detail: `${speedDetail}; ${completion.detail}` };
}
