import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as runPathfinder } from "./pathfinder-runner.ts";

/**
 * Arriving is not enough here: a body that slides to the column's foot reaches
 * the goal anyway, unhurt, having abandoned the step that was carrying it.
 * Reject any failed step so the handoff itself is what passes or fails.
 */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const failures: string[] = [];
  const result = await runPathfinder(context, {
    onCandidateEvent(event) {
      if (event.kind === "step_failed") failures.push(`${event.movement} ${event.stepId}`);
    },
  });
  return failures.length === 0
    ? result
    : { status: "failed", detail: `${failures.length} step(s) failed before arrival: ${failures.join("; ")}; ${result.detail}` };
}
