import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as navigate } from "./pathfinder-runner.ts";

/** Report actuator diagnostics alongside the independent route outcome. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const failures: string[] = [];
  let swims = 0;
  const completion = await navigate(context, {
    onCandidateEvent(event) {
      if (event.kind === "step_failed") failures.push(`${event.stepId}: ${event.observation}`);
      if (event.kind === "step_completed" && event.movement === "swim") swims += 1;
    },
  });
  return {
    ...completion,
    detail: `Completed swims: ${swims}; movement failures: ${failures.join("; ")}; ${completion.detail}`,
  };
}
