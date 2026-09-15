/**
 * The one navigation transaction: plan, execute, and settle a single route.
 *
 * A caller states a goal and a movement policy; this reports what the world
 * actually yielded. Everything below it — admission, search, route execution —
 * belongs to the engine, and everything above it belongs to the action or the
 * process that chose the objective.
 *
 * `runNavigation` takes the navigator it drives as an explicit argument rather
 * than looking it up. The runtime binds it once and hands callers a
 * {@link Navigate}, so nothing above this file ever passes a bot to navigate.
 */
import type { Goal } from "./goals/goal.js";
import type { MovementPolicy } from "./movements/policy.js";
import type { Navigator } from "./orchestration/navigator.js";
import type { NavigationOutcome } from "./orchestration/outcome.js";
import {
  describeCalculationFailure,
  type NavigationArrival,
  type NavigationArrivalResult,
  type NavigationCalculationFailureEvent,
  type NavigationCalculationFailureResult,
} from "./orchestration/process-events.js";
import type { SearchLimits } from "./search/search-result.js";

/** Baritone's inline search budgets: enough to find a useful first segment without holding movement up indefinitely. */
export const DEFAULT_SEARCH_LIMITS = Object.freeze({
  primaryTimeoutMs: 500,
  failureTimeoutMs: 2_000,
} satisfies SearchLimits);

/** Baritone's larger plan-ahead budgets, spent while the bot is already walking the current segment. */
export const DEFAULT_CONTINUATION_SEARCH_LIMITS = Object.freeze({
  primaryTimeoutMs: 4_000,
  failureTimeoutMs: 5_000,
} satisfies SearchLimits);

export type NavigationResult =
  | { readonly status: "completed"; readonly elapsedMs: number }
  | { readonly status: "stopped"; readonly reason: string; readonly elapsedMs: number };

export interface NavigateOptions {
  readonly movements: MovementPolicy;
  readonly goal: Goal;
  /** Decide whether reaching one current goal ends or continues this process. */
  readonly onArrival?: (arrival: NavigationArrival) => NavigationArrivalResult | Promise<NavigationArrivalResult>;
  /** Decide whether a failed inline calculation ends or revises this process. */
  readonly onCalculationFailure?: (
    event: NavigationCalculationFailureEvent,
  ) => NavigationCalculationFailureResult | Promise<NavigationCalculationFailureResult>;
  /** Optional caller-owned patience for a route with a concrete local bound. */
  readonly timeoutMs?: number;
  /** Cancels the whole action and is rethrown to the action runner. */
  readonly signal?: AbortSignal;
  /**
   * Makes only this navigation unnecessary, such as observing a pickup.
   *
   * Abort it with a string and that string is the stopped result's reason.
   */
  readonly stopSignal?: AbortSignal;
  /** Observe the selected tool only when an owned route break is about to execute. */
  readonly onToolSelected?: (itemType: number | null) => void;
  /** Optional search qualification owned by a caller with a more volatile goal. */
  readonly searchLimits?: SearchLimits;
  /**
   * Opts this route out of the runtime's registered step field.
   *
   * `null` is the only value: a caller cannot supply a field of its own. Combat
   * walks toward the very thing the field prices, so its approach and cover
   * routes say this and are exempt by construction. Evade routes retain
   * threat avoidance while their goal chooses the required separation.
   */
  readonly stepField?: null;
}

/** The operation navigation exists to offer: one goal in, one settled route out. */
export type Navigate = (options: NavigateOptions) => Promise<NavigationResult>;

function outcomeReason(outcome: Exclude<NavigationOutcome, { kind: "completed" }>): string {
  if (outcome.kind === "stopped") return outcome.reason;
  const failure = outcome.failure;
  if (failure.kind === "internal_error") return failure.message;
  if (failure.kind === "invalid_goal" || failure.kind === "world_unavailable") return failure.observation;
  if (failure.kind === "no_path" || failure.kind === "search_limit") return describeCalculationFailure(failure);
  if (failure.kind === "no_progress") return `${failure.reason}: ${failure.observation}`;
  if (failure.kind === "resource_changed" || failure.kind === "restoration_incomplete") return failure.observation;
  return failure.movement.observation;
}

/** Plan, execute, and settle one route through the package-local navigator. */
export async function runNavigation(navigator: Navigator, options: NavigateOptions): Promise<NavigationResult> {
  options.signal?.throwIfAborted();
  const startedAt = Date.now();
  // Every reason this route may stop, composed into the one signal the engine
  // takes. Whichever source aborts first supplies the reason the outcome
  // reports; nothing below this line installs a listener of its own.
  const stops = [options.signal, options.stopSignal];
  if (options.timeoutMs !== undefined) stops.push(AbortSignal.timeout(options.timeoutMs));
  const signal = AbortSignal.any(stops.filter((source) => source !== undefined));
  const admission = navigator.startRun({
    goal: options.goal,
    policy: options.movements,
    ...(options.onArrival && { onArrival: options.onArrival }),
    ...(options.onCalculationFailure && { onCalculationFailure: options.onCalculationFailure }),
    stepField: options.stepField,
    signal,
    // Commit a useful partial route instead of retaining an ever-growing A*
    // frontier. Without this qualified boundary cavern-ore-return expanded
    // 100,548 nodes and 652 MB RSS without taking its first physical step.
    searchLimits: {
      ...DEFAULT_SEARCH_LIMITS,
      ...options.searchLimits,
    },
    continuationSearchLimits: {
      ...DEFAULT_CONTINUATION_SEARCH_LIMITS,
      ...options.searchLimits,
    },
  });
  if (admission.kind === "busy") throw new Error(`Navigation is busy with run ${admission.activeRunId}.`);

  const outcome = await admission.handle.outcome;
  const pending = outcome.evidence.unrestoredPassages
    .map(({ position, observation }) => `Doorway at ${position.x},${position.y},${position.z}: ${observation}`)
    .join(" ");
  // The action's own cancellation is not a route result; it is rethrown so
  // the action runner sees it. A stop signal or a timeout is.
  if (options.signal?.aborted && pending) {
    throw new Error(`${outcome.kind === "completed" ? "Navigation cancelled." : outcomeReason(outcome)} ${pending}`);
  }
  options.signal?.throwIfAborted();
  const elapsedMs = Date.now() - startedAt;
  return outcome.kind === "completed"
    ? { status: "completed", elapsedMs }
    : { status: "stopped", reason: [outcomeReason(outcome), pending].filter(Boolean).join(" "), elapsedMs };
}
