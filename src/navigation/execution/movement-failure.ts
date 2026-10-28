import type { BlockPosition } from "../world/world.js";

/** The stage of one movement, in the order it runs. */
export type MovementPhase = "aligning" | "breaking" | "placing" | "activating" | "moving" | "confirming";

/** Why one movement stopped: what changed or failed, in which step and phase. */
export interface MovementFailure {
  readonly kind: "precondition_changed" | "operation_failed" | "no_progress" | "unstable";
  readonly stepId: string;
  readonly phase: MovementPhase;
  readonly observation: string;
  /** The world operation that failed, so a caller can blame the block it named. */
  readonly operation?: { readonly kind: "break" | "place" | "activate"; readonly position: BlockPosition };
}
