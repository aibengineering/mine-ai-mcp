import { Vec3 } from "vec3";

// Vanilla full-charge arrows advance by velocity, then apply air drag and gravity each tick.
const SPEED = 3;
const DRAG = 0.99;
const GRAVITY = 0.05;

export interface BowTrajectory {
  readonly velocity: Vec3;
  readonly points: readonly Vec3[];
  readonly flightTicks: number;
}

/** Earliest positive intercept, with optional constant target motion in blocks per tick. */
export function bowTrajectory(origin: Vec3, target: Vec3, targetVelocity = new Vec3(0, 0, 0)): BowTrajectory | null {
  const delta = target.minus(origin);
  if (delta.norm() === 0) return null;
  // Position after t ticks is launchVelocity * travel - (0, fall, 0).
  let travel = 0;
  let fall = 0;
  let drag = 1;
  for (let tick = 0; ; tick++) {
    const gravityVelocity = (GRAVITY * (1 - drag)) / (1 - DRAG);
    // Even a vertically fired arrow cannot reach this height after it starts descending.
    if (SPEED * travel - fall < delta.y + targetVelocity.y * tick && SPEED * drag - gravityVelocity <= targetVelocity.y) return null;
    // Moving targets can descend indefinitely; bound that extrapolation.
    if (tick >= 120 && targetVelocity.norm() > 0) return null;
    // Inside this tick both travel and fall are linear in its elapsed fraction.
    // Requiring launch speed 3 makes the intercept equation a*f² + b*f + c = 0.
    const offset = delta.plus(targetVelocity.scaled(tick)).offset(0, fall, 0);
    const change = targetVelocity.offset(0, gravityVelocity, 0);
    const a = change.dot(change) - SPEED ** 2 * drag ** 2;
    const b = 2 * (offset.dot(change) - SPEED ** 2 * travel * drag);
    const c = offset.dot(offset) - SPEED ** 2 * travel ** 2;
    const discriminant = b * b - 4 * a * c;
    let roots: number[];
    if (a === 0) roots = b === 0 ? [] : [-c / b];
    else if (discriminant < 0) roots = [];
    else {
      const squareRoot = Math.sqrt(discriminant);
      roots = [(-b - squareRoot) / (2 * a), (-b + squareRoot) / (2 * a)];
    }
    const fraction = roots
      .filter((value) => value >= 0 && value <= 1 && tick + value > 0)
      .sort((left, right) => left - right)[0];
    if (fraction !== undefined) {
      const scale = travel + fraction * drag;
      const velocity = offset.plus(change.scaled(fraction)).scaled(1 / scale);
      const points = [origin.clone()];
      let position = origin.clone();
      let motion = velocity.clone();
      for (let step = 0; step < tick; step++) {
        position = position.plus(motion);
        points.push(position);
        motion = motion.scaled(DRAG).offset(0, -GRAVITY, 0);
      }
      if (fraction > 0) points.push(position.plus(motion.scaled(fraction)));
      return { velocity, points, flightTicks: tick + fraction };
    }
    travel += drag;
    fall += gravityVelocity;
    drag *= DRAG;
  }
}

/** Test the same tick segments the aimed arrow follows, rather than the eye-to-target chord. */
export function clearBowTrajectory(
  trajectory: BowTrajectory,
  raycast: (origin: Vec3, direction: Vec3, distance: number) => unknown | null,
): boolean {
  for (let index = 1; index < trajectory.points.length; index++) {
    const from = trajectory.points[index - 1]!;
    const delta = trajectory.points[index]!.minus(from);
    const distance = delta.norm();
    if (distance > 0 && raycast(from, delta.scaled(1 / distance), distance) !== null) return false;
  }
  return true;
}
