/**
 * Movement controllers: which controls to hold on this physics tick to carry
 * out one planned step.
 *
 * A controller is created when a step's move begins, from the snapshot the
 * previous step handed over, and is then advanced once per tick with a new
 * snapshot. It answers `running` with a control intent and a steering target,
 * `arrived` with the cell it landed in, or `failed`. It never decides whether
 * the step belonged in the route; that was search's job.
 *
 * `WaterMovementController` owns swimming and transitions through water.
 * `PlannedMovementController` handles walking, sprinting, drops, climbing, step-ups, and
 * pillaring, with braking distance and arrival tolerance derived from the
 * observed velocity. `GapController` handles the jumps as a run-up, launch,
 * flight, landing sequence, because a standing jump cannot clear the spans
 * the catalogue offers.
 */
import { AIR_COAST_TICKS, COAST_TICKS, PLAYER_HALF_WIDTH, stoppingDistance } from "../../world/player-physics.js";
import type { PlannedOperation, PlannedStep } from "../movements/movement.js";
import { horizontalControlsToward } from "../steering/local-steering.js";
import { navigationFeet } from "../world/block-geometry.js";
import { type BlockPosition, type Position3, blockPosition, samePosition } from "../world/world.js";
import { WaterMovementController } from "./water-movement-controller.js";

export type MovementExecution = Readonly<{
  /** Exact underwater feet height; omitted for existing surface/shore movement. */
  swimDepth?: number;
  swimGrounded?: boolean;
  end: "settled" | "continuous";
  /** Live equivalent of Baritone MovementAscend.headBonkClear(). */
  stepUpHeadBonkClear?: boolean;
  /** Earlier launch required when the run-up would put feet on a damaging gap floor. */
  gapTakeoffPosition?: number;
}>;

export interface MovementSnapshot {
  readonly position: Position3;
  /**
   * Blocks travelled per tick, as the physics engine last applied it.
   *
   * Controllers used to derive this themselves by differencing positions
   * across their own ticks, which works only inside one controller's lifetime.
   * A controller constructed mid-slide measured nothing and reasoned as though
   * the bot were standing still, so every movement began by assuming rest and
   * the executor had to stop the bot between steps to make that true. Carrying
   * the real figure is what lets a movement inherit the speed it was handed.
   */
  readonly velocity: Position3;
  readonly onGround: boolean;
  readonly isInWater: boolean;
  /** The feet are in a ladder or vine, so physics is the climbable's, not free fall's. */
  readonly climbing: boolean;
  /**
   * Look direction in radians, as Mineflayer holds it. A correction inside a
   * cell is resolved against this heading into strafing inputs, so it never
   * turns the head.
   */
  readonly yaw: number;
}

export type MovementControl = "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak";

export type MovementControlIntent = Readonly<Record<MovementControl, boolean>>;

export type MovementTick =
  | {
      readonly kind: "running";
      readonly controls: MovementControlIntent;
      /** Recompute the horizontal heading toward this point for this tick. */
      readonly steeringTarget?: Position3;
    }
  | { readonly kind: "arrived"; readonly arrival: BlockPosition }
  | { readonly kind: "failed" };

export const releasedControls: MovementControlIntent = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sprint: false,
  sneak: false,
};

/**
 * Strafe toward a point inside the current cell without turning the head.
 *
 * The heading stays where the movement left it and the correction is resolved
 * against it into forward, back, left, and right, from where the body will be
 * once its momentum has coasted. Steering by yaw did this job before, and a
 * centre a few centimetres behind the body reversed the whole look direction
 * on every drop landing and overshot step-up: that was the head spin.
 */
export function recenterControls(
  snapshot: MovementSnapshot,
  target: Position3,
  tolerance: number,
  coastTicks = COAST_TICKS,
): MovementControlIntent {
  const coasted = {
    x: snapshot.position.x + snapshot.velocity.x * coastTicks,
    y: snapshot.position.y,
    z: snapshot.position.z + snapshot.velocity.z * coastTicks,
  };
  if (Math.hypot(target.x - coasted.x, target.z - coasted.z) <= tolerance) return releasedControls;
  return {
    ...releasedControls,
    ...horizontalControlsToward({ position: coasted, yaw: snapshot.yaw }, target, 0.05),
  };
}

function running(controls: MovementControlIntent, steeringTarget: Position3 | undefined): MovementTick {
  return steeringTarget ? { kind: "running", controls, steeringTarget } : { kind: "running", controls };
}

export interface MovementController {
  readonly aim: Position3;
  readonly initialControls: MovementControlIntent;
  advance(snapshot: MovementSnapshot): MovementTick;
  /** Committed movement retains its controls until it can relinquish a supported body safely. */
  cancel(snapshot: MovementSnapshot): "stopped" | "settling";
}

type GapMotion = Readonly<{
  projected: number;
}>;

type GapPhase =
  | { readonly kind: "settling" }
  | { readonly kind: "approaching" }
  | { readonly kind: "launching" }
  | { readonly kind: "airborne" }
  | { readonly kind: "landed"; readonly atTick: number };

function observedArrival(
  position: Position3,
  arrivals: readonly BlockPosition[],
  onGround: boolean,
): BlockPosition | undefined {
  const cell = blockPosition(position);
  return arrivals.find(
    (arrival) =>
      samePosition(arrival, cell) ||
      (onGround &&
        cell.x === arrival.x &&
        cell.z === arrival.z &&
        position.y >= arrival.y - 0.5 &&
        position.y < arrival.y),
  );
}

class PlannedMovementController implements MovementController {
  #cancelling = false;
  cancel(snapshot: MovementSnapshot): "stopped" | "settling" {
    if (snapshot.isInWater || snapshot.climbing) return "stopped";
    const coast = blockPosition({
      ...snapshot.position,
      x: snapshot.position.x + snapshot.velocity.x * COAST_TICKS,
      z: snapshot.position.z + snapshot.velocity.z * COAST_TICKS,
    });
    if (snapshot.onGround && [this.step.from, ...this.step.validArrivals].some((at) => samePosition(at, coast)))
      return "stopped";
    // Drops and step-ups also own an airborne body. Combat cannot take its
    // steering away before it reaches the supported arrival it was moving to.
    this.#cancelling = true;
    return "settling";
  }
  readonly aim: Position3;
  readonly initialControls: MovementControlIntent;
  readonly #target: Position3;
  readonly #start: Position3;
  readonly #horizontalDistance: number;
  readonly #direction: { readonly x: number; readonly z: number } | null;
  readonly #movementDeadline: number;
  #controls: MovementControlIntent;
  #lastMotionTick = 0;
  #tick = 0;
  #approachReleased = false;
  #stepUpJumpRearmed = false;
  #water: WaterMovementController | null = null;

  constructor(
    readonly step: PlannedStep,
    start: MovementSnapshot,
    readonly execution: MovementExecution,
    readonly waterRise: number,
  ) {
    const move = step.operations.find(
      (operation): operation is Extract<PlannedOperation, { kind: "move" }> => operation.kind === "move",
    );
    if (!move) throw new Error(`Step ${step.id} has no movement operation.`);
    this.#target = move.target;
    // Progress is measured along the planned line between the two cell
    // centres, not from wherever the body was when the step began. A body
    // handed over past the previous centre otherwise got a direction pointing
    // backwards, faced it, and walked back to a centre it had already crossed.
    this.#start = { x: step.from.x + 0.5, y: start.position.y, z: step.from.z + 0.5 };
    this.#horizontalDistance = Math.hypot(this.#target.x - this.#start.x, this.#target.z - this.#start.z);
    this.#direction =
      this.#horizontalDistance === 0
        ? null
        : {
            x: (this.#target.x - this.#start.x) / this.#horizontalDistance,
            z: (this.#target.z - this.#start.z) / this.#horizontalDistance,
          };
    this.#movementDeadline = Math.ceil(step.cost.expectedTicks) + 100;
    this.aim =
      step.kind === "drop"
        ? {
            x: (step.from.x + 0.5) * 0.17 + this.#target.x * 0.83,
            y: this.#target.y + 1,
            z: (step.from.z + 0.5) * 0.17 + this.#target.z * 0.83,
          }
        : { x: this.#target.x, y: this.#target.y + 1, z: this.#target.z };
    const initialControls: MovementControlIntent = {
      forward: this.#direction !== null,
      back: false,
      left: false,
      right: false,
      // On a ladder or vine, jump climbs at 0.2 blocks a tick and no input
      // descends at 0.15 (prismarine-physics `ladderClimbSpeed` and
      // `ladderMaxSpeed`). A descending climb that held jump only rose.
      jump: step.kind === "climb" ? step.to.y > step.from.y : step.kind === "step_up" || step.kind === "pillar",
      sprint: step.kind === "sprint" || step.kind === "sprint_jump",
      sneak: false,
    };
    this.initialControls =
      step.kind === "step_up"
        ? this.#stepUpControls(start)
        : step.kind === "climb" && step.to.y > step.from.y
          ? this.#upwardClimbControls(start)
          : initialControls;
    this.#controls = this.initialControls;
  }

  /** Keep inherited approach or knockback velocity inside an ascending climbable's cell. */
  #upwardClimbControls(snapshot: MovementSnapshot): MovementControlIntent {
    return {
      ...recenterControls(snapshot, this.#target, 0.05, AIR_COAST_TICKS),
      // Prismarine 1.21.4's `climbUsingJump` raises regular vines and ladders
      // from jump alone. Horizontal collision is an alternative trigger, not
      // a requirement, so centring must preserve jump rather than press a wall.
      jump: true,
    };
  }

  #projected(snapshot: MovementSnapshot): number {
    if (!this.#direction) return 0;
    return (
      (snapshot.position.x - this.#start.x) * this.#direction.x +
      (snapshot.position.z - this.#start.z) * this.#direction.z
    );
  }

  /**
   * Face the target only while it is still ahead of the body.
   *
   * A yaw computed from the residual to a centre the body has reached is
   * noise, and one computed from a centre a few centimetres behind is a full
   * reversal; the recorded head spins were both. Baritone never steers from
   * this position because its movements end the moment the feet enter the
   * cell; here the heading is simply held.
   */
  #steeringTarget(snapshot: MovementSnapshot): Position3 | undefined {
    if (!this.#direction) return undefined;
    return this.#horizontalDistance - this.#projected(snapshot) > PLAYER_HALF_WIDTH ? this.#target : undefined;
  }

  #stepUpControls(snapshot: MovementSnapshot): MovementControlIntent {
    if (!this.#direction) {
      return { ...releasedControls, jump: snapshot.position.y < this.#target.y };
    }
    const forwardSpeed = snapshot.velocity.x * this.#direction.x + snapshot.velocity.z * this.#direction.z;
    const remaining = this.#horizontalDistance - this.#projected(snapshot);
    const coast = Math.max(0, forwardSpeed) * COAST_TICKS;
    // Airborne past the tread centre, strafe back over it before landing: a
    // one-block shelf can have lava beyond. On the ground the arrival check
    // decides, and a landing inside the cell needs no correction at all.
    if (remaining < -0.08 && !snapshot.onGround) return recenterControls(snapshot, this.#target, 0.08);
    const perpendicular = { x: -this.#direction.z, z: this.#direction.x };
    const sideDistance = Math.abs(
      (snapshot.position.x - this.#start.x) * perpendicular.x + (snapshot.position.z - this.#start.z) * perpendicular.z,
    );
    const lateralMotion = snapshot.velocity.x * perpendicular.x + snapshot.velocity.z * perpendicular.z;
    const alignedForConstrainedJump = remaining <= 1.2 && sideDistance <= 0.2 && Math.abs(lateralMotion) <= 0.1;
    return {
      ...releasedControls,
      // The rise delays arrival after the bot has crossed the target's
      // horizontal boundary. Spend inherited speed first instead of holding
      // forward for that whole delay.
      forward: remaining > Math.max(0.08, coast),
      // Release jump once the feet reach the target height. Holding it through
      // touchdown starts a second hop before a settled final step can stop.
      jump:
        snapshot.position.y < this.#target.y &&
        (this.execution.stepUpHeadBonkClear !== false || alignedForConstrainedJump),
    };
  }

  advance(snapshot: MovementSnapshot): MovementTick {
    const { position } = snapshot;
    if (snapshot.isInWater || this.#water) {
      this.#water ??= new WaterMovementController(this.step, snapshot, this.execution, this.waterRise);
      return this.#water.advance(snapshot);
    }
    // A drop with no safe cell beyond its landing cannot hand off momentum.
    // The generated obsidian approach turned beside lava while still falling
    // and its hitbox crossed that otherwise correctly excluded next cell.
    const mustSettle =
      this.#cancelling ||
      this.execution.end === "settled" ||
      (this.step.kind === "drop" && this.step.validArrivals.length === 1);
    const supported = snapshot.onGround || snapshot.isInWater;
    const settled =
      this.step.kind === "step_up"
        ? supported
        : !mustSettle || this.step.kind === "swim" || this.step.kind === "climb" || supported;
    // A drop through a ladder or vine descends at the climbable's pace, and any
    // horizontal push against a wall there becomes a climb: prismarine-physics
    // sets the climb speed on a horizontal collision while on a climbable.
    // Observed at 98,-2,89: handed over mid-slide, the bot pushed toward the
    // next cell, met netherrack at head height, and rode the vine five blocks
    // up onto a slab. Let the climbable lower the bot before pushing on, and do
    // not count a cell as reached while still sliding through it.
    const slidingDownClimbable =
      this.step.kind === "drop" && snapshot.climbing && !snapshot.onGround && position.y > this.#target.y + 0.05;
    const arrival = slidingDownClimbable
      ? undefined
      : observedArrival(position, this.step.validArrivals, snapshot.onGround);
    const horizontalMotion = Math.hypot(snapshot.velocity.x, snapshot.velocity.z);
    const motion = Math.hypot(snapshot.velocity.x, snapshot.velocity.y, snapshot.velocity.z);
    if (motion > 0.01) this.#lastMotionTick = this.#tick;
    if (this.step.kind === "climb" && this.step.to.y > this.step.from.y) {
      const cell = blockPosition(position);
      if (!snapshot.climbing && (cell.x !== this.step.from.x || cell.z !== this.step.from.z)) {
        return { kind: "failed" };
      }
      this.#controls = this.#upwardClimbControls(snapshot);
    }
    // A lateral step or a jump whose body has caught a ladder or vine in mid
    // air is no longer the movement it was planned as. The climbable clamps
    // the descent to 0.15 a tick and leaves the horizontal speed untouched, so
    // whatever was still pushing forward carries the body across the column's
    // one block of width and out the open side, where the fall resumes from
    // whatever height the column had reached. Observed live on 2026-09-13 in
    // incidents bd95619b and 97c795ac: a nineteen-block fall and a five-block
    // one, both with forward and sprint held through the whole contact. Spend
    // the inherited speed and hold the body over the column instead; the
    // deadline still ends the step, from a hanging body rather than a falling
    // one. `drop` and `climb` own their own climbable handling below and are
    // left to it, and a body on the ground in vines is simply walking.
    // The gap jumps are `GapController`'s, and it holds the same line there.
    const hanging =
      !snapshot.onGround && snapshot.climbing && (this.step.kind === "walk" || this.step.kind === "sprint");
    if (arrival && settled && (!mustSettle || horizontalMotion <= 0.03)) {
      return { kind: "arrived", arrival };
    }
    // A descent into a ladder or vine from the block over it. The body can
    // stand on a ladder's own plate against the wall: the plate is three
    // sixteenths deep and the body 0.3 wide each side, so it clears the plate
    // only within an eighth of a block of the column centre, and was observed
    // still standing on it at 6.49 over a plate reaching 6.1875. Walk it to
    // the centre with no tolerance at all until the column takes it.
    // Baritone's MovementDownward likewise `moveTowards` the cell below after
    // ten ticks without progress. Once the column has the body, hold it over
    // the column centre by strafing against its air coast: the momentum of
    // stepping in carried a body sliding down a vine a whole cell sideways,
    // out of the column's open side, and into a four-block fall. A body that
    // has landed below the next cell has fallen out; the descent is over.
    if (this.step.kind === "climb" && this.step.to.y < this.step.from.y) {
      if (snapshot.onGround && !snapshot.climbing && position.y < this.#target.y - 0.5) return { kind: "failed" };
      this.#controls = snapshot.onGround
        ? {
            ...releasedControls,
            ...horizontalControlsToward({ position, yaw: snapshot.yaw }, this.#target, 0),
          }
        : recenterControls(snapshot, this.#target, 0.05, AIR_COAST_TICKS);
    }
    if (this.#direction) {
      const projected = this.#projected(snapshot);
      // Overshoot is what a hanging body is being pulled back from, so it is
      // not grounds to abandon it mid-column and let the fall resume.
      if (
        !hanging &&
        this.step.kind !== "drop" &&
        this.step.kind !== "step_up" &&
        projected > this.#horizontalDistance + 1
      ) {
        return { kind: "failed" };
      }
      const reachedDropEdge =
        this.step.kind === "drop" &&
        projected >= Math.max(0, this.#horizontalDistance - 0.5) &&
        (this.step.from.y - this.step.to.y <= 1 || position.y < this.#start.y - 0.5);
      const passedDrop = this.step.kind === "drop" && projected > this.#horizontalDistance + 1;
      const forwardSpeed = snapshot.velocity.x * this.#direction.x + snapshot.velocity.z * this.#direction.z;
      const reachedBrakingPoint =
        (this.step.kind !== "drop" || this.step.validArrivals.length === 1) &&
        projected >= this.#horizontalDistance - stoppingDistance({ x: Math.max(0, forwardSpeed), y: 0, z: 0 });
      if (mustSettle && !this.#approachReleased && (reachedDropEdge || passedDrop || reachedBrakingPoint)) {
        this.#controls = releasedControls;
        this.#approachReleased = true;
      }
      if (this.step.kind === "step_up") this.#controls = this.#stepUpControls(snapshot);
    }
    // Releasing the approach early is deliberate: it stops a drop overshooting
    // its landing. It assumes the remaining momentum carries the bot over the
    // takeoff lip, and when that coast falls short the bot stalls with its
    // hitbox still resting on the old block and never falls at all — observed
    // at x 18.25 for a cell centred on 18.5, with both target cells already
    // excavated to air. Push again rather than wait out the tick ceiling.
    if (
      this.#approachReleased &&
      this.step.kind === "drop" &&
      snapshot.onGround &&
      position.y >= this.step.from.y - 0.05 &&
      horizontalMotion < 0.02 &&
      !arrival
    ) {
      this.#controls = { ...releasedControls, forward: true };
      this.#approachReleased = false;
    }
    // Coasting into a drop's landing is a per-tick decision, not a permanent
    // release. A fortress fireball hit after braking and the latched neutral
    // controls watched the body drift sideways into lava. Recenter in air as
    // the stationary hold does, by strafing, without sneaking away the
    // corrective input.
    if (this.#approachReleased && this.step.kind === "drop") {
      this.#controls = snapshot.onGround ? releasedControls : recenterControls(snapshot, this.#target, 0.15);
    }
    // Last word for the tick: the braking release above would drop the
    // corrective strafe that keeps a hanging body over its column.
    if (hanging) this.#controls = recenterControls(snapshot, this.#target, 0.05, AIR_COAST_TICKS);
    const stopped = settled && this.#tick - this.#lastMotionTick >= 5;
    if (
      stopped &&
      this.step.kind === "step_up" &&
      !this.#stepUpJumpRearmed &&
      snapshot.onGround &&
      position.y < this.#target.y - 0.5
    ) {
      // A held jump can fail to fire at the face after a long continuous
      // approach. A replacement controller succeeds because control cleanup
      // supplies a released tick before pressing jump again. Reproduce that
      // physical reset here once, without throwing away and rebuilding the
      // otherwise-valid route.
      this.#controls = { ...this.#stepUpControls(snapshot), jump: false };
      this.#stepUpJumpRearmed = true;
      this.#lastMotionTick = this.#tick;
      this.#tick += 1;
      return running(this.#controls, this.#steeringTarget(snapshot));
    }
    this.#tick += 1;
    if (stopped || this.#tick >= this.#movementDeadline) return { kind: "failed" };
    return running(
      slidingDownClimbable ? { ...this.#controls, forward: false, sprint: false } : this.#controls,
      this.#steeringTarget(snapshot),
    );
  }
}

/**
 * Gap crossings: `jump`, `sprint_jump`, and `parkour`.
 *
 * The shared controller enables jump on the first tick and holds it, which
 * launches from a standstill in the middle of the takeoff block. A standing
 * jump clears little more than one block, so the longer spans could not be
 * flown at all — the planner offered a four-block parkour edge that execution
 * had no way to complete.
 *
 * This controller gives that crossing four explicit phases. The approach owns
 * run-up, launch holds jump until the feet actually leave the support, flight
 * releases it, and landing settles or hands the observed momentum onward.
 * Every running phase also emits the landing as its steering target. The
 * bot port turns toward it again on every physics tick, matching Baritone's
 * `moveTowards(dest)` loop instead of treating the heading chosen before
 * takeoff as immutable.
 */
class GapController implements MovementController {
  #cancelling = false;
  cancel(snapshot: MovementSnapshot): "stopped" | "settling" {
    if (this.#phase.kind === "settling") return "stopped";
    if (this.#phase.kind === "approaching") {
      const coast = blockPosition({
        ...snapshot.position,
        x: snapshot.position.x + snapshot.velocity.x * COAST_TICKS,
        z: snapshot.position.z + snapshot.velocity.z * COAST_TICKS,
      });
      // A contact observer can cancel before this tick advances the launch
      // phase. Releasing at the lip then carries the player into the gap.
      // Stop only while the remaining coast stays on the takeoff block;
      // otherwise retain the run-up, jump, and landing as one movement.
      if (snapshot.onGround && samePosition(coast, this.step.from)) return "stopped";
    }
    this.#cancelling = true;
    return "settling";
  }
  readonly aim: Position3;
  readonly initialControls: MovementControlIntent;
  readonly #target: Position3;
  readonly #start: Position3;
  readonly #direction: { readonly x: number; readonly z: number } | null;
  readonly #span: number;
  readonly #rises: boolean;
  readonly #sprints: boolean;
  readonly #movementDeadline: number;
  #phase: GapPhase;
  #lastMotionTick = 0;
  #tick = 0;

  constructor(
    readonly step: PlannedStep,
    start: MovementSnapshot,
    readonly execution: MovementExecution,
  ) {
    const move = step.operations.find(
      (operation): operation is Extract<PlannedOperation, { kind: "move" }> => operation.kind === "move",
    );
    if (!move) throw new Error(`Step ${step.id} has no movement operation.`);
    this.#target = move.target;
    this.#start = { x: step.from.x + 0.5, y: step.from.y, z: step.from.z + 0.5 };
    const dx = this.#target.x - this.#start.x;
    const dz = this.#target.z - this.#start.z;
    this.#span = Math.hypot(dx, dz);
    this.#direction = this.#span === 0 ? null : { x: dx / this.#span, z: dz / this.#span };
    this.#rises = step.to.y > step.from.y;
    // Sprint is earned by the span, not granted to every gap.
    //
    // Holding it unconditionally flew a two-block hop with the same energy as
    // a four-block parkour, and the surplus is spent past the landing: over
    // one-block pads the bot touches down clean and skids off the far lip.
    // Baritone's MovementParkour gates it the same way — `dist >= 4 || ascend`
    // — and prices the shorter spans as walking jumps.
    this.#sprints = this.#span >= 4 || this.#rises;
    this.#movementDeadline = Math.ceil(step.cost.expectedTicks) + 100;
    this.aim = { x: this.#target.x, y: this.#target.y + 1.6, z: this.#target.z };
    this.#phase = start.onGround || start.isInWater ? { kind: "approaching" } : { kind: "settling" };
    // A preceding descent can hand off while the bot is still falling into
    // this movement's takeoff cell. Wait for that support before starting the
    // run-up; pushing forward here walks the airborne bot off its only pad.
    this.initialControls = this.#phase.kind === "settling" ? releasedControls : this.#advanceApproach(start);
  }

  get #flightControls(): MovementControlIntent {
    return { ...releasedControls, forward: true, sprint: this.#sprints };
  }

  #motion(snapshot: MovementSnapshot): GapMotion | null {
    if (!this.#direction) return null;
    return {
      projected:
        (snapshot.position.x - this.#start.x) * this.#direction.x +
        (snapshot.position.z - this.#start.z) * this.#direction.z,
    };
  }

  /** The landing, while it is still ahead of the body; see `PlannedMovementController`. */
  #steeringTarget(motion: GapMotion): Position3 | undefined {
    return this.#span - motion.projected > PLAYER_HALF_WIDTH ? this.#target : undefined;
  }

  #readyToTakeOff(snapshot: MovementSnapshot, motion: GapMotion): boolean {
    if (!snapshot.onGround || navigationFeet(snapshot.position, true).y < this.step.from.y) return false;
    // Baritone uses the source cell as the launch clock. Rising parkour jumps
    // when the feet enter the first gap cell; a flat three-block crossing waits
    // until 0.7 blocks from the source centre. At both points the player's
    // 0.6-block-wide hitbox is still partly supported by the takeoff block.
    const takeoffPosition = this.execution.gapTakeoffPosition ?? (!this.#rises && this.#span === 3 ? 0.7 : 0.5);
    // Launch from the observed source-cell boundary. Predicting the next tick
    // from inherited speed made fast handoffs jump before the player reached
    // that boundary, lengthening a short ascending parkour enough to miss its
    // natural-terrain landing. Baritone tests the current player-feet cell;
    // it does not forecast the next position.
    return motion.projected >= takeoffPosition;
  }

  #advanceApproach(snapshot: MovementSnapshot): MovementControlIntent {
    const motion = this.#motion(snapshot);
    if (!motion) return releasedControls;
    if (!this.#readyToTakeOff(snapshot, motion)) return this.#flightControls;
    this.#phase = { kind: "launching" };
    return { ...this.#flightControls, jump: true };
  }

  advance(snapshot: MovementSnapshot): MovementTick {
    const { position } = snapshot;
    const motionState = this.#motion(snapshot);
    if (!motionState) return { kind: "failed" };
    const horizontalSpeed = Math.hypot(snapshot.velocity.x, snapshot.velocity.z);
    const motion = Math.hypot(snapshot.velocity.x, snapshot.velocity.y, snapshot.velocity.z);
    if (motion > 0.01) this.#lastMotionTick = this.#tick;

    const grounded = snapshot.onGround || snapshot.isInWater;
    if (this.#phase.kind === "settling") {
      if (position.y < this.#start.y - 0.5) return { kind: "failed" };
      if (!grounded) {
        this.#tick += 1;
        if (this.#tick - this.#lastMotionTick >= 10 || this.#tick >= this.#movementDeadline) return { kind: "failed" };
        return { kind: "running", controls: releasedControls };
      }
      this.#phase = { kind: "approaching" };
    }
    const arrival = observedArrival(position, this.step.validArrivals, snapshot.onGround);
    if (this.#phase.kind === "launching" && (!grounded || position.y > this.#start.y + 0.05))
      this.#phase = { kind: "airborne" };
    // A parkour arc can brush down onto safe terrain before its declared
    // destination. Baritone keeps MOVE_FORWARD held in that state and walks
    // the remaining block. Treating any grounded contact as the terminal
    // landing stopped a natural-world four-block crossing one cell early.
    // The body's edge can land while its centre is just beyond the cell.
    // Once past the landing centre, that contact must brake and recenter;
    // continuing forward walks the remaining support out from under the body.
    if (
      this.#phase.kind === "airborne" &&
      grounded &&
      (arrival || this.#cancelling || motionState.projected >= this.#span)
    )
      this.#phase = { kind: "landed", atTick: this.#tick };
    // A settled crossing still has to stop before it hands off.
    //
    // Declaring arrival the tick the feet enter the cell is what Baritone does;
    // there the skid becomes the next movement's physical starting condition.
    // Handing that skid to a controller which assumes rest put a `step_up` into
    // a lava pit. Settled ends retain the velocity gate; continuous ends hand
    // the observed vector to the next controller to accept or normalize.
    const stopped = (!this.#cancelling && this.execution.end === "continuous") || horizontalSpeed <= 0.05;
    const coastArrival = observedArrival(
      {
        ...position,
        x: position.x + snapshot.velocity.x * COAST_TICKS,
        z: position.z + snapshot.velocity.z * COAST_TICKS,
      },
      this.step.validArrivals,
      snapshot.onGround,
    );
    // A slow landing on the cell's lip can still coast into its neighbour.
    // Wait for that actual arrival so the goal can replan instead of completing early.
    const settledArrival = arrival && coastArrival && samePosition(arrival, coastArrival);
    if (
      this.#phase.kind === "landed" &&
      stopped &&
      (this.#cancelling ? grounded : this.execution.end === "continuous" ? arrival : settledArrival)
    )
      return { kind: "arrived", arrival: arrival ?? blockPosition(position) };

    this.#tick += 1;
    if (this.#tick - this.#lastMotionTick >= 10 || this.#tick >= this.#movementDeadline) return { kind: "failed" };
    // A jump that is going to miss says so in ticks rather than waiting out the
    // ceiling. Falling keeps the stall timer alive, so without these two bounds
    // a blown jump over lava burned the full sixty ticks — three seconds of
    // standing in the fire before the route was allowed to replan.
    // Grounded fractional floors use the planner's feet node. Soul sand is
    // valid support, not a failed takeoff 0.125 blocks below an integer y.
    const belowTakeoff = snapshot.onGround
      ? navigationFeet(position, true).y < this.step.from.y
      : position.y < this.#start.y - 0.05;
    if (this.#phase.kind === "approaching" && belowTakeoff) return { kind: "failed" };
    // A jump whose arc has caught a ladder or vine is no longer a jump. The
    // climbable clamps the descent to 0.15 a tick and leaves the horizontal
    // speed alone, so the forward and sprint that flight holds carry the body
    // across the column's one block of width and out the far side, where the
    // fall resumes from whatever height the column had reached. Observed live
    // on 2026-09-13, incident bd95619b: a four-block parkour caught a vine at
    // x=72.97, held both controls through seven ticks of contact, left the
    // column at x=74.34 and fell nineteen blocks. Spend the inherited speed on
    // holding the body over the column instead. Overshoot is what that pulls
    // back from, so it is not grounds to abandon the body mid-column either;
    // the deadline still ends the step, from a body in the vines.
    const hanging = !grounded && snapshot.climbing;
    if (
      (this.#phase.kind === "launching" || this.#phase.kind === "airborne") &&
      !hanging &&
      position.y < Math.min(this.#start.y, this.#target.y) - 0.5
    )
      return { kind: "failed" };
    if (!hanging && motionState.projected > this.#span + 1) return { kind: "failed" };
    if (hanging) return running(recenterControls(snapshot, this.#target, 0.05, AIR_COAST_TICKS), undefined);

    if (this.#phase.kind === "landed") {
      // Coasting is not braking: a sprint landing can carry the body off a
      // one-block pad after forward is released. Strafe back over the
      // supported arrival with sneak held on ground, so the edge clamps that
      // residual motion. In air, keep the corrective input without weakening it.
      if (this.#tick - this.#phase.atTick > 20) return { kind: "failed" };
      return running({ ...recenterControls(snapshot, this.#target, 0.15), sneak: snapshot.onGround }, undefined);
    }

    if (this.#phase.kind === "approaching") {
      // Launch is a spatial decision. Requiring cruise speed before leaving a
      // one-block pad deadlocked rising parkour: there was no supported runway
      // on which to earn it. Forward and sprint remain held after takeoff, so
      // Minecraft can add the missing horizontal speed in flight just as
      // Baritone's MovementParkour does.
      return running(this.#advanceApproach(snapshot), this.#steeringTarget(motionState));
    }
    if (this.#phase.kind === "launching")
      return running({ ...this.#flightControls, jump: true }, this.#steeringTarget(motionState));
    // An ascending jump meets its landing early and must brake against air
    // coast. Level jumps need their remaining flight to clear the near lip:
    // braking at first overlap left the trailing edge in lava beside soul sand.
    if (
      this.#rises &&
      !grounded &&
      position.y >= this.#target.y &&
      motionState.projected >= this.#span - 0.5 - PLAYER_HALF_WIDTH
    )
      return running(recenterControls(snapshot, this.#target, 0.15, AIR_COAST_TICKS), undefined);
    return running(this.#flightControls, this.#steeringTarget(motionState));
  }
}

export function createMovementController(
  step: PlannedStep,
  start: MovementSnapshot,
  execution: MovementExecution,
  waterRise: number,
): MovementController {
  if (step.kind === "jump" || step.kind === "sprint_jump" || step.kind === "parkour")
    return new GapController(step, start, execution);
  if (step.kind === "swim" || start.isInWater) return new WaterMovementController(step, start, execution, waterRise);
  return new PlannedMovementController(step, start, execution, waterRise);
}
