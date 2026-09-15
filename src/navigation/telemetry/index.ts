/**
 * What a navigation run reports as it goes: the event vocabulary and the sinks
 * that receive it. Events describe transitions; they never decide them.
 */
import type { MovementKind, RoutePlan } from "../movements/movement.js";
import type { BlockPosition, WorldChange } from "../world/world.js";
import type { MovementPhase, NavigationOutcome, SearchReason } from "../orchestration/outcome.js";
import type { NavigationCalculationFailure } from "../orchestration/process-events.js";
import type { PartialRouteCheckpoint, SearchEvidence } from "../search/search-result.js";
import type { SearchLimitEvidence } from "../orchestration/outcome.js";
export type NavigationEvent =
  | { readonly kind: "dive"; readonly runId: string; readonly atMs: number; readonly state: "breathing" | "resumed" | "released" }
  | { readonly kind: "search_finished"; readonly runId: string; readonly searchId: string; readonly atMs: number;
      readonly goal: string; readonly result: "complete" | "segment_ready" | "no_path" | "limit" | "stale" | "cancelled";
      readonly counts: SearchEvidence; readonly exhausted: "frontier" | "compute_time" | "radius" | null;
      readonly limit: SearchLimitEvidence | null;
      readonly interpretation: string }
  | { readonly kind: "run_started"; readonly runId: string; readonly atMs: number }
  | {
      readonly kind: "search_started";
      readonly runId: string;
      readonly searchId: string;
      readonly reason: SearchReason;
      /** The resolved goal's revision, which is also its label. */
      readonly goal: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "search_slice";
      readonly runId: string;
      readonly searchId: string;
      readonly atMs: number;
      readonly visited: number;
      readonly generated: number;
      /** Compute time this search has spent so far; visited over this is the live expansion rate. */
      readonly computeMs: number;
      readonly checkpoint?: PartialRouteCheckpoint;
    }
  | {
      readonly kind: "route_committed";
      readonly runId: string;
      readonly planId: string;
      readonly atMs: number;
      readonly steps: number;
      /** Immutable execution facts; matchers serialize their descriptions, not functions. */
      readonly plan: Pick<RoutePlan, "start" | "end" | "steps" | "complete">;
    }
  | {
      readonly kind: "step_started";
      readonly runId: string;
      readonly planId: string;
      readonly stepId: string;
      readonly movement: MovementKind;
      readonly atMs: number;
    }
  | {
      readonly kind: "step_phase";
      readonly runId: string;
      readonly stepId: string;
      readonly phase: MovementPhase;
      readonly atMs: number;
    }
  | {
      readonly kind: "step_completed";
      readonly runId: string;
      readonly stepId: string;
      readonly movement: MovementKind;
      readonly atMs: number;
    }
  | {
      readonly kind: "step_failed";
      readonly runId: string;
      readonly stepId: string;
      readonly movement: MovementKind;
      readonly observation: string;
      readonly atMs: number;
    }
  | {
      /** The body was found held under a ceiling it does not fit beneath; `released` says whether the run broke it. */
      readonly kind: "pinned_body";
      readonly runId: string;
      readonly cell: BlockPosition;
      readonly released: boolean;
      readonly observation: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "world_change";
      readonly runId: string;
      readonly classification: "expected" | "conflicting" | "invalidating" | "irrelevant";
      readonly change: WorldChange;
      readonly atMs: number;
    }
  | {
      /** A plan-ahead result was discarded because the walked segment did not end where that search assumed. */
      readonly kind: "continuation_abandoned";
      readonly runId: string;
      readonly assumed: BlockPosition;
      readonly actual: BlockPosition;
      readonly observation: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "goal_arrived";
      readonly runId: string;
      readonly result: "completed" | "continue";
      readonly atMs: number;
    }
  | {
      readonly kind: "calculation_failed";
      readonly runId: string;
      readonly failure: NavigationCalculationFailure["kind"];
      readonly result: "completed" | "continue";
      readonly atMs: number;
    }
  | { readonly kind: "cleanup_completed"; readonly runId: string; readonly atMs: number }
  | {
      readonly kind: "run_settled";
      readonly runId: string;
      readonly atMs: number;
      readonly outcome: NavigationOutcome["kind"];
    };
export interface TelemetrySink {
  emit(event: NavigationEvent): void;
  error(runId: string, cause: unknown): void;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A navigation event as the run states it: what happened, without the run id and time it is stamped with. */
export type RunEvent = DistributiveOmit<NavigationEvent, "runId" | "atMs">;

/** One run's view of a sink. Every event is stamped with the run and the time, so callers say only what happened. */
export interface RunTelemetry {
  emit(event: RunEvent): void;
  error(cause: unknown): void;
}

export function forRun(sink: TelemetrySink, runId: string): RunTelemetry {
  return {
    // The omit is distributive, so restoring the two stamped fields restores a member of the union.
    emit: (event) => sink.emit({ ...event, runId, atMs: Date.now() } as NavigationEvent),
    error: (cause) => sink.error(runId, cause),
  };
}
export const silentTelemetry: TelemetrySink = { emit: () => undefined, error: () => undefined };
export class MemoryTelemetry implements TelemetrySink {
  readonly events: NavigationEvent[] = [];
  readonly errors: unknown[] = [];
  emit(event: NavigationEvent) {
    this.events.push(event);
  }
  error(_runId: string, cause: unknown) {
    this.errors.push(cause);
  }
}
