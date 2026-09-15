/** What one navigation run reports about itself: status while live, evidence when settled. */
import type { SearchEvidence } from "../search/search-result.js";
import type { MovementKind } from "../movements/movement.js";
import type { BlockPosition, NavigationObservation } from "../world/world.js";
import type { UnrestoredPassage } from "../execution/opened-passages.js";
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

export type MovementPhase = "aligning" | "breaking" | "placing" | "activating" | "moving" | "confirming";

export type NavigationStatus =
  | { readonly kind: "planning"; readonly runId: string; readonly goalRevision: string; readonly searchId: string }
  | {
      readonly kind: "executing";
      readonly runId: string;
      readonly goalRevision: string;
      readonly routeId: string;
      readonly stepId: string;
      readonly movement: MovementKind;
      readonly phase: MovementPhase;
    }
  | { readonly kind: "stabilizing"; readonly runId: string; readonly reason: "airborne" }
  | { readonly kind: "stopping"; readonly runId: string; readonly reason: string };

export interface ClosestNodeEvidence {
  readonly position: BlockPosition;
  readonly heuristic: number;
  readonly routeCost: number;
  readonly basis: "best_heuristic_search_node";
}

export interface SearchLimitEvidence {
  readonly kind: "search_time" | "radius";
  readonly limit: number;
  readonly observed: number;
  readonly closest: ClosestNodeEvidence;
}

export interface MovementFailure {
  readonly kind: "precondition_changed" | "operation_failed" | "no_progress" | "unstable";
  readonly stepId: string;
  readonly phase: MovementPhase;
  readonly observation: string;
}

export interface NavigationEvidence {
  readonly runId: string;
  readonly startedAtMs: number;
  readonly settledAtMs: number;
  readonly start: NavigationObservation;
  readonly final: NavigationObservation;
  readonly goalRevision: string;
  readonly searches: number;
  readonly searchSlices: number;
  readonly plans: number;
  readonly continuations: number;
  readonly replans: number;
  readonly movementAttempts: Readonly<Partial<Record<MovementKind, number>>>;
  readonly breaks: number;
  readonly placements: number;
  readonly activations: number;
  readonly expectedMutations: number;
  readonly conflictingMutations: number;
  readonly invalidatingChanges: number;
  readonly irrelevantChanges: number;
  readonly unrestoredPassages: readonly UnrestoredPassage[];
  readonly cleanup: {
    readonly listeners: number;
    readonly controls: number;
    readonly expectations: number;
  };
}

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
    }
  | { readonly kind: "movement_failed"; readonly movement: MovementFailure }
  | { readonly kind: "resource_changed"; readonly observation: string }
  | { readonly kind: "restoration_incomplete"; readonly observation: string }
  | { readonly kind: "internal_error"; readonly message: string };

export type NavigationOutcome =
  | { readonly kind: "completed"; readonly evidence: NavigationEvidence }
  | {
      /** The run was asked to stop; `reason` is what the aborting signal said. */
      readonly kind: "stopped";
      readonly reason: string;
      readonly evidence: NavigationEvidence;
    }
  | { readonly kind: "failed"; readonly failure: NavigationFailure; readonly evidence: NavigationEvidence };
