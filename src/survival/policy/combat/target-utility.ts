/** Admission (authorized target, reachable stance) happens before this comparison. */
export interface TargetFacts {
  readonly inReach: boolean;
  readonly visible: boolean;
  readonly hasHitUs: boolean;
  readonly safeDropGround: boolean;
  readonly distance: number;
}

/** Prefer an answerable contact, then the closest exposed target.
 * Old aggression and possible loot ground must not buy a longer chase through
 * an active fight. They only distinguish otherwise equally close candidates.
 */
export function compareTargets(left: TargetFacts, right: TargetFacts): number {
  for (const key of ["inReach", "visible"] as const) {
    if (left[key] !== right[key]) return left[key] ? -1 : 1;
  }
  if (left.distance !== right.distance) return left.distance - right.distance;
  for (const key of ["hasHitUs", "safeDropGround"] as const) {
    if (left[key] !== right[key]) return left[key] ? -1 : 1;
  }
  return 0;
}
