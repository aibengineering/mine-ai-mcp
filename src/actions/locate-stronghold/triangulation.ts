import type { Position3 } from "../../utils/index.js";

export interface Bearing {
  readonly start: Position3;
  readonly end: Position3;
}

export function direction(bearing: Bearing): { x: number; z: number } | null {
  const x = bearing.end.x - bearing.start.x;
  const z = bearing.end.z - bearing.start.z;
  const distance = Math.hypot(x, z);
  // Sub-block motion is dominated by initial packet quantisation near the target.
  return distance >= 1 ? { x: x / distance, z: z / distance } : null;
}

const cross = (a: { x: number; z: number }, b: { x: number; z: number }) => a.x * b.z - a.z * b.x;

/** Intersect forward rays, refusing an estimate whose packet precision exceeds one chunk. */
export function triangulate(first: Bearing, second: Bearing): { x: number; z: number } | null {
  const a = direction(first);
  const b = direction(second);
  if (!a || !b) return null;
  const determinant = cross(a, b);
  if (Math.abs(determinant) < 1e-9) return null;
  const offset = { x: second.start.x - first.start.x, z: second.start.z - first.start.z };
  const alongA = cross(offset, b) / determinant;
  const alongB = cross(offset, a) / determinant;
  if (alongA < 0 || alongB < 0) return null;
  // Relative entity movement uses 1/4096-block units. Allow four units of
  // endpoint error per ray, amplified by distance and the crossing angle.
  const angularError = (bearing: Bearing) =>
    4 / 4096 / Math.hypot(bearing.end.x - bearing.start.x, bearing.end.z - bearing.start.z);
  const error = (alongA * angularError(first) + alongB * angularError(second)) / Math.abs(determinant);
  if (error > 16) return null;
  const x = first.start.x + alongA * a.x;
  const z = first.start.z + alongA * a.z;
  return Number.isFinite(x) && Number.isFinite(z) ? { x, z } : null;
}
