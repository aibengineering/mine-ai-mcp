import {
  createMovements,
  createNavigateAction,
  ActionRunner,
} from "@aibengineering/mine-ai-mcp";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, navigation, signal, pathfinder, log }) => {
  let lastMovement: string | null = null;
  let handoffObserved = false;
  const stop = pathfinder.onEvent((event) => {
    if (event.kind === "step_started" || event.kind === "step_failed") log(JSON.stringify(event));
    if (event.kind === "step_started") {
      if (lastMovement === "parkour" && event.movement === "pillar") handoffObserved = true;
      lastMovement = event.movement;
    }
  });
  try {
    const output = await new ActionRunner().run(
      createNavigateAction(bot, navigation, {
        createMovements: (movementBot) => ({
          ...createMovements(movementBot),
          // This fixture qualifies the observed handoff, not a staircase built
          // across the gap that avoids arriving with jump momentum entirely.
          allowDigging: false,
          decidePlace: (x, y, z) =>
            x === 0 && y === -59 && z === 2
              ? { kind: "allowed" }
              : { kind: "prohibited", reason: "Only the fixture pillar may be placed." },
        }),
        navigate: navigation.navigate,
      }),
      { x: 0, y: -58, z: 2, range: 0, build: true },
      signal,
    );
    return {
      status: output.result.status === "succeeded" && handoffObserved ? "succeeded" : "failed",
      detail: `${JSON.stringify(output)}; parkour-to-pillar handoff observed: ${handoffObserved}`,
    };
  } finally {
    stop();
  }
};
