/**
 * A goal is the question search is trying to answer.
 *
 * A goal can move — an entity goal follows its entity — so it is never judged
 * directly. Resolving it against one observation freezes the question: its
 * revision, its heuristic, and its satisfaction predicate then hold for that
 * observation, so a search slice cannot be judged against a goal that moved
 * underneath it.
 */
import type { BlockPosition, NavigationObservation, WorldView } from "../world/world.js";
import type { GeneratedMovement, GenerationContext, PlanningState } from "../movements/catalogue.js";
import type { DigContext } from "../movements/policy.js";
export interface PlanningNode {
  readonly feet: BlockPosition;
  readonly remainingScaffolds: number;
  readonly overlayId: string;
}

export type GoalEndPredicate = (node: PlanningNode, observation: NavigationObservation) => boolean;

export type ResolvedGoal =
  | {
      readonly kind: "active";
      /**
       * Changes exactly when this goal's answer could change, and never
       * otherwise. A static goal's revision is its name; an entity goal's is
       * the entity's id and cell; a composite's is its branches' joined.
       *
       * It is the goal's part of the search identity, which is how the run
       * tells a new question from one it has already asked, and it is the
       * label a search reports, so it should read as one.
       */
      readonly revision: string;
      heuristic(node: PlanningNode): number;
      /** Search supplies predicted edits; arrival supplies the observed world. */
      isSatisfied(node: PlanningNode, world: WorldView): boolean;
      /** Work that completes this goal from a candidate stance, priced alongside travel. */
      finish?(state: PlanningState, context: GenerationContext, digContext: DigContext): GeneratedMovement | null;
    }
  | { readonly kind: "invalid"; readonly observation: string };

export interface Goal {
  resolve(observation: NavigationObservation): ResolvedGoal;
}
