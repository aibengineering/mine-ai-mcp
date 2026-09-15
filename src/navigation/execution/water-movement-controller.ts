import { COAST_TICKS, PLAYER_HALF_WIDTH } from "../../world/player-physics.js";
import { holdSwimDepth } from "../world/swimming.js";
import type { PlannedStep } from "../movements/movement.js";
import { horizontalControlsToward } from "../steering/local-steering.js";
import { blockPosition, samePosition, type Position3 } from "../world/world.js";
import type {
  MovementControlIntent,
  MovementController,
  MovementExecution,
  MovementSnapshot,
  MovementTick,
} from "./movement-controller.js";

/** Water has its own drag and lift; land braking cannot hold a swimming body. */
export class WaterMovementController implements MovementController {
  cancel() {
    return "stopped" as const;
  }
  readonly aim: Position3;
  readonly initialControls: MovementControlIntent;
  readonly #target: Position3;
  #ticks = 0;
  #depthTicks = 0;

  constructor(
    readonly step: PlannedStep,
    start: MovementSnapshot,
    readonly execution: MovementExecution,
    readonly waterRise: number,
  ) {
    const move = step.operations.find((operation) => operation.kind === "move");
    if (!move) throw new Error(`Step ${step.id} has no movement operation.`);
    this.#target = move.target;
    this.aim = { ...move.target, y: move.target.y + 1.6 };
    this.initialControls = this.#steer(start).controls;
  }

  #steer(snapshot: MovementSnapshot): Extract<MovementTick, { kind: "running" }> {
    const { position, velocity } = snapshot;
    // Prismarine water drag is 0.8: released horizontal speed coasts for
    // 0.8 / (1 - 0.8) ticks. Steer against that drift before reaching a corner.
    const coastTicks = snapshot.isInWater ? 4 : COAST_TICKS;
    const steeringTarget = {
      x: this.#target.x - velocity.x * coastTicks,
      y: this.#target.y,
      z: this.#target.z - velocity.z * coastTicks,
    };
    // Keep forward travel and current correction in the same steering vector.
    // A full-cell forward error overwhelms sideways correction; alternating
    // pure sideways alignment with forward travel can instead stall against
    // a diagonal current. Limit forward error to the body's corridor clearance.
    const clearance = 0.5 - PLAYER_HALF_WIDTH;
    if (this.step.from.z === this.step.to.z)
      steeringTarget.x = position.x + Math.max(-clearance, Math.min(clearance, steeringTarget.x - position.x));
    if (this.step.from.x === this.step.to.x)
      steeringTarget.z = position.z + Math.max(-clearance, Math.min(clearance, steeringTarget.z - position.z));
    const restingAtLanding =
      snapshot.onGround &&
      !snapshot.isInWater &&
      Math.hypot(position.x - this.#target.x, position.z - this.#target.z) <= 0.2;
    const offset = Math.hypot(steeringTarget.x - position.x, steeringTarget.z - position.z);
    // Surface only as far as the destination ceiling permits. Lifting into
    // its edge pins a swimmer in the adjoining falling column indefinitely.
    // At a solid ledge, release once the feet clear it to avoid a second hop.
    const jump = this.execution.swimDepth === undefined
      ? position.y < this.#target.y + (this.step.kind === "step_up" ? 0 : this.waterRise)
      : this.execution.swimGrounded && position.y >= this.execution.swimDepth - 0.05
        ? false : holdSwimDepth(position.y, velocity.y, this.execution.swimDepth);
    const released = { forward: false, back: false, left: false, right: false, sprint: false, sneak: false, jump };
    // A body resting on the landing has nowhere left to swim, and a swimmer
    // already within its own width of the point is holding a column, not
    // crossing water. Facing the residual from there turned the head every
    // tick; hold the heading and strafe against it instead.
    if (restingAtLanding) return { kind: "running", controls: released };
    if (offset <= PLAYER_HALF_WIDTH)
      return {
        kind: "running",
        controls: {
          ...released,
          ...(offset > 0.05 && horizontalControlsToward({ position, yaw: snapshot.yaw }, steeringTarget, 0.05)),
        },
      };
    return { kind: "running", steeringTarget, controls: { ...released, forward: true } };
  }

  advance(snapshot: MovementSnapshot): MovementTick {
    const feet = blockPosition(snapshot.position);
    const inCorridor = this.step.validArrivals.some(
      (cell) =>
        feet.x >= Math.min(this.step.from.x, cell.x) &&
        feet.x <= Math.max(this.step.from.x, cell.x) &&
        feet.z >= Math.min(this.step.from.z, cell.z) &&
        feet.z <= Math.max(this.step.from.z, cell.z),
    );
    if (!inCorridor) return { kind: "failed" };
    const arrival = this.step.validArrivals.find((cell) => samePosition(cell, feet));
    const centered = Math.hypot(snapshot.position.x - this.#target.x, snapshot.position.z - this.#target.z) <= 0.2;
    const settled = this.execution.end === "continuous" || Math.hypot(snapshot.velocity.x, snapshot.velocity.z) <= 0.03;
    const inDepth = this.execution.swimDepth === undefined ||
      (Math.abs(snapshot.position.y - this.execution.swimDepth) <= 0.18 &&
        (!this.execution.swimGrounded || snapshot.onGround));
    this.#depthTicks = inDepth ? this.#depthTicks + 1 : 0;
    const depthSettled = this.execution.swimDepth === undefined || this.#depthTicks >= 4;
    if (arrival && centered && settled && depthSettled && (snapshot.isInWater || snapshot.onGround))
      return { kind: "arrived", arrival };
    if (++this.#ticks >= Math.ceil(this.step.cost.expectedTicks) + 100) return { kind: "failed" };
    return this.#steer(snapshot);
  }
}
