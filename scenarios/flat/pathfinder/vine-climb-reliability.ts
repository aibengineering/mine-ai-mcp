import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as runPathfinder } from "./pathfinder-runner.ts";

/** The destination alone can hide a fall followed by a lucky retry; reject either. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  let failedClimbs = 0;
  const result = await runPathfinder(context, {
    onCandidateEvent(event) {
      if (event.kind === "step_failed" && event.movement === "climb") failedClimbs += 1;
    },
  });
  return failedClimbs === 0
    ? result
    : { status: "failed", detail: `${failedClimbs} climb step(s) failed before arrival; ${result.detail}` };
}
