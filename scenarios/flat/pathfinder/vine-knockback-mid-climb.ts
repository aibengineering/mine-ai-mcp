import type { ClientCompletion } from "mine-labs/client";
import type { PlannedStep } from "../../../src/navigation/movements/movement.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as runPathfinder } from "./pathfinder-runner.ts";

/** Apply a real client velocity packet while the normal production climb owns the body. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  let climbing = false;
  let injected = false;
  let failedMovements = 0;
  let completedClimb = false;
  let activeStep: PlannedStep | null = null;
  let exitStep: PlannedStep | null = null;
  let traceTicks = 0;
  const steps = new Map<string, PlannedStep>();
  const recordExit = (event: string) => {
    const step = exitStep ?? activeStep;
    if (!step || traceTicks >= 120) return;
    const position = context.bot.entity.position.clone();
    const feet = position.floored();
    const offsets = [[0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]] as const;
    const supports = offsets.map(([dx, dy, dz]) => {
      const supportPosition = feet.offset(dx, dy, dz);
      const block = context.bot.blockAt(supportPosition);
      return block
        ? { position: supportPosition, name: block.name, stateId: block.stateId, collisionShapes: block.shapes }
        : null;
    });
    const feetBlock = context.bot.blockAt(feet);
    context.log(`vine_exit ${JSON.stringify({
      atMs: Date.now(), event,
      step: { id: step.id, kind: step.kind, from: step.from, to: step.to },
      body: {
        position: { x: position.x, y: position.y, z: position.z },
        velocity: context.bot.entity.velocity,
        onGround: context.bot.entity.onGround,
        yaw: context.bot.entity.yaw,
        controls: Object.fromEntries(
          (["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const)
            .map((control) => [control, context.bot.getControlState(control)]),
        ),
        feetBlock: feetBlock
          ? { position: feet, name: feetBlock.name, stateId: feetBlock.stateId, collisionShapes: feetBlock.shapes }
          : null,
        supports,
      },
    })}`);
    traceTicks += 1;
  };
  const tick = () => {
    if (!injected && climbing && context.bot.entity.position.y > -56) {
      injected = true;
      context.bot._client.emit("entity_velocity", {
        entityId: context.bot.entity.id,
        velocity: { x: -2621, y: 0, z: 0 },
      });
    }
    if (exitStep || (climbing && context.bot.entity.position.y > -55)) recordExit("physics_tick");
  };
  context.bot.on("physicsTick", tick);
  try {
    const result = await runPathfinder(context, {
      onCandidateEvent(event) {
        if (event.kind === "route_committed") for (const step of event.plan.steps) steps.set(step.id, step);
        if (event.kind === "step_started") {
          activeStep = steps.get(event.stepId) ?? null;
          if (completedClimb && event.movement !== "climb" && !exitStep) {
            exitStep = activeStep;
            recordExit(event.kind);
          }
          if (event.movement === "climb") climbing = true;
        }
        if (event.kind === "step_completed" && event.movement === "climb") {
          climbing = false;
          completedClimb = true;
        }
        if (event.kind === "step_failed") failedMovements += 1;
      },
    });
    if (!injected) return { status: "failed", detail: `Impulse was not injected; ${result.detail}` };
    return failedMovements === 0
      ? result
      : { status: "failed", detail: `${failedMovements} movement step(s) failed after the impulse; ${result.detail}` };
  } finally {
    context.bot.off("physicsTick", tick);
  }
}
