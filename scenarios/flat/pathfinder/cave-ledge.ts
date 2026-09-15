import type { ClientCompletion } from "mine-labs/client";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as runPathfinderScenario } from "./pathfinder-runner.ts";

/** A lucky second jump must not hide the first jump hitting the diagonal ceiling. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  let crossing = false;
  let observed = false;
  const collisions: { x: number; y: number; z: number }[] = [];
  const sample = () => {
    const entity = context.bot.entity;
    // prismarine-physics supplies this observed flag; Entity's types omit it.
    const collidedVertically = Reflect.get(entity, "isCollidedVertically") === true;
    if (crossing && collidedVertically && !entity.onGround && entity.position.y < -52) {
      collisions.push({ ...entity.position });
    }
  };
  context.bot.on("physicsTick", sample);
  try {
    const result = await runPathfinderScenario(context, {
      onCandidateEvent(event) {
        if (event.kind === "step_started") {
          crossing = event.stepId.startsWith("6,-53,5>5,-52,6:step_up:");
          observed ||= crossing;
        }
        if (event.kind === "step_completed" || event.kind === "step_failed") crossing = false;
      },
    });
    return {
      status: result.status === "succeeded" && observed && collisions.length === 0 ? "succeeded" : "failed",
      detail: `diagonal observed=${observed}; premature head collisions=${JSON.stringify(collisions)}; ${result.detail}`,
    };
  } finally {
    context.bot.off("physicsTick", sample);
  }
}
