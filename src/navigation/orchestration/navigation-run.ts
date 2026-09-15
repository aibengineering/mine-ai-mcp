/**
 * One navigation run: the loop that turns a goal into a settled outcome.
 *
 *   observe -> resolve the goal -> plan -> execute -> observe again
 *
 * Each pass takes one fresh look at the bot and the world, resolves the goal
 * against it, gets a route (or reuses the one searched while walking the
 * last segment), walks it, and then decides from what the executor reports
 * whether to go round again, hand the arrival to the process, or settle.
 *
 * Three nouns carry the loop:
 * - An *observation* is one reading of the bot and the world: position,
 *   stance, scaffold count, entities, and the world and resource revisions.
 *   It comes from the bot port, `NavigationBot`, the one place the engine looks.
 * - A *resolved goal* is the request's goal frozen against one observation.
 *   A goal is a question that can move (an entity goal follows its entity),
 *   so it is never judged directly; `Goal.resolve(observation)` yields a
 *   revision, a heuristic, and a satisfaction test that hold for that
 *   observation only.
 * - A *node* is where the bot stands in planning terms: feet, scaffold count,
 *   and the identity of the overlay of predicted edits, empty for the live
 *   world. Goals and plans are judged against nodes, never raw positions.
 *
 * Three kinds of value flow through the loop:
 * - `PlanningResult`: a plan to walk, a reason to search again, or a final
 *   outcome. `ExecutionResult` is the same without the plan.
 * - Identities. A search is identified by goal revision, feet, world and
 *   resource revisions, and the movement-failure count; a movement failure by
 *   the step and the cell it failed from. Meeting the same identity twice is
 *   how the run knows it is going in circles and reports `no_progress`
 *   instead of trying forever.
 * - Counters, which become the `NavigationEvidence` every outcome carries.
 *
 * The run owns the world subscription. Every change is classified by the
 * mutation ledger against the dependencies of the route being walked, and an
 * invalidating change stops the executor so the next pass replans. The run
 * also owns cleanup: a scoped resource stack releases controls, the world
 * listener, and the continuation search before `execute` measures what was
 * left behind rather than asserting zero.
 */
import type { MutationClassification } from "../execution/mutations.js";
import { executeWorldEffect } from "../execution/world-effect.js";
import { OpenedPassages } from "../execution/opened-passages.js";
import { RouteExecutor, type RouteContext, type StepDecision } from "../execution/route-executor.js";
import type { PlanningNode, ResolvedGoal } from "../goals/goal.js";
import { priceExcavation } from "../movements/excavation.js";
import type { MovementCatalogue } from "../movements/catalogue.js";
import {
  airMatcher,
  type MovementKind,
  type PlannedStep,
  type PredictedWorldEffect,
  type RoutePlan,
  stateMatcher,
} from "../movements/movement.js";
import type { MovementPolicy, ScaffoldSelection } from "../movements/policy.js";
import { EMPTY_OVERLAY_IDENTITY, OverlayInterner, PlanningOverlay } from "../search/planning-overlay.js";
import { IncrementalSearch } from "../search/search.js";
import type { StepField, StepFieldProvider } from "../step-field.js";
import { forRun, type RunTelemetry, type TelemetrySink } from "../telemetry/index.js";
import { navigationFeet } from "../world/block-geometry.js";
import { overheadPinningCell } from "../world/overhead-pin.js";
import { isSurfaceBobbing } from "./surface-bobbing.js";
import { PlanningStall } from "./planning-stall.js";
import {
  blockKey,
  blockLabel,
  blockPosition,
  samePosition,
  type BlockPosition,
  type NavigationObservation,
  type WorldChange,
} from "../world/world.js";
import type { NavigationRequest } from "./navigator.js";
import type {
  MovementFailure,
  MovementPhase,
  NavigationEvidence,
  NavigationFailure,
  NavigationOutcome,
  NavigationStatus,
  SearchReason,
} from "./outcome.js";
import type { NavigationCalculationFailure } from "./process-events.js";

/** The evidence fields the run counts as it goes: mutable here, copied into every outcome. */
interface Counters {
  searches: number;
  searchSlices: number;
  plans: number;
  continuations: number;
  replans: number;
  movementAttempts: Partial<Record<MovementKind, number>>;
  breaks: number;
  placements: number;
  activations: number;
  expectedMutations: number;
  conflictingMutations: number;
  invalidatingChanges: number;
  irrelevantChanges: number;
}

/** Which counter each world-change classification lands in. */
const CHANGE_COUNTER = {
  expected: "expectedMutations",
  conflicting: "conflictingMutations",
  invalidating: "invalidatingChanges",
  irrelevant: "irrelevantChanges",
} as const satisfies Record<MutationClassification, keyof Counters>;

type ActiveGoal = Extract<ResolvedGoal, { kind: "active" }>;
type PlanningResult =
  | {
      readonly kind: "plan";
      /** The immutable goal this plan actually answers. */
      readonly plannedGoal: ActiveGoal;
      /** The newest goal observed when the plan was ready, used by plan-ahead. */
      readonly latestGoal: ActiveGoal;
      readonly plan: RoutePlan;
    }
  | { readonly kind: "retry"; readonly reason: SearchReason }
  | { readonly kind: "outcome"; readonly outcome: NavigationOutcome };
/**
 * A search run while the current route is walked. It starts where that route
 * ends, in the world the route leaves behind: the segment's own digs and
 * placements are applied before the search reads a cell, or a segment that
 * ends inside rock it is about to dig would be searched from inside that rock
 * and find nothing, leaving the next segment to be searched standing still.
 */
interface PlanAhead {
  readonly effects: readonly PredictedWorldEffect[];
}
/**
 * How many executed routes may begin, one after another, from a cell no nearer
 * the goal than an earlier one before the run reports no progress.
 *
 * A committed segment always ends nearer the goal than it began, so a run whose
 * routes keep starting no nearer is being moved back between them: water flow,
 * knockback, a slope. Three in a row is the same evidence Baritone's stuck
 * detection reads, and it ends a loop that otherwise swam the same two cells
 * beside an unreachable drop until the caller's deadline.
 */
const STALLED_ROUTES = 3;
/** The plan-ahead search: started from the end of a partial segment while that segment is walked. */
interface PendingContinuation {
  readonly from: PlanningNode;
  /** The block the continuation places; `from.remainingScaffolds` counts this one. */
  readonly scaffold: ScaffoldSelection | null;
  readonly result: Promise<PlanningResult>;
  /** Stop the search now; `result` then settles within one slice. */
  readonly abandon: () => void;
}
/** What walking a plan reports: the same as planning, minus a plan. */
type ExecutionResult = Exclude<PlanningResult, { readonly kind: "plan" }>;
/** What one search said when it stopped, before the run decides what that means. */
type SearchAnswer =
  | { readonly kind: "plan"; readonly plan: RoutePlan; readonly latestGoal: ActiveGoal }
  | {
      readonly kind: "calculation_failed";
      readonly failure: NavigationCalculationFailure;
      readonly observation: NavigationObservation;
    }
  | { readonly kind: "stale" }
  | { readonly kind: "start_changed" }
  | { readonly kind: "arrived"; readonly node: PlanningNode; readonly observation: NavigationObservation }
  | { readonly kind: "goal_invalid"; readonly failure: NavigationFailure }
  | { readonly kind: "planning_stalled"; readonly failure: NavigationFailure }
  | { readonly kind: "stopped" };

/**
 * What an abort reason says, in words.
 *
 * Callers abort with a string; `AbortSignal.timeout` aborts with a
 * `TimeoutError`; a bare `abort()` aborts with an `AbortError`.
 */
function describeAbort(reason: unknown): string {
  if (typeof reason === "string") return reason;
  if (reason instanceof Error) {
    if (reason.name === "TimeoutError") return "navigation timeout";
    if (reason.name === "AbortError") return "cancelled";
    return reason.message;
  }
  return "cancelled";
}

/** How long a break to free a held body may take: a hand on a leaf is instant, a hand on stone is not. */
const PIN_RELEASE_DEADLINE_MS = 15_000;
/** Ticks to wait for the world to show the ceiling gone once the break has completed. */
const PIN_RELEASE_TICKS = 40;
/** Releases one run will attempt before a ceiling that keeps coming back is reported instead. */
const PIN_RELEASE_LIMIT = 3;

/** Preserve both failures when a resource throws while unwinding another error. */
function describeError(cause: unknown): string {
  if (cause instanceof SuppressedError) {
    return `${describeError(cause.suppressed)}; cleanup failed: ${describeError(cause.error)}`;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * What is true for the whole of one run: the facts every layer below shares.
 *
 * Built once by the navigator and never changed. Facts only; the callbacks
 * between layers stay explicit arguments, because who talks to whom is what a
 * reader needs to see.
 */
export interface RunContext extends RouteContext {
  readonly catalogue: MovementCatalogue;
  readonly telemetry: TelemetrySink;
  /**
   * Where each search gets its step field, or null when this run wants none.
   *
   * Asked once per search rather than once per run: a run keeps two searches
   * alive while it walks - the segment being executed and the plan-ahead
   * search for the next one - and each is priced against the world it was
   * started in. Resolved by the navigator, so the run never learns who
   * supplies the field or whether the caller opted out.
   */
  readonly stepField: StepFieldProvider | null;
}

export interface NavigationRunDependencies {
  readonly context: RunContext;
  readonly request: NavigationRequest;
  /** Publish the run's live status, and null once it has settled. */
  readonly status: (status: NavigationStatus | null) => void;
  /** Called once, after the run has settled and cleaned up after itself. */
  readonly release: () => void;
}

export class NavigationRun {
  readonly context: RunContext;
  readonly request: NavigationRequest;
  readonly status: (status: NavigationStatus | null) => void;
  readonly release: () => void;
  readonly #events: RunTelemetry;
  readonly #startedAt = Date.now();
  readonly #start: NavigationObservation;
  readonly #passages: OpenedPassages;
  readonly #counters: Counters = {
    searches: 0,
    searchSlices: 0,
    plans: 0,
    continuations: 0,
    replans: 0,
    movementAttempts: {},
    breaks: 0,
    placements: 0,
    activations: 0,
    expectedMutations: 0,
    conflictingMutations: 0,
    invalidatingChanges: 0,
    irrelevantChanges: 0,
  };
  /** Whether the world subscription is still installed; the one thing execute itself can leak. */
  #subscribed = false;
  readonly #searchIdentities = new Set<string>();
  readonly #planningStall = new PlanningStall();
  readonly #movementFailures = new Set<string>();
  #pinReleases = 0;
  /** The movement failure being replanned around, until a new route commits. */
  #lastMovementFailure: MovementFailure | null = null;
  /** The nearest the goal has looked from any cell this run planned from, and how many executed routes since began no nearer. */
  #progress: { readonly revision: string; readonly best: number; stalls: number } | null = null;
  /** Whether a route was executed since progress was last judged. */
  #executed = false;
  readonly #visitedFeet = new Set<number>();
  /** What the committed route being walked depends on. */
  #routeDependencies: ReadonlySet<number> = new Set<number>();
  #routeExecutor: RouteExecutor | undefined;
  /** The search running alongside the route being walked, held so settlement can stop and drain it. */
  #pending: PendingContinuation | null = null;
  #goalRevision = "unresolved";
  /**
   * The request's policy with its scaffold choice frozen at the last
   * observation. The production policy chooses its scaffold from the live
   * inventory, and one search must plan with one block, so the choice is
   * taken here, where the scaffold count is read, and held for the search.
   */
  #policy: MovementPolicy;
  constructor(dependencies: NavigationRunDependencies) {
    this.context = dependencies.context;
    this.request = dependencies.request;
    this.#policy = Object.freeze({ ...dependencies.request.policy });
    this.status = dependencies.status;
    this.release = dependencies.release;
    this.#events = forRun(this.context.telemetry, this.context.runId);
    this.#start = this.context.bot.observe();
    this.#passages = new OpenedPassages(this.context.world, this.#start.dimension);
    this.#visitedFeet.add(blockKey(navigationFeet(this.#start.position, this.#start.stance === "supported")));
  }
  async execute(): Promise<NavigationOutcome> {
    const settled = await this.#navigateWithResources().catch((cause) => this.#internalError(cause));
    this.#events.emit({ kind: "cleanup_completed" });
    // The evidence was gathered when the outcome was decided. Its cleanup
    // record is only honest once cleanup has actually run, so it is measured
    // again here, where a non-zero count is a leak and not a snapshot.
    const pending = this.#passages.pending(this.context.bot.observe());
    const result =
      settled.kind === "completed" && pending.length > 0
        ? this.#failed({ kind: "restoration_incomplete", observation: "Arrived with an unrestored doorway." })
        : settled;
    const outcome: NavigationOutcome = {
      ...result,
      evidence: { ...result.evidence, unrestoredPassages: pending, cleanup: this.#cleanupEvidence() },
    };
    this.#events.emit({ kind: "run_settled", outcome: outcome.kind });
    return outcome;
  }
  /** Classify one live change against the route being walked. */
  #onWorldChange(change: WorldChange): void {
    // A speculative search may read thousands of blocks it never selects.
    // Only a committed route owns an execution dependency worth stopping.
    // Every selected step checks its concrete preconditions again before it
    // moves, so an old search result cannot execute stale world assumptions.
    const classification = this.context.ledger.classify(change, this.#routeDependencies, Date.now());
    this.#counters[CHANGE_COUNTER[classification]] += 1;
    this.#events.emit({ kind: "world_change", classification, change });
    // A conflicting change settles its own expectation in the ledger, and the
    // executor waiting on that expectation sees it there. Only an unrelated
    // change to a block the route depends on needs the executor told directly.
    if (classification === "invalidating") this.#routeExecutor?.invalidate();
  }
  #internalError(cause: unknown): NavigationOutcome {
    if (this.context.signal.aborted) return this.#stopped();
    this.#events.error(cause);
    return this.#failed({ kind: "internal_error", message: describeError(cause) });
  }
  /** The world ended or another owner will steer; release the route without waiting for its landing. */
  terminate(): void {
    this.#routeExecutor?.invalidate();
  }

  /** Own setup through settlement, including partial setup and failed cleanup. */
  async #navigateWithResources(): Promise<NavigationOutcome> {
    await using resources = new AsyncDisposableStack();
    // Disposed in reverse order: stop controls, detach the world, drain the
    // speculative search, then release admission. One failed release must not
    // skip the others, and admission must stay held while a search can still run.
    resources.defer(this.release);
    resources.defer(() => this.status(null));
    resources.defer(async () => {
      if (this.#pending) {
        this.#pending.abandon();
        await this.#pending.result.catch(() => undefined);
        this.#pending = null;
      }
    });
    this.#events.emit({ kind: "run_started" });
    const unsubscribe = this.context.world.subscribe((change) => this.#onWorldChange(change));
    this.#subscribed = true;
    resources.defer(() => {
      unsubscribe();
      this.#subscribed = false;
    });
    resources.defer(() => this.context.bot.clearOwnedControls());
    resources.defer(() =>
      this.status({
        kind: "stopping",
        runId: this.context.runId,
        reason: this.context.signal.aborted ? describeAbort(this.context.signal.reason) : "settling",
      }),
    );
    // Await inside the scope so disposal cannot race the navigation it owns.
    return await this.#navigate();
  }
  /** What the run still holds. Counted, not asserted: a record that reports zero by construction catches nothing. */
  #cleanupEvidence(): NavigationEvidence["cleanup"] {
    return {
      listeners: this.#subscribed ? 1 : 0,
      controls: this.context.bot.ownedControlCount,
      expectations: this.context.ledger.activeCount,
    };
  }
  /** Where the bot actually stands, with no predicted edits applied. */
  #observedNode(
    observation: NavigationObservation,
    feet = navigationFeet(observation.position, observation.stance === "supported"),
  ): PlanningNode {
    const scaffold = this.#policy.scaffold;
    return {
      feet,
      // The observation counts every stack; which of them are scaffold blocks
      // depends on the item this route's policy places.
      remainingScaffolds: scaffold ? (observation.inventory.get(scaffold.itemType) ?? 0) : 0,
      overlayId: EMPTY_OVERLAY_IDENTITY,
    };
  }
  /**
   * The goal, resolved against one observation.
   *
   * A `Goal` is a question that can move — an entity goal follows its entity —
   * so before anything is judged it is frozen against the observation in hand.
   * The result is either invalid, which ends the run, or the active goal with
   * its revision recorded and the node the bot occupies for judging it.
   */
  #resolveGoal(
    observation: NavigationObservation,
    feet?: BlockPosition,
  ):
    | { readonly kind: "invalid"; readonly failure: NavigationFailure }
    | { readonly kind: "active"; readonly goal: ActiveGoal; readonly node: PlanningNode } {
    const goal = this.request.goal.resolve(observation);
    if (goal.kind === "invalid") {
      return { kind: "invalid", failure: { kind: "invalid_goal", observation: goal.observation } };
    }
    this.#goalRevision = goal.revision;
    return { kind: "active", goal, node: this.#observedNode(observation, feet) };
  }
  /**
   * The plan for where the bot actually is, reusing one already computed if it
   * was started from here.
   *
   * A route that ended anywhere other than where the continuation assumed —
   * because a movement failed, the world moved, or the goal did — leaves that
   * work useless. It is stopped rather than waited for: a speculative search
   * runs under the larger plan-ahead budget, and standing still until it
   * finishes an answer nobody wants could cost seconds. Awaiting the stopped
   * search still matters, so that one search runs at a time.
   */
  async #planFromHere(
    goal: ActiveGoal,
    node: PlanningNode,
    observation: NavigationObservation,
    reason: SearchReason,
  ): Promise<PlanningResult> {
    const pending = this.#pending;
    if (pending) {
      const endedWhereAssumed =
        samePosition(pending.from.feet, node.feet) &&
        // At least as many: a stack picked up on the way does not invalidate a plan.
        node.remainingScaffolds >= pending.from.remainingScaffolds &&
        pending.scaffold?.itemType === this.#policy.scaffold?.itemType;
      if (!endedWhereAssumed) {
        this.#events.emit({
          kind: "continuation_abandoned",
          assumed: pending.from.feet,
          actual: node.feet,
          observation:
            `assumed ${pending.from.remainingScaffolds} of scaffold ${pending.scaffold?.itemType ?? "none"}, ` +
            `found ${node.remainingScaffolds} of ${this.#policy.scaffold?.itemType ?? "none"}`,
        });
        pending.abandon();
      }
      const planned = await pending.result;
      this.#pending = null;
      if (endedWhereAssumed) {
        const current = this.context.bot.observe();
        const actual = this.#observedNode(current);
        if (
          planned.kind === "plan" &&
          (current.stance === "airborne" ||
            !samePosition(pending.from.feet, actual.feet) ||
            actual.remainingScaffolds < pending.from.remainingScaffolds ||
            pending.scaffold?.itemType !== this.#policy.scaffold?.itemType)
        )
          return { kind: "retry", reason: "start_changed" };
        return planned;
      }
    }
    return this.#plan(goal, node, observation, reason);
  }
  /** Start the plan-ahead search from where a partial segment will end, stoppable on its own. */
  #startContinuation(goal: ActiveGoal, plan: RoutePlan, observation: NavigationObservation): PendingContinuation {
    const control = new AbortController();
    return {
      from: plan.endNode,
      scaffold: this.#policy.scaffold,
      result: this.#plan(
        goal,
        plan.endNode,
        observation,
        "segment_continuation",
        AbortSignal.any([this.context.signal, control.signal]),
        { effects: plan.steps.flatMap((step) => step.effects) },
      ),
      abandon: () => control.abort("continuation abandoned"),
    };
  }
  /**
   * The loop, in four phases.
   *
   * Observe and resolve the goal. If it is already satisfied where the bot
   * stands, the process decides whether that ends the run. If the bot is in the
   * air, land before planning. Plan, reusing the continuation searched while
   * the last segment was walked when the bot ended exactly where that search
   * assumed. Execute, and let the executor's report choose why the next search
   * happens, or settle.
   *
   * `#pending` owns the plan-ahead search for both this loop and cleanup.
   * `searchReason` says why the next search is being asked for.
   */
  async #navigate(): Promise<NavigationOutcome> {
    let searchReason: SearchReason = "initial";
    for (;;) {
      if (this.context.signal.aborted) return this.#stopped();
      // Observe: one fresh look at the world, and the goal frozen against it.
      const observation = this.context.bot.observe();
      this.#policy = Object.freeze({ ...this.request.policy });
      const resolved = this.#resolveGoal(observation);
      if (resolved.kind === "invalid") return this.#failed(resolved.failure);
      const { goal, node } = resolved;
      if (goal.isSatisfied(node, this.context.world)) {
        const arrival = await this.#resolveArrival(node, observation);
        if (arrival.kind === "outcome") return arrival.outcome;
        searchReason = arrival.reason;
        continue;
      }
      // A route needs a stance to start from; let a fall land before planning.
      const planningStall = this.#planningStall.check(observation);
      if (planningStall) return this.#failed(planningStall);
      if (observation.stance === "airborne") {
        this.status({ kind: "stabilizing", runId: this.context.runId, reason: "airborne" });
        const stable = await this.context.bot.stabilize(this.context.signal);
        if (stable.kind === "failed")
          return this.#failed({
            kind: "movement_failed",
            movement: { kind: "unstable", stepId: "stabilize", phase: "moving", observation: stable.observation },
          });
        continue;
      }
      const stalled = this.#judgeProgress(goal, node);
      if (stalled) return stalled;
      // Plan: reuse the segment searched while walking, if the bot ended where
      // that search assumed; otherwise search from here.
      const planning = await this.#planFromHere(goal, node, observation, searchReason);
      if (planning.kind === "outcome") return planning.outcome;
      if (planning.kind === "retry") {
        searchReason = planning.reason;
        continue;
      }
      // Baritone plans its next segment while walking the current one, under a
      // budget several times the in-line one, precisely because a search that is
      // not holding up movement can afford to take longer. A partial segment is
      // the case that always has a next search coming and a known state to start
      // it from, so that is the one worth running early.
      this.#pending = planning.plan.complete
        ? null
        : this.#startContinuation(planning.latestGoal, planning.plan, observation);
      // Execute: walk one immutable plan. What the executor reports decides
      // whether the loop goes round again, hands arrival to the process, or
      // settles.
      const execution = await this.#executePlan(planning.plannedGoal, planning.plan);
      if (execution.kind === "outcome") return execution.outcome;
      searchReason = execution.reason;
    }
  }
  /**
   * Whether the run is being moved back between routes; see `STALLED_ROUTES`.
   *
   * Judged where a route is about to be planned, against the goal's own
   * estimate, and only after a route was executed since the last judgement:
   * a search cancelled because the bot drifted, or replanned for a changed
   * world, has not moved the bot and is not counted.
   */
  #judgeProgress(goal: ActiveGoal, node: PlanningNode): NavigationOutcome | null {
    const executed = this.#executed;
    this.#executed = false;
    const estimate = goal.heuristic(node);
    if (this.#progress === null || this.#progress.revision !== goal.revision || estimate < this.#progress.best) {
      this.#progress = { revision: goal.revision, best: estimate, stalls: 0 };
      return null;
    }
    if (!executed) return null;
    this.#progress.stalls += 1;
    if (this.#progress.stalls < STALLED_ROUTES) return null;
    return this.#failed({
      kind: "no_progress",
      reason: "repeated_execution_checkpoint",
      observation:
        `${STALLED_ROUTES} executed routes in a row began no nearer the goal than ${this.#progress.best.toFixed(1)} ` +
        `ticks away; the last from ${node.feet.x},${node.feet.y},${node.feet.z}`,
    });
  }
  /**
   * One search from `node`, guarded against asking the same question twice.
   *
   * A search is identified by everything its answer depends on: the goal
   * revision, the feet, the world and resource revisions, and how many movement
   * failures have been recorded. Meeting an identity again means nothing has
   * changed since the last identical search, so asking again would be the run
   * going in circles.
   *
   * The identity is kept only when the search answered its own question: a
   * plan, or a terminal calculation failure handed to the process. A search
   * overtaken by the world, by a revised goal, or run speculatively as a
   * continuation, releases it, so the next honest attempt from here is not
   * mistaken for a repeat.
   */
  async #plan(
    goal: ActiveGoal,
    node: PlanningNode,
    observation: NavigationObservation,
    reason: SearchReason,
    signal: AbortSignal = this.context.signal,
    ahead: PlanAhead | null = null,
  ): Promise<PlanningResult> {
    // Frozen here, before the identity is formed, and held for this search
    // alone. Entities move every tick while the overlay and the world revision
    // model blocks only, so without the fingerprint a hostile that has walked
    // two blocks would be answered as a repeat of the question it changed.
    const field = this.context.stepField?.() ?? null;
    const identity =
      `${goal.revision}|${blockKey(node.feet)}|${observation.worldRevision}|${observation.resourceRevision}` +
      `|movement-failures:${this.#movementFailures.size}|field:${field?.fingerprint ?? "none"}`;
    if (this.#searchIdentities.has(identity))
      return {
        kind: "outcome",
        outcome: this.#failed({ kind: "no_progress", reason: "repeated_search", observation: identity }),
      };
    this.#searchIdentities.add(identity);
    const release = () => this.#searchIdentities.delete(identity);

    const answer = await this.#searchWithBodyOwnership(goal, node, reason, signal, field, ahead);
    switch (answer.kind) {
      case "stopped":
        release();
        return { kind: "outcome", outcome: this.#stopped() };
      case "goal_invalid":
      case "planning_stalled":
        return { kind: "outcome", outcome: this.#failed(answer.failure) };
      case "arrived":
        return this.#resolveArrival(answer.node, answer.observation);
      case "start_changed":
        release();
        return { kind: "retry", reason: "start_changed" };
      case "stale":
        release();
        return { kind: "retry", reason: "world_changed" };
      case "calculation_failed":
        // Baritone's failed plan-ahead calculation is `NEXT_CALC_FAILED`, not
        // the process-facing `CALC_FAILED`. The current route keeps moving and,
        // once it ends, pathing calculates inline from the actual endpoint.
        if (ahead) {
          release();
          return { kind: "retry", reason: "calculation_failure" };
        }
        return this.#resolveCalculationFailure(answer.failure, answer.observation);
      case "plan":
        // Speculative calculation is not physical admission. Its endpoint may
        // no longer be occupied when the foreground comes to use this result.
        if (ahead) release();
        if (this.#goalRevisesRoute(goal, answer.latestGoal, answer.plan, node)) {
          release();
          return { kind: "retry", reason: "goal_revised" };
        }
        return { kind: "plan", plannedGoal: goal, latestGoal: answer.latestGoal, plan: answer.plan };
    }
  }
  async #searchWithBodyOwnership(
    goal: ActiveGoal,
    node: PlanningNode,
    reason: SearchReason,
    signal: AbortSignal,
    field: StepField | null,
    ahead: PlanAhead | null,
  ): Promise<SearchAnswer> {
    // Plan-ahead shares time with movement, which already owns the controls.
    // A stationary search must resist currents and knockback from its starting cell.
    if (ahead) return this.#search(goal, node, reason, signal, field, ahead);
    const release = this.context.bot.holdPosition(this.context.world);
    try {
      return await this.#search(goal, node, reason, signal, field, null);
    } finally {
      try {
        // An impulse can invalidate the search's start mid-flight. Keep its
        // supported hold through the existing bounded landing observation,
        // including cancellation, before another search or owner takes over.
        if (this.context.bot.observe().stance === "airborne")
          await this.context.bot.stabilize(new AbortController().signal);
      } finally {
        release();
      }
    }
  }
  /**
   * Run one incremental search to its end, in slices.
   *
   * Between slices the run yields to the event loop so physics keeps moving,
   * then looks at the bot again: the goal may have been reached, or become
   * invalid, while the search was thinking, and either ends it early. Changes
   * to the world are the search's own business; it answers `stale` when what
   * it read no longer holds.
   */
  async #search(
    goal: ActiveGoal,
    node: PlanningNode,
    reason: SearchReason,
    signal: AbortSignal,
    field: StepField | null,
    ahead: PlanAhead | null,
  ): Promise<SearchAnswer> {
    const searchId = `${this.context.runId}:search:${++this.#counters.searches}`;
    const searchStart = this.context.bot.observe();
    if (!ahead) this.#planningStall.begin(searchStart);
    if (reason === "segment_continuation" || reason === "arrival_continuation" || reason === "alternate_arrival")
      this.#counters.continuations += 1;
    else if (reason !== "initial") this.#counters.replans += 1;
    this.#events.emit({ kind: "search_started", searchId, reason, goal: goal.revision });
    let overlay = new PlanningOverlay(new OverlayInterner());
    for (const effect of ahead?.effects ?? []) overlay = overlay.apply(effect);
    const search = new IncrementalSearch({
      id: searchId,
      start: { node: { ...node, overlayId: overlay.identity }, overlay },
      goal,
      context: {
        world: this.context.world,
        catalogue: this.context.catalogue,
        policy: this.#policy,
        // Read fresh: food drains over a long run, and a route planned while
        // sprinting is not executable once it stops being available.
        player: this.context.bot.observe().player,
        protectedFeet: this.#visitedFeet,
        stepField: field,
      },
      // The larger budget belongs to a search that shares its time with
      // movement. The same segment searched standing still, after a plan-ahead
      // result was abandoned, is a pause the bot's operator can see.
      limits: ahead ? (this.request.continuationSearchLimits ?? this.request.searchLimits) : this.request.searchLimits,
    });
    this.status({ kind: "planning", runId: this.context.runId, goalRevision: goal.revision, searchId });
    for (;;) {
      // Every slice, the first included, starts on a fresh turn of the event
      // loop. Physics keeps ticking between slices, and whoever started this
      // run gets a turn before any work is done, so a stop issued straight
      // after asking is honoured rather than raced by a search small enough
      // to finish in one slice.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (signal.aborted) {
        search.cancel();
        return { kind: "stopped" };
      }
      const stall = ahead ? null : this.#planningStall.check(this.context.bot.observe());
      if (stall) {
        search.cancel();
        return { kind: "planning_stalled", failure: stall };
      }
      const update = search.advance();
      if (update.kind !== "progress")
        this.#events.emit({
          kind: "search_finished",
          searchId,
          goal: goal.revision,
          result: update.kind,
          counts: update.evidence,
          exhausted:
            update.kind === "no_path"
              ? "frontier"
              : update.kind === "limit"
                ? update.limit.kind === "radius"
                  ? "radius"
                  : "compute_time"
                : null,
          limit: update.kind === "limit" ? update.limit : null,
          interpretation:
            update.kind === "no_path"
              ? "The explored frontier is exhausted under these observations and movement permissions; this is not proof that all terrain is unreachable."
              : update.kind === "limit"
                ? "The declared search resource was exhausted; geometry outside that search remains untested."
                : "This is the search result, before physical execution and arrival validation.",
        });
      this.#counters.searchSlices += 1;
      this.#events.emit({
        kind: "search_slice",
        searchId,
        visited: update.evidence.visited,
        generated: update.evidence.generated,
        computeMs: update.evidence.computeMs,
        ...("checkpoint" in update && update.checkpoint && { checkpoint: update.checkpoint }),
      });
      if (update.kind === "cancelled") return { kind: "stopped" };
      // The goal may have moved, or been reached, while the search was thinking.
      const observation = this.context.bot.observe();
      // Holding controls cannot prevent an external impulse from moving the
      // starting body. Plan-ahead deliberately searches from a future endpoint.
      if (
        !ahead &&
        (observation.stance === "airborne" ||
          !samePosition(node.feet, navigationFeet(observation.position, observation.stance === "supported"))) &&
        !isSurfaceBobbing(searchStart, observation, this.context.world)
      ) {
        search.cancel();
        return { kind: "start_changed" };
      }
      const resolved = this.#resolveGoal(observation);
      if (resolved.kind === "invalid") {
        search.cancel();
        return { kind: "goal_invalid", failure: resolved.failure };
      }
      if (resolved.goal.isSatisfied(resolved.node, this.context.world)) {
        search.cancel();
        return { kind: "arrived", node: resolved.node, observation };
      }
      if (update.kind === "progress") continue;
      if (update.kind === "stale") return { kind: "stale" };
      if (update.kind === "no_path" || update.kind === "limit") {
        const after = this.#lastMovementFailure ? { after: this.#lastMovementFailure } : {};
        return {
          kind: "calculation_failed",
          observation,
          failure:
            update.kind === "no_path"
              ? { kind: "no_path", search: update.evidence, closest: update.closest, ...after }
              : { kind: "search_limit", search: update.evidence, limit: update.limit, ...after },
        };
      }
      return { kind: "plan", plan: update.plan, latestGoal: resolved.goal };
    }
  }
  async #executePlan(goal: ActiveGoal, plan: RoutePlan): Promise<ExecutionResult> {
    this.#planningStall.committed();
    this.#counters.plans += 1;
    this.#lastMovementFailure = null;
    this.#executed = true;
    this.#routeDependencies = plan.dependencies;
    this.#events.emit({
      kind: "route_committed",
      planId: plan.id,
      steps: plan.steps.length,
      plan: { start: plan.start, end: plan.end, steps: plan.steps, complete: plan.complete },
    });
    const executor = new RouteExecutor({
      context: this.context,
      passages: this.#passages,
      plan,
      stepStarted: (step) => this.#onStepStarted(plan, step),
      phase: (step, phase) => this.#onStepPhase(goal, plan, step, phase),
      effectConfirmed: (operation) => {
        if (operation.kind === "break") this.#counters.breaks += 1;
        else if (operation.kind === "place") this.#counters.placements += 1;
        else this.#counters.activations += 1;
      },
      stepCompleted: (step, arrival) => this.#onStepCompleted(goal, plan, step, arrival),
    });
    this.#routeExecutor = executor;
    const result = await executor.execute().finally(() => {
      if (this.#routeExecutor === executor) this.#routeExecutor = undefined;
    });
    switch (result.kind) {
      case "cancelled":
        return { kind: "outcome", outcome: this.#stopped() };
      case "invalidated":
        return { kind: "retry", reason: "world_changed" };
      case "goal_revised":
        return { kind: "retry", reason: "goal_revised" };
      case "goal_satisfied": {
        const observation = this.context.bot.observe();
        return this.#resolveArrival(this.#observedNode(observation, result.arrival), observation);
      }
      case "failed": {
        this.#lastMovementFailure = result.failure;
        this.#events.emit({
          kind: "step_failed",
          stepId: result.step.id,
          movement: result.step.kind,
          observation: result.failure.observation,
        });
        const held = await this.#releaseOverheadPin(plan);
        if (held) return held;
        return this.#movementFailureRepeated(goal, result.step)
          ? {
              kind: "outcome",
              outcome: this.#failed({
                kind: "no_progress",
                reason: "repeated_movement_failure",
                observation: result.failure.observation,
              }),
            }
          : { kind: "retry", reason: "movement_failed" };
      }
      case "exhausted":
        return { kind: "retry", reason: result.reason };
    }
  }
  #onStepStarted(plan: RoutePlan, step: PlannedStep): void {
    this.#counters.movementAttempts[step.kind] = (this.#counters.movementAttempts[step.kind] ?? 0) + 1;
    this.#events.emit({ kind: "step_started", planId: plan.id, stepId: step.id, movement: step.kind });
  }
  #onStepPhase(goal: ActiveGoal, plan: RoutePlan, step: PlannedStep, phase: MovementPhase): void {
    this.status({
      kind: "executing",
      runId: this.context.runId,
      goalRevision: goal.revision,
      routeId: plan.id,
      stepId: step.id,
      movement: step.kind,
      phase,
    });
    this.#events.emit({ kind: "step_phase", stepId: step.id, phase });
  }
  /**
   * After each step, whether the rest of the route is still worth walking.
   *
   * The goal is re-resolved where the bot actually landed. Satisfied there means
   * the route is done early. A goal that no longer accepts the route's end means
   * the remaining steps answer a stale question.
   */
  #onStepCompleted(goal: ActiveGoal, plan: RoutePlan, step: PlannedStep, arrival: BlockPosition): StepDecision {
    this.#events.emit({ kind: "step_completed", stepId: step.id, movement: step.kind });
    this.#visitedFeet.add(blockKey(arrival));
    const revised = this.#resolveGoal(this.context.bot.observe(), arrival);
    if (revised.kind === "invalid") return "goal_revised";
    if (revised.goal.isSatisfied(revised.node, this.context.world)) return "goal_satisfied";
    if (this.#goalRevisesRoute(goal, revised.goal, plan, revised.node)) return "goal_revised";
    return "continue";
  }
  /** A complete route promises arrival; a partial route promises useful progress. */
  #goalRevisesRoute(planned: ActiveGoal, latest: ActiveGoal, plan: RoutePlan, from: PlanningNode): boolean {
    if (planned.isSatisfied(plan.endNode, this.context.world))
      return !latest.isSatisfied(plan.endNode, this.context.world);
    // A changed target can lie behind an exploration route. Keep partial
    // movement only while its endpoint is no farther from the new goal.
    return planned.revision !== latest.revision && latest.heuristic(plan.endNode) > latest.heuristic(from);
  }
  /**
   * Record one movement failure by what was attempted and from where.
   *
   * True when this exact failure has happened before, which is the run going in
   * circles rather than making a fresh attempt.
   */
  #movementFailureRepeated(goal: ActiveGoal, step: PlannedStep): boolean {
    const failureCell = blockKey(blockPosition(this.context.bot.observe().position));
    const identity = `${goal.revision}|${step.kind}|${blockKey(step.from)}>${blockKey(step.to)}|${failureCell}`;
    if (this.#movementFailures.has(identity)) return true;
    this.#movementFailures.add(identity);
    return false;
  }
  /**
   * A step that failed with the body held under a ceiling it does not fit
   * beneath is not a step to replan: no route moves a body the server puts
   * back every tick, and the live run retried one step from one cell until
   * it was closed. Break the ceiling when the policy allows and walk the same
   * goal again; otherwise say what holds the body, so the caller stops asking.
   * See `overhead-pin.ts` for the condition.
   */
  async #releaseOverheadPin(plan: RoutePlan): Promise<ExecutionResult | null> {
    const { bot, world, signal } = this.context;
    const cell = overheadPinningCell(world, bot.observe().position);
    if (cell === null) return null;
    const block = world.blockAt(cell.x, cell.y, cell.z);
    const label = blockLabel(cell);
    const held = (why: string): ExecutionResult => {
      const observation = `The body is held under ${label}, ${why}.`;
      this.#events.emit({ kind: "pinned_body", cell, released: false, observation });
      return { kind: "outcome", outcome: this.#failed({ kind: "no_progress", reason: "pinned_body", observation }) };
    };
    if (block.kind !== "loaded") return held("which is not loaded");
    if (!this.#policy.allowDigging) return held("which this route may not dig");
    if (!block.traits.safeToBreak) return held("which is not safe to break");
    if (this.#pinReleases >= PIN_RELEASE_LIMIT) return held("which has come back each time it was broken");
    const observation = bot.observe();
    const excavation = priceExcavation({
      world, policy: this.#policy, position: cell,
      digContext: {
        submergedAtEyes: observation.stance === "swimming",
        onGround: observation.stance === "supported",
        aquaAffinity: observation.player.aquaAffinity,
        effects: observation.player.effects,
      },
    });
    if (excavation.kind === "unavailable") return held(excavation.reason);
    // A collapsing column needs its own reachable excavation. Do not release
    // a ceiling into falling blocks while the body has nowhere to move.
    if (excavation.digs.length !== 1) return held("which supports a falling column");
    const dig = excavation.digs[0]!;
    this.#pinReleases += 1;
    const token = { runId: this.context.runId, planId: plan.id, stepId: "overhead_pin", attempt: this.#pinReleases };
    bot.clearOwnedControls();
    const { result } = await executeWorldEffect({
      ...this.context,
      token,
      operation: { kind: "break", position: cell, expectedStateId: dig.stateId, toolType: dig.toolType, brings: [] },
      targets: [{ position: cell, before: stateMatcher(dig.stateId), after: airMatcher }],
      deadlineMs: Date.now() + Math.max(PIN_RELEASE_DEADLINE_MS, dig.expectedTicks * 100),
    });
    if (signal.aborted) return { kind: "outcome", outcome: this.#stopped() };
    if (result.kind !== "confirmed")
      return held(result.kind === "effect_failed" ? result.observation : `whose break was ${result.kind}`);
    this.#counters.breaks += 1;
    const released = await this.#awaitRelease();
    if (signal.aborted) return { kind: "outcome", outcome: this.#stopped() };
    if (!released) return held("which did not release the body");
    this.#events.emit({ kind: "pinned_body", cell, released: true, observation: `Broke ${label} to stand up.` });
    // The failed step was the hold's, not the route's; it may be tried afresh.
    this.#movementFailures.clear();
    return { kind: "retry", reason: "movement_failed" };
  }
  /** Whether the body is clear within a couple of seconds of the break completing. */
  #awaitRelease(): Promise<boolean> {
    const { bot, world, signal } = this.context;
    const clear = () => overheadPinningCell(world, bot.observe().position) === null;
    if (clear()) return Promise.resolve(true);
    return new Promise((resolve) => {
      const resources = new DisposableStack();
      const finish = () => {
        resources.dispose();
        resolve(!signal.aborted && clear());
      };
      let ticks = 0;
      resources.defer(bot.subscribePhysicsTick(() => {
        if (clear() || ++ticks >= PIN_RELEASE_TICKS) finish();
      }));
      signal.addEventListener("abort", finish, { once: true });
      resources.defer(() => signal.removeEventListener("abort", finish));
      const timer = setTimeout(finish, PIN_RELEASE_TICKS * 50);
      resources.defer(() => clearTimeout(timer));
      if (signal.aborted) finish();
    });
  }

  async #resolveArrival(node: PlanningNode, observation: NavigationObservation): Promise<ExecutionResult> {
    const result = this.request.onArrival
      ? await this.request.onArrival({
          goalRevision: this.#goalRevision,
          node,
          observation,
          signal: this.context.signal,
        })
      : ({ kind: "completed" } as const);
    this.#events.emit({ kind: "goal_arrived", result: result.kind });
    if (this.context.signal.aborted) return { kind: "outcome", outcome: this.#stopped() };
    return result.kind === "continue"
      ? { kind: "retry", reason: "arrival_continuation" }
      : { kind: "outcome", outcome: { kind: "completed", evidence: this.#evidence() } };
  }
  async #resolveCalculationFailure(
    failure: NavigationCalculationFailure,
    observation: NavigationObservation,
  ): Promise<PlanningResult> {
    if (!this.request.onCalculationFailure) {
      return { kind: "outcome", outcome: this.#failed(failure) };
    }
    const result = await this.request.onCalculationFailure({
      failure,
      observation,
      signal: this.context.signal,
    });
    this.#events.emit({ kind: "calculation_failed", failure: failure.kind, result: result.kind });
    if (this.context.signal.aborted) return { kind: "outcome", outcome: this.#stopped() };
    return result.kind === "continue"
      ? { kind: "retry", reason: "calculation_failure" }
      : { kind: "outcome", outcome: { kind: "completed", evidence: this.#evidence() } };
  }
  #stopped(): NavigationOutcome {
    return { kind: "stopped", reason: describeAbort(this.context.signal.reason), evidence: this.#evidence() };
  }
  #failed(failure: NavigationFailure): NavigationOutcome {
    return { kind: "failed", failure, evidence: this.#evidence() };
  }
  #evidence(): NavigationEvidence {
    return {
      runId: this.context.runId,
      startedAtMs: this.#startedAt,
      settledAtMs: Date.now(),
      start: this.#start,
      final: this.context.bot.observe(),
      goalRevision: this.#goalRevision,
      ...this.#counters,
      movementAttempts: { ...this.#counters.movementAttempts },
      // Provisional: `execute` measures this again once cleanup has run.
      cleanup: this.#cleanupEvidence(),
      unrestoredPassages: this.#passages.pending(this.context.bot.observe()),
    };
  }
}
