/**
 * How a goal-directed process stays in charge of its own objective.
 *
 * Reaching a spatial goal, or failing one inline calculation, is an event the
 * caller resolves — navigation does not decide whether the process is done.
 */
import type { PlanningNode } from "../goals/goal.js";
import type { NavigationObservation } from "../world/world.js";
import type { NavigationFailure } from "./outcome.js";

/** A spatial goal was reached, but the caller decides whether its process is done. */
export interface NavigationArrival {
  readonly goalRevision: string;
  readonly node: PlanningNode;
  readonly observation: NavigationObservation;
  readonly signal: AbortSignal;
}

export type NavigationArrivalResult = { readonly kind: "completed" } | { readonly kind: "continue" };

export type NavigationCalculationFailure = Extract<
  NavigationFailure,
  { readonly kind: "no_path" } | { readonly kind: "search_limit" }
>;

/** An inline path calculation failed; the caller may revise its process goal and continue. */
export interface NavigationCalculationFailureEvent {
  readonly failure: NavigationCalculationFailure;
  readonly observation: NavigationObservation;
  readonly signal: AbortSignal;
}

export type NavigationCalculationFailureResult = { readonly kind: "completed" } | { readonly kind: "continue" };

/** The one sentence every caller reports for a failed calculation: what ran out, how close it got, and what it was replanning around. */
export function describeCalculationFailure(failure: NavigationCalculationFailure): string {
  const closest = failure.kind === "no_path" ? failure.closest : failure.limit.closest;
  const where = `closest node was ${closest.position.x},${closest.position.y},${closest.position.z}`;
  const { visited, generated, computeMs } = failure.search;
  const spent = `${Math.round(computeMs)} ms compute`;
  const work = `visited ${visited} nodes, generated ${generated}`;
  const stopped =
    failure.kind === "no_path"
      ? `no path found after ${spent}`
      : failure.limit.kind === "search_time"
        ? `search timed out after ${spent} (limit ${failure.limit.limit} ms); no path or usable partial route found`
        : `search radius limit ${failure.limit.limit} blocks reached after ${spent}; no path or usable partial route found`;
  const what = `${stopped}; ${work}; ${where}`;
  return failure.after ? `${what}, while replanning after a movement failure: ${failure.after.observation}` : what;
}
