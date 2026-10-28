/** What one navigation run reports about itself when it settles. */
import type { UnrestoredPassage } from "./execution/opened-passages.js";
import type { ClosestNodeEvidence, SearchEvidence, SearchLimitEvidence } from "./search/search-result.js";
import type { MovementFailure } from "./execution/movement-failure.js";
export type SearchReason =
  | "initial"
  | "segment_continuation"
  | "arrival_continuation"
  | "calculation_failure"
  | "alternate_arrival"
  | "world_changed"
  | "start_changed"
  | "movement_failed"
  | "goal_revised";

/**
 * What a settled run leaves for its caller. Only what a caller reads: the
 * doorways it could not close, which `runNavigation` puts in its words, and
 * what the run still held after cleanup, which is how a leak shows. What the
 * run did on the way is in its telemetry events.
 */
export interface NavigationEvidence {
  readonly unrestoredPassages: readonly UnrestoredPassage[];
  readonly cleanup: {
    readonly listeners: number;
    readonly controls: number;
    readonly expectations: number;
  };
}

/** How a run ended, before the evidence its cleanup measures is attached. */
export type NavigationSettlement =
  | { readonly kind: "completed" }
  | {
      /** The run was asked to stop; `reason` is what the aborting signal said. */
      readonly kind: "stopped";
      readonly reason: string;
    }
  | { readonly kind: "failed"; readonly failure: NavigationFailure };

export type NavigationFailure =
  | { readonly kind: "invalid_goal"; readonly observation: string }
  | { readonly kind: "world_unavailable"; readonly observation: string }
  /**
   * `after` is the movement failure this calculation was replanning around,
   * when there was one. A route priced at pickaxe speed lost its pickaxe
   * mid-step and the hand-priced replan then exhausted its budget; reported
   * as the exhausted budget alone, that read as a search defect.
   */
  | {
      readonly kind: "no_path";
      readonly search: SearchEvidence;
      readonly closest: ClosestNodeEvidence;
      readonly after?: MovementFailure;
    }
  | {
      readonly kind: "search_limit";
      readonly search: SearchEvidence;
      readonly limit: SearchLimitEvidence;
      readonly after?: MovementFailure;
    }
  | {
      readonly kind: "no_progress";
      readonly reason:
        | "repeated_search"
        | "repeated_execution_checkpoint"
        | "repeated_movement_failure"
        | "planning_stalled"
        /** The body is held under a ceiling it does not fit beneath and this route may not break it. */
        | "pinned_body";
      readonly observation: string;
      /** The movement whose repeated failure ended the run. */
      readonly movement?: MovementFailure;
    }
  | { readonly kind: "movement_failed"; readonly movement: MovementFailure }
  | { readonly kind: "resource_changed"; readonly observation: string }
  | { readonly kind: "restoration_incomplete"; readonly observation: string }
  | { readonly kind: "internal_error"; readonly message: string };

export type NavigationOutcome = NavigationSettlement & { readonly evidence: NavigationEvidence };

/** A route search that ended without a path: none exists, or a bound ran out. */
export type NavigationCalculationFailure = Extract<
  NavigationFailure,
  { readonly kind: "no_path" } | { readonly kind: "search_limit" }
>;
