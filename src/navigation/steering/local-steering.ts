/**
 * Drive the bot toward a live local target without asking A* to model arrival.
 *
 * Navigation's local steering shares arrival and momentum handling with routes
 * and survival responses. The caller supplies an admitted control port and owns
 * its lifetime; this primitive never claims the body or selects a response.
 */
import type { Position3 } from "../../utils/index.js";
import { stoppingDistance } from "../../world/player-physics.js";

export type HorizontalSteeringControl = "forward" | "back" | "left" | "right";

export interface HorizontalSteeringObservation {
  readonly position: Position3;
  readonly yaw: number;
}

/** Mineflayer effects needed by the Pathfinder's lowest-level movement driver. */
export interface HorizontalSteeringPort {
  observe(): HorizontalSteeringObservation;
  setControl(control: HorizontalSteeringControl, state: boolean): void;
  waitForTick(): Promise<void>;
}

export interface HorizontalSteeringRequest {
  /** Read on every tick so entities can move while they are being approached. */
  target(): Position3 | null;
  /** The caller owns the physical fact that makes its approach complete. */
  arrived(): boolean;
  readonly maximumTicks: number;
  readonly signal: AbortSignal;
}

export type HorizontalSteeringOutcome =
  | { readonly kind: "arrived" }
  | { readonly kind: "target_lost" }
  | { readonly kind: "exhausted"; readonly ticks: number };

const CONTROLS = ["forward", "back", "left", "right"] as const;
/** Give released momentum a short observed window to settle before another owner takes control. */
const REST_SETTLE_TICKS = 5;
const REST_SPEED = 0.03;

/** Fit the 0.6-block-wide body inside one cell before digging down or pillaring. */
export async function centerOnCell(
  port: HorizontalSteeringPort,
  cell: Position3,
  signal: AbortSignal,
): Promise<boolean> {
  const center = { x: cell.x + 0.5, z: cell.z + 0.5 };
  const arrived = () => {
    const { position } = port.observe();
    return Math.hypot(position.x - center.x, position.z - center.z) <= 0.17;
  };
  const result = await driveHorizontalSteering(port, {
    target: () => ({ ...center, y: port.observe().position.y }),
    arrived,
    // One second detects blocked correction or sustained knockback instead of
    // retaining the physical session indefinitely while trying to centre.
    maximumTicks: 20,
    signal,
  });
  return result.kind === "arrived" && arrived();
}

/** Share observation and tick wiring while keeping control ownership with the caller. */
export function steeringPortFor(
  bot: {
    readonly entity: { readonly position: Position3; readonly yaw?: number };
    waitForTicks(ticks: number): Promise<void>;
  },
  setControl: HorizontalSteeringPort["setControl"],
): HorizontalSteeringPort {
  return {
    observe: () => ({ position: bot.entity.position, yaw: bot.entity.yaw ?? 0 }),
    setControl,
    waitForTick: () => bot.waitForTicks(1),
  };
}

/** Resolve a world-space correction into controls without changing the look direction. */
export function horizontalControlsToward(
  { position, yaw }: HorizontalSteeringObservation,
  target: Position3,
  brake: number,
): Readonly<Record<HorizontalSteeringControl, boolean>> {
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  const dx = target.x - position.x;
  const dz = target.z - position.z;
  const ahead = -dx * sin - dz * cos;
  const rightward = dx * cos - dz * sin;
  return { forward: ahead > brake, back: -ahead > brake, right: rightward > brake, left: -rightward > brake };
}

async function waitForHorizontalRest(port: HorizontalSteeringPort, signal: AbortSignal): Promise<void> {
  let previous = { ...port.observe().position };
  for (let tick = 0; tick < REST_SETTLE_TICKS; tick += 1) {
    signal.throwIfAborted();
    await port.waitForTick();
    const current = port.observe().position;
    if (Math.hypot(current.x - previous.x, current.z - previous.z) <= REST_SPEED) return;
    previous = { ...current };
  }
}

/**
 * Drive horizontally toward a live world-space target without taking ownership
 * of the bot's look direction.
 *
 * Keeping rotation separate lets Pathfinder centre inside a cell without
 * snapping its view, and later lets combat look at one entity while strafing
 * toward or away from another point.
 */
export async function driveHorizontalSteering(
  port: HorizontalSteeringPort,
  request: HorizontalSteeringRequest,
): Promise<HorizontalSteeringOutcome> {
  let previous = { ...port.observe().position };
  let outcome: HorizontalSteeringOutcome = { kind: "exhausted", ticks: request.maximumTicks };
  try {
    for (let tick = 0; tick < request.maximumTicks; tick += 1) {
      request.signal.throwIfAborted();
      const { position, yaw } = port.observe();
      const velocity = { x: position.x - previous.x, y: 0, z: position.z - previous.z };
      const atTarget = request.arrived();
      // Reaching the radius while coasting is not settled arrival. Release
      // input, observe the next tick, and correct again if momentum carries
      // the body outside it. Otherwise the final rest can undo the arrival
      // before the next operation checks that the body is still centred.
      if (atTarget && tick > 0 && Math.hypot(velocity.x, velocity.z) <= REST_SPEED) {
        return { kind: "arrived" };
      }

      const target = request.target();
      if (!target) {
        outcome = { kind: "target_lost" };
        break;
      }

      const brake = stoppingDistance(velocity);
      previous = { ...position };

      // prismarine-physics accelerates forward along (-sin(yaw), -cos(yaw))
      // and right along (cos(yaw), -sin(yaw)). Resolve the live world-space
      // offset into that frame so locomotion never has to change look direction.
      const controls = horizontalControlsToward({ position, yaw }, target, brake);
      for (const control of CONTROLS) port.setControl(control, !atTarget && controls[control]);
      await port.waitForTick();
    }
  } finally {
    for (const control of CONTROLS) port.setControl(control, false);
  }

  await waitForHorizontalRest(port, request.signal);
  if (request.arrived()) return { kind: "arrived" };
  if (!request.target()) return { kind: "target_lost" };
  return outcome;
}
