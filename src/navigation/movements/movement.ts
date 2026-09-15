/**
 * The movement vocabulary: what a transition is, what it requires, what it
 * costs, and what it predicts.
 *
 * These are planning facts. Nothing here touches the bot.
 */
import type { PlanningNode } from "../goals/goal.js";
import type { BlockObservation, BlockPosition, Position3 } from "../world/world.js";

export interface BlockMatcher {
  matches(block: BlockObservation): boolean;
  readonly description: string;
}

export interface WorldPrecondition {
  readonly position: BlockPosition;
  readonly expected: BlockMatcher;
}

export interface PlacementPlan {
  readonly position: BlockPosition;
  readonly stateId: number;
  readonly itemType: number;
  readonly support: BlockPosition;
  readonly face: BlockPosition;
}

export type MovementKind =
  | "walk"
  | "sprint"
  | "step_up"
  | "pillar"
  | "jump"
  | "sprint_jump"
  | "parkour"
  | "downward"
  | "bucket_drop"
  | "drop"
  | "swim"
  | "climb";

export type PlannedOperation =
  | {
      readonly kind: "break";
      readonly position: BlockPosition;
      readonly expectedStateId: number;
      readonly toolType: number | null;
      /**
       * Falling blocks this break brings down into its cell, lowest first. The
       * effect waits for each to land and breaks it again where it stands, so
       * the cell is clear when the operation completes.
       */
      readonly brings: readonly BlockPosition[];
    }
  | { readonly kind: "place"; readonly placement: PlacementPlan }
  | {
      readonly kind: "activate";
      readonly position: BlockPosition;
      readonly before: BlockMatcher;
      readonly after: BlockMatcher;
    }
  | { readonly kind: "move"; readonly movement: MovementKind; readonly target: Position3 };

export type PredictedWorldEffect =
  | { readonly kind: "break"; readonly position: BlockPosition; readonly stateId: 0 }
  | { readonly kind: "place"; readonly position: BlockPosition; readonly stateId: number }
  | { readonly kind: "activate"; readonly position: BlockPosition; readonly stateId: number };

export interface CostBreakdown {
  readonly expectedTicks: number;
  readonly breakPenalty: number;
  readonly placementPenalty: number;
  readonly hazardPenalty: number;
  readonly total: number;
}

export interface PlannedStep {
  readonly id: string;
  readonly kind: MovementKind;
  readonly from: BlockPosition;
  readonly to: BlockPosition;
  readonly validArrivals: readonly BlockPosition[];
  readonly preconditions: readonly WorldPrecondition[];
  readonly operations: readonly PlannedOperation[];
  readonly effects: readonly PredictedWorldEffect[];
  readonly cost: CostBreakdown;
}

export interface RoutePlan {
  readonly id: string;
  readonly goalRevision: string;
  readonly start: BlockPosition;
  readonly end: BlockPosition;
  /** The actual planning state at `end`, retained so a revised goal can judge this route honestly. */
  readonly endNode: PlanningNode;
  readonly steps: readonly PlannedStep[];
  /** Every cell the route's preconditions read, as packed cell keys. */
  readonly dependencies: ReadonlySet<number>;
  readonly totalCost: number;
  readonly complete: boolean;
}

export function stateMatcher(stateId: number): BlockMatcher {
  return {
    description: `state ${stateId}`,
    matches: (block) => block.kind === "loaded" && block.stateId === stateId,
  };
}

export const airMatcher: BlockMatcher = {
  description: "empty block",
  matches: (block) => block.kind === "loaded" && block.traits.empty,
};
