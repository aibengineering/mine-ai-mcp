/**
 * Route execution: make one immutable plan physically true, or report what
 * stopped it.
 *
 * A plan is steps; a step is operations, always the world effects first
 * (break, place, activate) and the move last. Each effect is registered with
 * the mutation ledger, started through the bot, and waited on until the
 * world confirms it, the effect fails, its expectation conflicts or expires,
 * or the run cancels or invalidates the route. Each move is handed to a
 * movement controller and then driven from the physics tick: every tick the
 * controller is given a fresh snapshot and answers with the controls to hold,
 * until it reports arrival or failure.
 *
 * The executor is a small state machine — starting a step, awaiting an
 * effect, moving, settled — and one physics-tick subscription, which is also
 * the ledger's clock. Between movement steps the bot keeps its momentum
 * ("continuous"); before an interaction or at the end of the plan it stops
 * ("settled"). After every step the run is asked whether the goal is still the
 * same, so a revised goal ends the route early rather than walking it out.
 */
import type { NavigationBot } from "../bot.js";
import {
  type PlannedOperation,
  type PlannedStep,
  type RoutePlan,
  airMatcher,
  stateMatcher,
} from "../movements/movement.js";
import type { MovementFailure, MovementPhase } from "../orchestration/outcome.js";
import { canReleaseOnObservedGround, safeSupportingCell } from "../world/block-geometry.js";
import { type BlockPosition, type WorldView, activationGroupAt, samePosition } from "../world/world.js";
import type { MovementController, MovementExecution, MovementSnapshot } from "./movement-controller.js";
import { type AttemptToken, ExpectedMutationLedger, type MutationResult } from "./mutations.js";
import { executeWorldEffect } from "./world-effect.js";
import type { OpenedPassages } from "./opened-passages.js";
import { SupportedPositionController } from "./supported-position-controller.js";

export type StepDecision = "continue" | "goal_satisfied" | "goal_revised";

export type RouteExecutionResult =
  | {
      readonly kind: "exhausted";
      readonly arrival: BlockPosition;
      readonly reason: "segment_continuation" | "alternate_arrival";
    }
  | { readonly kind: "goal_satisfied"; readonly arrival: BlockPosition }
  | { readonly kind: "goal_revised" }
  | { readonly kind: "invalidated" }
  | { readonly kind: "failed"; readonly step: PlannedStep; readonly failure: MovementFailure }
  | { readonly kind: "cancelled" };

/**
 * What is true for the whole of one committed route: the run it belongs to
 * and the ports it acts through. Facts only; the callbacks stay arguments.
 */
export interface RouteContext {
  readonly runId: string;
  readonly world: WorldView;
  readonly bot: NavigationBot;
  /** Shared across runs, so an acknowledgement arriving after a run settles still finds its receipt. */
  readonly ledger: ExpectedMutationLedger;
  /** Aborting it stops the run; the reason becomes the stopped outcome's reason. */
  readonly signal: AbortSignal;
}

export interface RouteExecutionRequest {
  readonly context: RouteContext;
  readonly passages: OpenedPassages;
  readonly plan: RoutePlan;
  readonly stepStarted: (step: PlannedStep) => void;
  readonly phase: (step: PlannedStep, phase: MovementPhase) => void;
  readonly effectConfirmed: (operation: Exclude<PlannedOperation, { kind: "move" }>) => void;
  readonly stepCompleted: (step: PlannedStep, arrival: BlockPosition) => StepDecision;
}

type MovementResult =
  | { readonly kind: "completed"; readonly arrival: BlockPosition }
  | { readonly kind: "failed"; readonly observation: string }
  | { readonly kind: "invalidated" }
  | { readonly kind: "cancelled" };

type StepResult =
  | { readonly kind: "completed"; readonly arrival: BlockPosition }
  | { readonly kind: "failed"; readonly failure: MovementFailure }
  | { readonly kind: "invalidated" }
  | { readonly kind: "cancelled" };

type RouteExecutionState =
  | { readonly kind: "starting_step"; readonly stepIndex: number }
  | {
      readonly kind: "awaiting_effect";
      readonly stepIndex: number;
      readonly operationIndex: number;
      readonly token: AttemptToken;
    }
  | {
      readonly kind: "moving";
      readonly stepIndex: number;
      readonly token: AttemptToken;
      readonly controller: MovementController;
      readonly execution: MovementExecution;
      readonly settle: (result: MovementResult) => void;
      airborneObserved: boolean;
    }
  | { readonly kind: "settled" };

function canHandoffToInteraction(step: PlannedStep, next: PlannedStep | undefined): boolean {
  return Boolean(
    next &&
    (step.kind === "walk" || step.kind === "sprint") &&
    step.validArrivals.length === 1 &&
    samePosition(step.validArrivals[0]!, step.to) &&
    samePosition(step.to, next.from) &&
    next.operations.some((operation) => operation.kind !== "move"),
  );
}

export class RouteExecutor {
  #state: RouteExecutionState = { kind: "starting_step", stepIndex: 0 };
  #invalidated = false;
  #latestMovementSnapshot: MovementSnapshot | null = null;
  readonly #invalidatedResult: Promise<{ readonly kind: "invalidated" }>;
  readonly #resolveInvalidated: () => void;

  constructor(readonly request: RouteExecutionRequest) {
    let resolveInvalidated!: () => void;
    this.#invalidatedResult = new Promise((resolve) => {
      resolveInvalidated = () => resolve({ kind: "invalidated" });
    });
    this.#resolveInvalidated = resolveInvalidated;
  }

  invalidate(): void {
    if (this.#invalidated) return;
    this.#invalidated = true;
    this.#resolveInvalidated();
    if (this.#state.kind === "moving") this.#settleMovement({ kind: "invalidated" });
  }

  async execute(): Promise<RouteExecutionResult> {
    using resources = new DisposableStack();
    resources.defer(this.request.context.bot.subscribePhysicsTick(() => this.#onPhysicsTick()));
    try {
      return await this.#executeSteps();
    } catch (cause) {
      if (this.request.context.signal.aborted) return { kind: "cancelled" };
      throw cause;
    } finally {
      this.#state = { kind: "settled" };
      this.request.context.bot.clearOwnedControls();
    }
  }

  async #executeSteps(): Promise<RouteExecutionResult> {
    let arrival = this.request.plan.start;
    for (let stepIndex = 0; stepIndex < this.request.plan.steps.length; stepIndex += 1) {
      if (this.request.context.signal.aborted) return { kind: "cancelled" };
      if (this.#invalidated) return { kind: "invalidated" };
      const step = this.request.plan.steps[stepIndex]!;
      if (this.request.passages.hasOpened) {
        const restoration = await this.#restorePassages(stepIndex, step, stepIndex);
        if (restoration) return restoration;
      }
      this.#state = { kind: "starting_step", stepIndex };
      this.request.stepStarted(step);
      const result = await this.#executeStep(stepIndex, step);
      if (result.kind === "cancelled" || result.kind === "invalidated") return result;
      if (result.kind === "failed") return { kind: "failed", step, failure: result.failure };
      arrival = result.arrival;
      if (this.request.passages.hasOpened) {
        const restoration = await this.#restorePassages(stepIndex, step, stepIndex + 1);
        if (restoration) return restoration;
      }
      const next = this.request.plan.steps[stepIndex + 1];
      // The movement stays continuous until its checkpoint. An interaction
      // handoff takes ownership there and receives a neutral control state.
      if (canHandoffToInteraction(step, next)) this.request.context.bot.clearOwnedControls();
      const decision = this.request.stepCompleted(step, arrival);
      if (decision === "goal_satisfied") return { kind: "goal_satisfied", arrival };
      if (decision === "goal_revised") return { kind: "goal_revised" };
      if (!samePosition(arrival, step.to)) {
        const skipped = this.request.plan.steps[stepIndex + 1];
        if (
          skipped &&
          samePosition(skipped.from, step.to) &&
          samePosition(skipped.to, arrival) &&
          skipped.operations.every((operation) => operation.kind === "move")
        ) {
          stepIndex += 1;
          continue;
        }
        return { kind: "exhausted", arrival, reason: skipped ? "alternate_arrival" : "segment_continuation" };
      }
    }
    return { kind: "exhausted", arrival, reason: "segment_continuation" };
  }

  async #executeStep(stepIndex: number, step: PlannedStep): Promise<StepResult> {
    for (const condition of step.preconditions) {
      if (
        !condition.expected.matches(
          this.request.context.world.blockAt(condition.position.x, condition.position.y, condition.position.z),
        )
      ) {
        this.request.context.bot.clearOwnedControls();
        return {
          kind: "failed",
          failure: {
            kind: "precondition_changed",
            stepId: step.id,
            phase: "aligning",
            observation:
              `${condition.expected.description} was not observed at ` +
              `${condition.position.x},${condition.position.y},${condition.position.z}.`,
          },
        };
      }
    }
    const token = { runId: this.request.context.runId, planId: this.request.plan.id, stepId: step.id, attempt: 1 };
    let mutationNeedsSettlement = false;
    let mutationControlsReleased = false;
    for (let operationIndex = 0; operationIndex < step.operations.length; operationIndex += 1) {
      if (this.request.context.signal.aborted) return { kind: "cancelled" };
      if (this.#invalidated) return { kind: "invalidated" };
      const operation = step.operations[operationIndex]!;
      if (operation.kind === "move") {
        if (
          mutationNeedsSettlement &&
          step.kind !== "downward" &&
          this.request.context.bot.observe().stance === "airborne"
        ) {
          const stabilization = await this.#stabilize(step);
          if (stabilization) return stabilization;
        }
        const movement = await this.#executeMovement(stepIndex, step, token);
        if (movement.kind === "completed" || movement.kind === "cancelled" || movement.kind === "invalidated") {
          return movement;
        }
        return {
          kind: "failed",
          failure: { kind: "no_progress", stepId: step.id, phase: "moving", observation: movement.observation },
        };
      }
      if (!mutationControlsReleased) {
        this.request.context.bot.clearOwnedControls();
        mutationControlsReleased = true;
        if (this.request.context.bot.observe().stance === "airborne") {
          const stabilization = await this.#stabilize(step);
          if (stabilization) return stabilization;
        }
      }
      const mutation = await this.#executeMutation(stepIndex, operationIndex, step, token, operation);
      if (mutation) return mutation;
      mutationNeedsSettlement = true;
    }
    throw new Error(`Step ${step.id} contained no movement operation.`);
  }

  async #restorePassages(
    stepIndex: number,
    step: PlannedStep,
    remainingIndex: number,
  ): Promise<RouteExecutionResult | null> {
    const { bot, signal } = this.request.context;
    // A replan can still need a door opened by the previous route. Closing it
    // here would invalidate this committed plan's observed-state preconditions.
    const requiredCells = this.request.plan.steps
      .slice(remainingIndex)
      .flatMap((remaining) => remaining.preconditions.map((condition) => condition.position));
    if (!signal.aborted && !this.#invalidated) {
      const cell = this.request.passages.clearanceCell(bot.observe(), requiredCells);
      if (cell) {
        this.request.phase(step, "aligning");
        await bot.centerOnCell(cell, signal);
      }
    }
    while (!this.request.context.signal.aborted && !this.#invalidated) {
      const passage = this.request.passages.nextToClose(this.request.context.bot.observe(), requiredCells);
      if (!passage) return null;
      this.request.context.bot.clearOwnedControls();
      const closing = this.request.passages.closingStep(passage, step);
      const operation = closing.operations[0];
      const token = { runId: this.request.context.runId, planId: this.request.plan.id, stepId: closing.id, attempt: 1 };
      const result = await this.#executeMutation(stepIndex, 0, closing, token, operation);
      if (result?.kind === "failed") return { kind: "failed", step: closing, failure: result.failure };
      if (result?.kind === "cancelled" || result?.kind === "invalidated") return result;
    }
    return this.request.context.signal.aborted ? { kind: "cancelled" } : { kind: "invalidated" };
  }

  async #stabilize(step: PlannedStep): Promise<StepResult | null> {
    this.request.phase(step, "aligning");
    const result = await this.request.context.bot.stabilize(this.request.context.signal);
    if (this.request.context.signal.aborted) return { kind: "cancelled" };
    if (this.#invalidated) return { kind: "invalidated" };
    return result.kind === "stable"
      ? null
      : {
          kind: "failed",
          failure: { kind: "unstable", stepId: step.id, phase: "aligning", observation: result.observation },
        };
  }

  async #executeMutation(
    stepIndex: number,
    operationIndex: number,
    step: PlannedStep,
    token: AttemptToken,
    operation: Exclude<PlannedOperation, { readonly kind: "move" }>,
  ): Promise<StepResult | null> {
    const phase = operation.kind === "break" ? "breaking" : operation.kind === "place" ? "placing" : "activating";
    this.request.phase(step, phase);
    // Stop moving before interacting. A completed `continuous` step keeps its
    // controls held on purpose so momentum carries into the next movement, but
    // an interaction is not a movement: still sprinting into the block being
    // mined makes Mineflayer reject the dig with "Digging aborted", the step
    // fails, and the route replans. Observed as 44 step starts for 15
    // completions on a tunnel of continuous sprints that each carried a break,
    // while the deep-vertical fixture was unaffected because its digs follow
    // `downward` and `drop` steps that end settled and release controls anyway.
    this.request.context.bot.clearOwnedControls();
    const position = operation.kind === "place" ? operation.placement.position : operation.position;
    const before =
      operation.kind === "break"
        ? stateMatcher(operation.expectedStateId)
        : operation.kind === "place"
          ? airMatcher
          : operation.before;
    const after =
      operation.kind === "break"
        ? airMatcher
        : operation.kind === "place"
          ? stateMatcher(operation.placement.stateId)
          : operation.after;
    const world = this.request.context.world;
    const activationGroup =
      operation.kind === "activate"
        ? activationGroupAt(world.blockAt(position.x, position.y, position.z), position)
        : null;
    const targets =
      operation.kind === "activate" && activationGroup
        ? step.effects.flatMap((effect) => {
            if (effect.kind !== "activate") return [];
            return activationGroupAt(
              world.blockAt(effect.position.x, effect.position.y, effect.position.z),
              effect.position,
            ) === activationGroup
              ? [{ position: effect.position, before: stateMatcher(effect.stateId), after }]
              : [];
          })
        : [
            {
              position,
              before,
              after,
              // A break that brings a falling column down owns the column's
              // cells until it is done; see `Expectation.owned`.
              ...(operation.kind === "break" &&
                operation.brings.length > 0 && { owned: [position, ...operation.brings] }),
            },
          ];
    // Each brought block takes a fall and a second swing beyond the dig time.
    const settling = operation.kind === "break" ? operation.brings.length * 3_000 : 0;
    const opened = operation.kind === "activate" ? this.request.passages.closedAt(position) : null;
    this.#state = { kind: "awaiting_effect", stepIndex, operationIndex, token };
    this.request.phase(step, "confirming");
    const { result, issued } = await executeWorldEffect({
      ...this.request.context,
      token,
      operation,
      targets,
      // Scale confirmation to the work, including the falling column.
      deadlineMs: Date.now() + Math.max(5_000, step.cost.expectedTicks * 50 * 2) + settling,
      invalidated: this.#invalidatedResult,
    });
    if (issued) this.request.passages.remember(opened);
    if (result.kind === "cancelled" || result.kind === "invalidated") return result;
    if (result.kind === "effect_failed") {
      return {
        kind: "failed",
        failure: { kind: "operation_failed", stepId: step.id, phase, observation: result.observation },
      };
    }
    if (result.kind === "conflicting" || result.kind === "expired") {
      return {
        kind: "failed",
        failure: {
          kind: "operation_failed",
          stepId: step.id,
          phase: "confirming",
          observation: this.#mutationFailure(result, before.description, after.description, position),
        },
      };
    }
    this.#state = { kind: "starting_step", stepIndex };
    this.request.effectConfirmed(operation);
    return null;
  }

  #mutationFailure(
    result: Exclude<MutationResult, { readonly kind: "confirmed" }>,
    before: string,
    after: string,
    position: BlockPosition,
  ): string {
    if (result.kind === "expired") return "Server confirmation deadline elapsed.";
    const observedBefore =
      result.change.before.kind === "loaded" ? `state ${result.change.before.stateId}` : "unloaded";
    const observedAfter = result.change.after.kind === "loaded" ? `state ${result.change.after.stateId}` : "unloaded";
    return (
      `Expected ${before} to become ${after} at ${position.x},${position.y},${position.z}; ` +
      `observed ${observedBefore} to ${observedAfter}.`
    );
  }

  async #executeMovement(stepIndex: number, step: PlannedStep, token: AttemptToken): Promise<MovementResult> {
    this.request.phase(step, "moving");
    const next = this.request.plan.steps[stepIndex + 1];
    // Every non-terminal checkpoint is a handoff, not a request to erase the
    // bot's physical state. The next movement receives the position, stance,
    // and velocity observed on this tick and immediately owns a complete input
    // intent. Interaction steps still clear controls at their boundary.
    const turnsAfterDrop =
      step.kind === "drop" &&
      next !== undefined &&
      (step.to.x - step.from.x) * (next.to.z - next.from.z) !== (step.to.z - step.from.z) * (next.to.x - next.from.x);
    // A midair turn retains the previous direction's momentum even after the
    // next controller faces its target. The obsidian shore drop crossed into
    // lava during that handoff. Land and brake before changing direction.
    const turnsInWater = step.kind === "swim" && next !== undefined &&
      (step.to.x - step.from.x !== next.to.x - next.from.x ||
       step.to.y - step.from.y !== next.to.y - next.from.y ||
       step.to.z - step.from.z !== next.to.z - next.from.z);
    const execution: MovementExecution = { end: next && !turnsAfterDrop && !turnsInWater ? "continuous" : "settled" };
    const preparation = await this.request.context.bot.prepareMovement(
      step,
      token,
      this.request.context.signal,
      execution,
      () => this.#movementSnapshot(),
    );
    if (this.request.context.signal.aborted) {
      this.request.context.bot.clearOwnedControls();
      return { kind: "cancelled" };
    }
    if (this.#invalidated) {
      this.request.context.bot.clearOwnedControls();
      return { kind: "invalidated" };
    }
    if (preparation.kind !== "ready") {
      // No new controller took ownership of the inputs inherited from the
      // preceding continuous step. Stop them before returning the handoff.
      this.request.context.bot.clearOwnedControls();
      return preparation;
    }
    return new Promise<MovementResult>((settle) => {
      this.#state = {
        kind: "moving",
        stepIndex,
        token,
        controller: preparation.controller,
        execution,
        settle,
        airborneObserved: !this.#movementSnapshot().onGround,
      };
      this.request.context.bot.applyMovementControls(preparation.controller.initialControls);
    });
  }

  #onPhysicsTick(): void {
    // A deadline needs a clock, not traffic. `expire` is otherwise only
    // reachable through `classify`, which requires a world change, so a lost
    // server acknowledgement over a quiet world left the run waiting in
    // `confirming` until something outside cancelled it. This tick is the
    // clock, and it has to run in every state — the wait we are guarding is
    // precisely the one where nothing is moving.
    this.request.context.ledger.expire(Date.now());
    const snapshot = this.request.context.bot.movementSnapshot();
    this.#latestMovementSnapshot = snapshot;
    if (this.#state.kind !== "moving") return;
    if (!snapshot.onGround) this.#state.airborneObserved = true;
    if (this.#invalidated) {
      this.#settleMovement({ kind: "invalidated" });
      return;
    }
    try {
      // Resolve cancellation against this tick's position and momentum, not
      // the previous phase seen by an earlier combat/contact listener.
      if (
        this.request.context.signal.aborted &&
        (canReleaseOnObservedGround(this.request.context.world, snapshot) ||
          this.#state.controller.cancel(snapshot) === "stopped")
      ) {
        this.#settleMovement({ kind: "cancelled" });
        return;
      }
      if (this.request.context.signal.aborted && snapshot.onGround && this.#state.airborneObserved) {
        const landing = safeSupportingCell(this.request.context.world, snapshot.position);
        if (landing) {
          // The coast check rejected release, but this landing is safe now.
          // Crouch toward its centre instead of driving the old step. At the
          // edge, crouching can clamp displacement while physics still holds
          // outward velocity: releasing there starts the fall again. Before
          // the first airborne tick, a committed takeoff belongs to its controller.
          if (!(this.#state.controller instanceof SupportedPositionController))
            this.#state = {
              ...this.#state,
              controller: new SupportedPositionController(this.request.context.world, snapshot),
            };
        }
      }
      const tick = this.#state.controller.advance(snapshot);
      if (tick.kind === "running") {
        if (tick.steeringTarget) this.request.context.bot.applyMovementSteering(tick.steeringTarget);
        this.request.context.bot.applyMovementControls(tick.controls);
        return;
      }
      if (tick.kind === "arrived") {
        this.#settleMovement({ kind: "completed", arrival: tick.arrival });
        return;
      }
      const step = this.request.plan.steps[this.#state.stepIndex]!;
      this.#settleMovement({ kind: "failed", observation: this.request.context.bot.describeMovementFailure(step) });
    } catch (cause) {
      this.#settleMovement({ kind: "failed", observation: cause instanceof Error ? cause.message : String(cause) });
    }
  }

  #movementSnapshot(): MovementSnapshot {
    if (this.#latestMovementSnapshot) return this.#latestMovementSnapshot;
    const snapshot = this.request.context.bot.movementSnapshot();
    this.#latestMovementSnapshot = snapshot;
    return snapshot;
  }

  #settleMovement(result: MovementResult): void {
    if (this.#state.kind !== "moving") return;
    if (this.request.context.signal.aborted) result = { kind: "cancelled" };
    const { stepIndex, execution, settle } = this.#state;
    this.#state = { kind: "starting_step", stepIndex };
    if (result.kind !== "completed" || execution.end === "settled") this.request.context.bot.clearOwnedControls();
    settle(result);
  }
}
