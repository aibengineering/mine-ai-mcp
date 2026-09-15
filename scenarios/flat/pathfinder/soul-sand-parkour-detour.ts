import type { ClientCompletion } from "mine-labs/client";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as runPathfinderScenario } from "./pathfinder-runner.ts";

// Navigation represents the supported feet node above the fractional floor.
const TAKEOFF_PREFIX = "0,-60,0>";
const GAP_KINDS = [":jump:", ":sprint_jump:", ":parkour:"] as const;

/** Require the supported detour instead of an impossible full jump from soul sand. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const unsafeAttempts: string[] = [];
  const completion = await runPathfinderScenario(context, {
    onCandidateEvent(event) {
      if (event.kind !== "step_started" || !("stepId" in event)) return;
      if (event.stepId.startsWith(TAKEOFF_PREFIX) && GAP_KINDS.some((kind) => event.stepId.includes(kind))) {
        unsafeAttempts.push(event.stepId);
      }
    },
  });

  const evidence = `soul-sand gap attempts ${unsafeAttempts.length}`;
  if (completion.status !== "succeeded") {
    return { status: "failed", detail: `${evidence}; ${completion.detail}` };
  }
  if (unsafeAttempts.length > 0) {
    return {
      status: "failed",
      detail: `Pathfinder attempted a full gap movement from soul sand: ${unsafeAttempts.join(", ")}; ${completion.detail}`,
    };
  }
  return { status: "succeeded", detail: `Used the supported detour; ${evidence}; ${completion.detail}` };
}
