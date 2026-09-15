import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as runPathfinderScenario } from "./pathfinder-runner.ts";

/** The route must reject the recorded head collision before taking off. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const unsafeAttempts: string[] = [];
  const completion = await runPathfinderScenario(context, {
    onCandidateEvent(event) {
      if (event.kind !== "step_started" || !("stepId" in event)) return;
      if (event.stepId.startsWith("0,-54,0>4,-54,0:parkour:")) unsafeAttempts.push(event.stepId);
    },
  });
  if (unsafeAttempts.length > 0) {
    return {
      status: "failed",
      detail: `Attempted the obstructed jump: ${unsafeAttempts.join(", ")}; ${completion.detail}`,
    };
  }
  return completion;
}
