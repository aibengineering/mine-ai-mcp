/** What a search was allowed to spend, and the evidence it returns about progress. */
import type { BlockPosition } from "../world/world.js";

export interface SearchLimits {
  /**
   * How long to keep searching once something is worth committing.
   *
   * Baritone's `primaryTimeoutMS`. Its search flips out of `failing` the moment
   * a node has travelled `MIN_DIST_PATH`, and from then on the short budget
   * applies: there is already a segment to walk, so more thinking competes with
   * moving. Measured against compute time rather than the wall clock, because
   * this search yields between slices and must not be charged for the ticks it
   * spent letting physics run.
   */
  readonly primaryTimeoutMs?: number;
  /**
   * How long to keep searching while nothing is worth committing.
   *
   * Baritone's `failureTimeoutMS`, and deliberately the longer of the two: a
   * search that has found nothing has nothing to fall back on, so giving up
   * early is the expensive mistake. Also measured in compute time.
   */
  readonly failureTimeoutMs?: number;
  /**
   * How far from the start, in blocks along any axis, a node may be before
   * the search stops with a limit.
   *
   * Not a Baritone limit; ours, and earned by combat. A moving target revises
   * the goal, and every revision buys a fresh failure budget, so an approach
   * toward an unreachable mob a few blocks away could hold the body for over
   * a minute. A wall-clock cap gave up on skeletons that back away while
   * chased. The radius is the fact that actually decides "not reachable from
   * here". Ordinary navigation leaves it unset.
   */
  readonly maximumRadius?: number;
}

export interface SearchProgressNodeEvidence {
  readonly position: BlockPosition;
  readonly heuristic: number;
  readonly routeCost: number;
  readonly depth: number;
}

/** Why the partial-route boundary did or did not have physical progress to commit. */
export interface PartialRouteCheckpoint {
  readonly threshold: number;
  readonly outcome: "segment_ready" | "no_progress_candidate";
  readonly selectedBy: "goal" | "long_progress" | "progress" | "closest";
  readonly openNodes: number;
  readonly start: SearchProgressNodeEvidence;
  readonly closest: SearchProgressNodeEvidence;
  readonly selected: SearchProgressNodeEvidence;
  readonly closestGenerated?: SearchProgressNodeEvidence;
  readonly mostPermissiveProgress?: {
    readonly coefficient: number;
    readonly score: number;
    readonly requiredBelow: number;
    readonly node: SearchProgressNodeEvidence;
  };
}

export interface SearchEvidence {
  readonly queued: number;
  readonly visited: number;
  readonly generated: number;
  readonly slices: number;
  readonly computeMs: number;
}
