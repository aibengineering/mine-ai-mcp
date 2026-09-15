import type { Vec3 } from "vec3";
import { boxEntry } from "../../../navigation/world/line-of-sight.js";
import type { BlockRaycaster } from "../../../world/block-visibility.js";
import { exposedBodyFrom, type EntityBody } from "../../../world/entity-geometry.js";

// Vanilla 1.21.4 ProjectileUtil.getHitResultOnMoveVector expands the target's
// box by 0.3 on every face. Projectile width is not the entity-hit margin.
export const PROJECTILE_HIT_MARGIN = 0.3;

export interface PositionThreat extends EntityBody {
  readonly id: number;
  /** Ranged means a direct projectile; other attack modes cannot establish cover through this predicate. */
  readonly attack: "melee" | "projectile" | "unmodelled";
}

/** Current attack exposure, not a promise that a mob cannot walk around the obstacle later. */
export function positionExposed(world: BlockRaycaster, body: EntityBody, threat: PositionThreat): boolean {
  if (threat.attack === "unmodelled") return true;
  const eye = threat.position.offset(0, threat.height * 0.85, 0);
  if (threat.attack === "projectile") {
    // A point-perfect line behind a fence post stopped being cover as soon
    // as the native blaze shifted. Check the firing body's width as well.
    const half = threat.width / 2;
    return [eye, eye.offset(half, 0, 0), eye.offset(-half, 0, 0), eye.offset(0, 0, half), eye.offset(0, 0, -half)].some(
      (from) => exposedBodyFrom(world, from, body),
    );
  }
  const dx = Math.max(0, Math.abs(body.position.x - threat.position.x) - (body.width + threat.width) / 2);
  const dz = Math.max(0, Math.abs(body.position.z - threat.position.z) - (body.width + threat.width) / 2);
  const dy = Math.max(
    0,
    body.position.y - (threat.position.y + threat.height),
    threat.position.y - (body.position.y + body.height),
  );
  return Math.hypot(dx, dy, dz) <= 2 && exposedBodyFrom(world, eye, body);
}

/** Straight projectiles are relevant only until they meet terrain, including when the shooter is hidden. */
export function projectileReachesBody(
  world: BlockRaycaster,
  projectile: { readonly position: Vec3; readonly velocity: Vec3 },
  body: EntityBody,
  maximumDistance = Infinity,
): boolean {
  return projectileContact(world, projectile, body, maximumDistance) !== null;
}

/** Exact entry point into vanilla's expanded target box, clipped by terrain. */
export function projectileContact(
  world: BlockRaycaster,
  projectile: { readonly position: Vec3; readonly velocity: Vec3 },
  body: EntityBody,
  maximumDistance = Infinity,
): Vec3 | null {
  const speed = projectile.velocity.norm();
  if (speed === 0) return null;
  const direction = projectile.velocity.scaled(1 / speed);
  const half = body.width / 2 + PROJECTILE_HIT_MARGIN;
  const distance = boxEntry(
    [
      {
        minX: -half,
        maxX: half,
        minY: -PROJECTILE_HIT_MARGIN,
        maxY: body.height + PROJECTILE_HIT_MARGIN,
        minZ: -half,
        maxZ: half,
      },
    ],
    body.position,
    projectile.position,
    direction,
  );
  return distance !== null && distance <= maximumDistance && world.raycast(projectile.position, direction, distance) === null
    ? projectile.position.plus(direction.scaled(distance)) : null;
}

export type PositionDecision = "attack" | "return" | "hold" | "establish";

/** One decision for retreat, recovery and fighting; callers retain their physical ownership. */
export function decideCombatPosition(facts: {
  readonly protected: boolean;
  readonly atProtection: boolean;
  readonly hurt: boolean;
  readonly canAttack: boolean;
  readonly canDefendHere: boolean;
  readonly attackExposed: boolean;
}): PositionDecision {
  if (!facts.protected) return facts.canDefendHere ? "attack" : "establish";
  if (facts.hurt || facts.attackExposed) return facts.atProtection ? "hold" : "return";
  return facts.canAttack ? "attack" : facts.atProtection ? "hold" : "return";
}
