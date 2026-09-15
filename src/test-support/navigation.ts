/**
 * The fixtures the navigation tests share.
 *
 * A flat world, one observation, the engine-side bot double (the Mineflayer
 * double is `bot.ts`), and the helpers that run a single step through the real
 * executor. Anything only one concept needs lives with that concept's test.
 *
 * A test lives with the unit whose contract it exercises, not with the file
 * that was open when the bug was found: a test that constructs a
 * `MineflayerBot` belongs in `mineflayer/bot.test.ts`, one that constructs a
 * `RouteExecutor` in `execution/route-executor.test.ts`, one that calls
 * `createNavigator().startRun` in `orchestration/navigation-run.test.ts`.
 * The principles behind that rule are in `docs/mcp/testing.md`.
 */
import type { EffectHandle, MovementPreparation, NavigationBot } from "../navigation/bot.js";
import type {
  MovementControlIntent,
  MovementExecution,
  MovementSnapshot,
} from "../navigation/execution/movement-controller.js";
import type { AttemptToken } from "../navigation/execution/mutations.js";
import { MineflayerBot } from "../navigation/mineflayer/bot.js";
import type { PlanningState } from "../navigation/movements/catalogue.js";
import type { MovementKind, PlannedOperation, PlannedStep, RoutePlan } from "../navigation/movements/movement.js";
import type { NavigationRequest, Navigator } from "../navigation/orchestration/navigator.js";
import type { NavigationOutcome } from "../navigation/orchestration/outcome.js";
import { OverlayInterner, PlanningOverlay } from "../navigation/search/planning-overlay.js";
import type { NavigationEvent, TelemetrySink } from "../navigation/telemetry/index.js";
import { MemoryWorld } from "../navigation/world/memory-world.js";
import type { NavigationObservation, Position3 } from "../navigation/world/world.js";

export class FakeNavigationBot implements NavigationBot {
  current = observation();
  readonly ticks = new Set<() => void>();
  observe() {
    return this.current;
  }
  movementSnapshot() {
    return {
      position: this.current.position,
      velocity: STILL,
      onGround: this.current.stance === "supported",
      isInWater: this.current.stance === "swimming",
      climbing: this.current.stance === "climbing",
      yaw: 0,
    };
  }
  get ownedControlCount() {
    return 0;
  }
  clearOwnedControls() {}
  holdPosition() {
    return () => {};
  }
  applyMovementSteering(_target: Position3) {}
  applyMovementControls(_intent: MovementControlIntent) {}
  subscribePhysicsTick(listener: () => void) {
    this.ticks.add(listener);
    return () => this.ticks.delete(listener);
  }
  describeMovementFailure() {
    return "movement failed";
  }
  /** Every movement completes at once, at its planned cell. Subclasses override this to fail or overshoot. */
  async prepareMovement(
    step: PlannedStep,
    _token?: AttemptToken,
    _signal?: AbortSignal,
    _execution?: MovementExecution,
    _snapshot?: () => MovementSnapshot,
  ): Promise<MovementPreparation> {
    this.arrive(step.to);
    return { kind: "completed", arrival: step.to } as const;
  }
  /** Stand at `cell` and let one physics tick pass, as a movement that ran to completion would. */
  arrive(cell: Position3, observed: NavigationObservation = observation(cell.x, cell.y, cell.z)) {
    this.current = observed;
    for (const tick of this.ticks) tick();
  }
  startEffect(_operation: Exclude<PlannedOperation, { kind: "move" }>): EffectHandle {
    return {
      issued: false,
      completion: Promise.resolve({ kind: "failed", observation: "not supported" }),
      cancel: () => undefined,
    };
  }
  async stabilize() {
    return { kind: "stable" } as const;
  }
  async centerOnCell(cell: Position3) {
    this.current = { ...this.current, position: { x: cell.x + 0.5, y: this.current.position.y, z: cell.z + 0.5 } };
    return true;
  }
}

export const STILL = { x: 0, y: 0, z: 0 };

/** The yaw Mineflayer holds while facing along a horizontal heading. */
export function facing(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** A player with no reason to be slower: full food, no effects. */

export const WELL_FED = { food: 20, effects: {}, aquaAffinity: false };

export async function executeBotMovement(actuator: MineflayerBot, step: PlannedStep, execution: MovementExecution) {
  const signal = new AbortController().signal;
  const preparation = await actuator.prepareMovement(
    step,
    { runId: "run", planId: "plan", stepId: step.id, attempt: 1 },
    signal,
    execution,
    () => actuator.movementSnapshot(),
  );
  if (preparation.kind !== "ready") return preparation;
  actuator.applyMovementControls(preparation.controller.initialControls);
  try {
    for (;;) {
      await actuator.bot.waitForTicks(1);
      const tick = preparation.controller.advance(actuator.movementSnapshot());
      if (tick.kind === "arrived") return { kind: "completed", arrival: tick.arrival } as const;
      if (tick.kind === "failed")
        return { kind: "failed", observation: actuator.describeMovementFailure(step) } as const;
      if (tick.steeringTarget) actuator.applyMovementSteering(tick.steeringTarget);
      actuator.applyMovementControls(tick.controls);
    }
  } finally {
    actuator.clearOwnedControls();
  }
}

export function flatWorld(): MemoryWorld {
  const world = new MemoryWorld();
  for (let x = -5; x <= 5; x += 1)
    for (let z = -5; z <= 5; z += 1) {
      world.load({ x, y: 62, z }, { stateId: 1 });
      world.load({ x, y: 63, z }, { stateId: 0 });
      world.load({ x, y: 64, z }, { stateId: 0 });
      world.load({ x, y: 65, z }, { stateId: 0 });
    }
  return world;
}

export function gapStep(kind: "jump" | "sprint_jump" | "parkour", span: number, rise = 0): PlannedStep {
  return {
    id: `${kind}-${span}-${rise}`,
    kind,
    from: { x: 0, y: 63, z: 0 },
    to: { x: span, y: 63 + rise, z: 0 },
    validArrivals: [{ x: span, y: 63 + rise, z: 0 }],
    preconditions: [],
    operations: [{ kind: "move", movement: kind, target: { x: span + 0.5, y: 63 + rise, z: 0.5 } }],
    effects: [],
    cost: { expectedTicks: 20, breakPenalty: 0, placementPenalty: 0, hazardPenalty: 0, total: 20 },
  };
}

export function observation(x = 0, y = 63, z = 0): NavigationObservation {
  return {
    position: { x: x + 0.5, y, z: z + 0.5 },
    dimension: "overworld",
    stance: "supported",
    worldRevision: 1,
    resourceRevision: "1",
    inventory: new Map(),
    entities: new Map(),
    player: WELL_FED,
  };
}

export function stepUpStep(id: string, fromX: number, toX: number): PlannedStep {
  return {
    id,
    kind: "step_up",
    from: { x: fromX, y: 63, z: 0 },
    to: { x: toX, y: 64, z: 0 },
    validArrivals: [{ x: toX, y: 64, z: 0 }],
    preconditions: [],
    operations: [{ kind: "move", movement: "step_up", target: { x: toX + 0.5, y: 64, z: 0.5 } }],
    effects: [],
    cost: { expectedTicks: 8, breakPenalty: 0, placementPenalty: 0, hazardPenalty: 0, total: 8 },
  };
}

/** A complete route through the given steps, costed as their sum unless the test prices it. */
export function routePlan(steps: readonly PlannedStep[], options: { id?: string; totalCost?: number } = {}): RoutePlan {
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  return {
    id: options.id ?? "plan",
    goalRevision: "goal",
    start: first.from,
    end: last.to,
    endNode: { feet: last.to, remainingScaffolds: 0, overlayId: "overlay:0" },
    steps: [...steps],
    dependencies: new Set(),
    totalCost: options.totalCost ?? steps.reduce((sum, step) => sum + step.cost.total, 0),
    complete: true,
  };
}

/** Start one run and wait for it to settle. A busy navigator is a defect in the test, not an outcome. */
export async function settle(navigator: Navigator, request: NavigationRequest): Promise<NavigationOutcome> {
  const admission = navigator.startRun(request);
  if (admission.kind !== "started") throw new Error(`The navigator is busy with run ${admission.activeRunId}.`);
  return admission.handle.outcome;
}

/** A telemetry sink that hands every event to one handler. */
export function onEvent(handler: (event: NavigationEvent) => void): TelemetrySink {
  return { emit: handler, error: () => undefined };
}

/** A fresh planning state: the bot's feet, the scaffolds it carries, and an empty overlay. */
export function planningStart(feet: Position3, remainingScaffolds = 0): PlanningState {
  const overlay = new PlanningOverlay(new OverlayInterner());
  return { node: { feet, remainingScaffolds, overlayId: overlay.identity }, overlay };
}

/** One movement-only step of the given kind, aimed at the centre of `to` unless a target is named. */
export function movementStep(
  kind: MovementKind,
  from: Position3,
  to: Position3,
  options: { id?: string; validArrivals?: Position3[]; target?: Position3; expectedTicks?: number } = {},
): PlannedStep {
  const ticks = options.expectedTicks ?? 1;
  return {
    id: options.id ?? `${kind}-${to.x},${to.y},${to.z}`,
    kind,
    from,
    to,
    validArrivals: options.validArrivals ?? [to],
    preconditions: [],
    operations: [{ kind: "move", movement: kind, target: options.target ?? { x: to.x + 0.5, y: to.y, z: to.z + 0.5 } }],
    effects: [],
    cost: { expectedTicks: ticks, breakPenalty: 0, placementPenalty: 0, hazardPenalty: 0, total: ticks },
  };
}
