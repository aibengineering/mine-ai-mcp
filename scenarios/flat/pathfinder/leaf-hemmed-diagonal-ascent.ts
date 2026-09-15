import type { ClientCompletion } from "mine-labs/client";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as runPathfinderScenario } from "./pathfinder-runner.ts";

const UNSAFE_EDGE = "-1,-59,0>0,-58,-1:step_up:";

/**
 * Require the route to use the available cardinal staircase instead of the
 * leaf-hemmed diagonal ascent which failed repeatedly in the live canopy.
 */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  let attempts = 0;
  let failures = 0;
  const completion = await runPathfinderScenario(context, {
    onCandidateEvent(event) {
      if (!("stepId" in event) || !event.stepId.startsWith(UNSAFE_EDGE)) return;
      if (event.kind === "step_started") attempts += 1;
      if (event.kind === "step_failed") failures += 1;
    },
  });

  const edgeEvidence = `leaf-hemmed diagonal attempted ${attempts} time(s), failed ${failures} time(s)`;
  if (completion.status !== "succeeded") {
    return { status: "failed", detail: `${edgeEvidence}; ${completion.detail}` };
  }
  if (attempts > 0) {
    return {
      status: "failed",
      detail: `Navigation used the unsafe leaf-hemmed diagonal ascent; ${edgeEvidence}; ${completion.detail}`,
    };
  }
  return { status: "succeeded", detail: `Used the cardinal route; ${edgeEvidence}; ${completion.detail}` };
}
