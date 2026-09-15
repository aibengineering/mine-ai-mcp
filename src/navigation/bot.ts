/**
 * The bot as the engine sees it: what it can observe of the bot, and what it
 * can do to it.
 *
 * This is the one port at the Mineflayer boundary. The run, search, and the
 * executor are written against it and never against a Mineflayer `Bot`,
 * which is what lets them run under a fake. The production implementation is
 * `mineflayer/bot.ts`; the test double is `test-support/navigation.ts`.
 * Nothing in this file may import Mineflayer.
 */
import type {
  MovementControlIntent,
  MovementController,
  MovementExecution,
  MovementSnapshot,
} from "./execution/movement-controller.js";
import type { AttemptToken } from "./execution/mutations.js";
import type { PlannedOperation, PlannedStep } from "./movements/movement.js";
import type { NavigationObservation, Position3, WorldView } from "./world/world.js";
export type { MovementExecution } from "./execution/movement-controller.js";

export interface EffectHandle {
  readonly completion: Promise<{ kind: "accepted" } | { kind: "failed"; observation: string }>;
  readonly issued: boolean;
  cancel(): void;
}
export type MovementPreparation =
  | { readonly kind: "ready"; readonly controller: MovementController }
  | { readonly kind: "completed"; readonly arrival: PlannedStep["validArrivals"][number] }
  | { readonly kind: "failed"; readonly observation: string };

export interface NavigationBot {
  /** One reading of the bot and what is around it; see `NavigationObservation`. */
  observe(): NavigationObservation;
  /** The per-physics-tick position and velocity sample that movement controllers steer by. */
  movementSnapshot(): MovementSnapshot;
  prepareMovement(
    step: PlannedStep,
    token: AttemptToken,
    signal: AbortSignal,
    execution: MovementExecution,
    snapshot: () => MovementSnapshot,
  ): Promise<MovementPreparation>;
  applyMovementSteering(target: Position3): void;
  applyMovementControls(intent: MovementControlIntent): void;
  subscribePhysicsTick(listener: () => void): () => void;
  describeMovementFailure(step: PlannedStep): string;
  startEffect(
    operation: Exclude<PlannedOperation, { kind: "move" }>,
    token: AttemptToken,
    signal: AbortSignal,
  ): EffectHandle;
  stabilize(signal: AbortSignal): Promise<{ kind: "stable" } | { kind: "failed"; observation: string }>;
  /** Fit the body inside its current stance before a neighbouring passage can close. */
  centerOnCell(cell: Position3, signal: AbortSignal): Promise<boolean>;
  /** Retain supported footing or the water column while calculating; release before moving. */
  holdPosition(world: WorldView): () => void;
  clearOwnedControls(): void;
  readonly ownedControlCount: number;
}
