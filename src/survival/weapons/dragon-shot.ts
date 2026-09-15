import { Vec3 } from "vec3";

/** Require the intercept inside each inset 5x3 body estimate, not the large
 * parent bounding box. These are motion checks, not a probability of hitting:
 * a dragon can still turn after release. No defensive geometry is changed. */
export function fitsDragonShot(
  intercept: Vec3, bodyCenter: Vec3, velocity: Vec3, previousVelocity: Vec3,
  flightTicks: number, margin: number,
): boolean {
  const acceleration = velocity.minus(previousVelocity).scaled(1 / 3);
  const predictions = [
    bodyCenter.plus(velocity.scaled(flightTicks)),
    bodyCenter.plus(previousVelocity.scaled(flightTicks)),
    bodyCenter.plus(velocity.scaled(flightTicks)).plus(acceleration.scaled(0.5 * flightTicks ** 2)),
  ];
  return predictions.every(center => Math.abs(intercept.x - center.x) <= 2.5 - margin &&
    Math.abs(intercept.z - center.z) <= 2.5 - margin && Math.abs(intercept.y - center.y) <= 1.5 - margin);
}
