import type { ClientCompletion } from "mine-labs/client";
import { ActionRunner, createNavigateAction } from "@aibengineering/mine-ai-mcp";
import type { NavigationEvent } from "../../../src/navigation/telemetry/index.ts";
import type { PlannedStep } from "../../../src/navigation/movements/movement.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

/** Record the complete departure from a tall pillar onto its first short ledge. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  const steps = new Map<string, PlannedStep>();
  let active: PlannedStep | null = null;
  let completedPillar: Record<string, unknown> | null = null;
  let handoffTicks = 0;
  let handoffs = 0;
  let samples = 0;
  const sample = (event: string, step: PlannedStep) => {
    const position = bot.entity.position.clone();
    const feet = position.floored();
    const offsets = [[0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]] as const;
    const supports = offsets.map(([dx, dy, dz]) => {
      const supportPosition = feet.offset(dx, dy, dz);
      const support = bot.blockAt(supportPosition);
      return support ? { position: supportPosition, name: support.name } : null;
    });
    return {
      atMs: Date.now(), event,
      step: { id: step.id, kind: step.kind, from: step.from, to: step.to },
      body: {
        position: { x: position.x, y: position.y, z: position.z },
        velocity: { x: bot.entity.velocity.x, y: bot.entity.velocity.y, z: bot.entity.velocity.z },
        onGround: bot.entity.onGround,
        supports,
      },
    };
  };
  const emit = (record: Record<string, unknown>) => {
    if (samples >= 192) return;
    context.log(`pillar_handoff ${JSON.stringify(record)}`);
    samples += 1;
  };
  const observe = (event: NavigationEvent) => {
    if (event.kind === "route_committed") for (const step of event.plan.steps) steps.set(step.id, step);
    if (event.kind === "step_started") {
      active = steps.get(event.stepId) ?? null;
      if (completedPillar && active && active.kind !== "pillar" && handoffs < 4) {
        emit(completedPillar);
        emit(sample(event.kind, active));
        completedPillar = null;
        handoffTicks = 30;
        handoffs += 1;
      }
    }
    if (event.kind === "step_completed" && active?.kind === "pillar") completedPillar = sample(event.kind, active);
    if ((event.kind === "step_phase" || event.kind === "step_completed" || event.kind === "step_failed") &&
        handoffTicks > 0 && active?.kind !== "pillar" && active) emit(sample(event.kind, active));
  };
  const tick = () => {
    if (handoffTicks > 0 && active) {
      emit(sample("physics_tick", active));
      handoffTicks -= 1;
    }
  };
  const stop = context.pathfinder.onEvent(observe);
  bot.on("physicsTick", tick);
  try {
    const output = await new ActionRunner().run(
      createNavigateAction(bot, context.navigation),
      { x: 2, y: -51, z: 0, range: 0.5, build: true },
      context.signal,
    );
    const detail = `${JSON.stringify(output.result)}; handoffs ${handoffs}; handoff samples ${samples}; ${context.pathfinder.summary()}`;
    return output.result.status === "succeeded" && handoffs > 0
      ? { status: "succeeded", detail }
      : { status: "failed", detail };
  } finally {
    bot.off("physicsTick", tick);
    stop();
  }
}
