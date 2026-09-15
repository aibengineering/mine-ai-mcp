import { Vec3 } from "vec3";
import { isPassable } from "../../../navigation/world/block-geometry.js";
import { obstaclesOf } from "../../../navigation/world/line-of-sight.js";
import type { WorldView } from "../../../navigation/world/world.js";
import { STANDING_EYE_HEIGHT } from "../../../world/block-visibility.js";
import { exposedBodyFrom, nearestBodyPoint } from "../../../world/entity-geometry.js";
import { MELEE_RANGE } from "../../weapons/equipment.js";
import { positionExposed, type PositionThreat } from "./exposure.js";
import { clearPlannedRay, positionWorld, standingBody, standingCell, type CombatPositionPlan } from "./geometry.js";

export const PROTECTION_SIDES = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)];

/** Necessary cells are hard constraints. Costs only compare admitted alternatives. */
export function missingProtection(world: WorldView, shell: readonly Vec3[]): Vec3[] | null {
  const missing: Vec3[] = [];
  for (const cell of new Map(shell.map((at) => [at.toString(), at])).values()) {
    const block = world.blockAt(cell.x, cell.y, cell.z);
    if (block.kind === "unloaded") return null;
    if (isPassable(block)) {
      missing.push(cell);
      continue;
    }
    if (
      !obstaclesOf(block)?.some(
        (box) =>
          box.minX === 0 && box.minY === 0 && box.minZ === 0 && box.maxX === 1 && box.maxY >= 1 && box.maxZ === 1,
      )
    )
      return null;
  }
  return missing;
}

/** The same shell description serves existing terrain, a roof, and a closed emergency shelter. */
export function protectionShell(home: Vec3, passage: readonly Vec3[]): Vec3[] {
  const walls = passage.flatMap((cell) =>
    PROTECTION_SIDES.flatMap((side) => {
      const wall = cell.plus(side);
      return passage.some((clear) => clear.equals(wall)) ? [] : [wall, wall.offset(0, 1, 0)];
    }),
  );
  return [...walls, ...passage.map((cell) => cell.offset(0, 2, 0)), home.offset(0, 2, 0)];
}

/** Reachable local candidates, so a cheaper wall never buys an unsafe step over a ledge. */
function homes(world: WorldView, origin: Vec3, steps: number): Vec3[] {
  const found = new Map<string, Vec3>();
  if (standingCell(world, origin)) found.set(origin.toString(), origin);
  let frontier = [...found.values()];
  for (let step = 0; step < steps; step++) {
    const next: Vec3[] = [];
    for (const cell of frontier)
      for (const side of PROTECTION_SIDES) {
        const at = cell.plus(side);
        if (found.has(at.toString()) || !standingCell(world, at)) continue;
        found.set(at.toString(), at);
        next.push(at);
      }
    frontier = next;
  }
  return [...found.values()];
}

export type RoofOpening =
  | { readonly kind: "protection" }
  | { readonly kind: "provoke"; readonly targetEye: Vec3; readonly eyeHeight: number }
  | {
      readonly kind: "engage";
      readonly target: PositionThreat;
      readonly eyeHeight: number;
      readonly unproductive: ReadonlySet<string>;
    };

export interface RoofPosition {
  readonly cell: Vec3;
  readonly placements: readonly Vec3[];
}

export interface RoofSearch {
  readonly plan: RoofPosition | null;
  readonly supportedCells: number;
  readonly rejected: { terrain: number; material: number; occupied: number; gaze: number; reach: number };
}

/** One block of overhang on every side of the central two-block-high fighting cell. */
export function endermanRoof(cell: Vec3): Vec3[] {
  const roof: Vec3[] = [];
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) roof.push(cell.offset(x, 2, z));
  return roof;
}

/** Solid two-high walls exclude the tall mob just as an eave does. */
export function requiredEndermanRoof(cell: Vec3, full: (cell: Vec3) => boolean): Vec3[] {
  return endermanRoof(cell).filter((cap) =>
    cap.x === cell.x && cap.z === cell.z || !full(cap.offset(0, -2, 0)) || !full(cap.offset(0, -1, 0)),
  );
}

/** A short, reversible walk toward the quarry, including ground beyond the eave.
 * Only observed level footing is admitted; no digging, jumps or blind steps. */
export function roofLurePath(world: WorldView, cell: Vec3, target: Vec3, placements: readonly Vec3[] = []): Vec3[] {
  const visited = new Set([cell.toString()]);
  let frontier: Vec3[][] = [[cell]];
  let best: Vec3[] = [];
  let cost = cell.offset(0.5, 0, 0.5).distanceTo(target);
  for (let depth = 0; depth < 4; depth++) {
    const next: Vec3[][] = [];
    for (const path of frontier) for (const side of PROTECTION_SIDES) {
      const at = path.at(-1)!.plus(side);
      if (visited.has(at.toString()) || !standingCell(world, at) ||
        placements.some((placed) => placed.equals(at) || placed.equals(at.offset(0, 1, 0)))) continue;
      visited.add(at.toString());
      const extended = [...path, at];
      next.push(extended);
      const distance = at.offset(0.5, 0, 0.5).distanceTo(target) + depth * 0.1;
      if (distance < cost) { best = extended; cost = distance; }
    }
    frontier = next;
  }
  return best;
}

/** A fighting shelter needs either a swing or a reversible bait path to a swing.
 * A roof above the quarry or a sealed recovery box protects without providing either. */
export function roofEngagementAvailable(world: WorldView, cell: Vec3, target: PositionThreat, eyeHeight: number, placements: readonly Vec3[] = []): boolean {
  const canStrikeFrom = (at: Vec3) => {
    const eye = at.offset(0.5, eyeHeight, 0.5);
    return nearestBodyPoint(eye, target).distanceTo(eye) <= MELEE_RANGE && exposedBodyFrom(positionWorld(world, placements), eye, target);
  };
  if (canStrikeFrom(cell)) return true;
  if (Math.abs(cell.y - target.position.y) > 1) return false;
  return roofLurePath(world, cell, target.position, placements).some(canStrikeFrom);
}

/** A two-high backstop catches a jumping hitbox; its floor extension provides a real placement face. */
export function backstopPosition(world: WorldView, origin: Vec3, attacker: Vec3, blocks: number): RoofPosition | null {
  if (!standingCell(world, origin)) return null;
  const away = origin.offset(0.5, 0, 0.5).minus(attacker);
  if (Math.hypot(away.x, away.z) < 0.01) return null;
  const side =
    Math.abs(away.x) >= Math.abs(away.z) ? new Vec3(Math.sign(away.x), 0, 0) : new Vec3(0, 0, Math.sign(away.z));
  const wall = origin.plus(side);
  const placements = missingProtection(world, [wall.offset(0, -1, 0), wall, wall.offset(0, 1, 0)]);
  return placements && placements.length <= blocks ? { cell: origin, placements } : null;
}

/** Existing roofs cost no material; a new roof has an explicit reachable eave and support column. */
export function findRoofPosition(
  world: WorldView,
  origin: Vec3,
  target: Vec3,
  blocks: number,
  canPlace: (cell: Vec3) => boolean,
  opening: RoofOpening,
  candidates: readonly Vec3[] = homes(world, origin, 6),
): RoofSearch {
  let best: RoofPosition | null = null;
  let bestCost = Infinity;
  const rejected = { terrain: 0, material: 0, occupied: 0, gaze: 0, reach: 0 };
  for (const cell of candidates) {
    if (!standingCell(world, cell)) continue;
    if (opening.kind === "engage" && opening.unproductive.has(`${cell}:${opening.target.position.floored()}`)) continue;
    // Equal-cost columns belong behind the opening toward the enderman.
    // A column in front blocks both the provoking gaze and returning melee.
    const toward = target.minus(cell.offset(0.5, 0, 0.5));
    const sides = [...PROTECTION_SIDES].sort((a, b) => a.dot(toward) - b.dot(toward));
    for (const side of sides) {
      const roof = requiredEndermanRoof(cell, (at) => missingProtection(world, [at])?.length === 0);
      const existing = missingProtection(world, roof);
      const supportedRoof = roof.some((cap) =>
        [...PROTECTION_SIDES, new Vec3(0, -1, 0), new Vec3(0, 1, 0)].some((side) =>
          missingProtection(world, [cap.plus(side)])?.length === 0));
      // On a ledge the column needs a foundation attached to the standing
      // cell's floor. Starting at feet height leaves no supporting face.
      const shell =
        existing?.length === 0 || supportedRoof
          ? roof
          : [
              cell.plus(side).offset(0, -1, 0),
              cell.plus(side),
              cell.plus(side).offset(0, 1, 0),
              cell.plus(side).offset(0, 2, 0),
              ...roof,
            ];
      const placements = missingProtection(world, shell);
      if (!placements) {
        rejected.terrain++;
        continue;
      }
      if (placements.length > blocks) {
        rejected.material++;
        continue;
      }
      if (!placements.every(canPlace)) {
        rejected.occupied++;
        continue;
      }
      if (
        // Provocation precedes construction. The proposed eave may obstruct
        // this ray afterward; an already-hostile target no longer needs it.
        opening.kind === "provoke" &&
        !clearPlannedRay(world, [], cell.offset(0.5, opening.eyeHeight, 0.5), opening.targetEye) &&
        !(placements.length === 0 && roofLurePath(world, cell, target).some((at) =>
          clearPlannedRay(world, [], at.offset(0.5, opening.eyeHeight, 0.5), opening.targetEye)))
      ) {
        rejected.gaze++;
        continue;
      }
      if (opening.kind === "engage") {
        if (!roofEngagementAvailable(world, cell, opening.target, opening.eyeHeight, placements)) {
          rejected.reach++;
          continue;
        }
      }
      const cost = placements.length * 4 + cell.distanceTo(origin);
      if (cost < bestCost) {
        bestCost = cost;
        best = { cell, placements };
      }
    }
  }
  return { plan: best, supportedCells: candidates.length, rejected };
}

/** A short bent corridor keeps a protected return cell and an opening toward the target. */
export function findCombatPosition(
  world: WorldView,
  origin: Vec3,
  threats: readonly PositionThreat[],
  target: PositionThreat,
  blocks: number,
  candidates: readonly Vec3[] = homes(world, origin, 2),
  accepts: (plan: CombatPositionPlan) => boolean = () => true,
): CombatPositionPlan | null {
  let best: CombatPositionPlan | null = null;
  let bestCost = Infinity;
  // Two steps cover a fortress railing without turning construction into navigation search.
  for (const home of candidates)
    for (const side of PROTECTION_SIDES) {
      if (!standingCell(world, home)) continue;
      for (const opening of [new Vec3(-side.z, 0, side.x), new Vec3(side.z, 0, -side.x)]) {
        const corner = home.plus(side);
        const fighting = corner.plus(opening);
        if (![corner, fighting].every((cell) => standingCell(world, cell))) continue;
        for (const construct of [false, true]) {
          const passage = [home, corner, fighting];
          // Keep the firing cell open overhead. Flying targets otherwise have no bow trajectory.
          const shell = construct
            ? protectionShell(home, [home, corner]).filter(
                (cell) => !passage.some((clear) => cell.equals(clear) || cell.equals(clear.offset(0, 1, 0))),
              )
            : [];
          if (construct) shell.push(home.minus(side).offset(0, 2, 0));
          const placements = missingProtection(world, shell);
          if (!placements || placements.length > blocks) continue;
          const rays = positionWorld(world, placements);
          if (threats.some((threat) => positionExposed(rays, standingBody(home), threat))) continue;
          const eye = fighting.offset(0.5, STANDING_EYE_HEIGHT, 0.5);
          if (!exposedBodyFrom(rays, eye, target)) continue;
          if (
            construct &&
            target.position.y > home.y &&
            !exposedBodyFrom(rays, eye, { ...target, position: new Vec3(target.position.x, home.y, target.position.z) })
          )
            continue;
          const exposure = threats.filter((threat) => positionExposed(rays, standingBody(fighting), threat)).length;
          const cost = placements.length * 4 + exposure * 2 + home.distanceTo(origin);
          if (cost >= bestCost) continue;
          const plan = {
            protected: home,
            corner,
            fighting,
            entrance: fighting,
            placements: placements.sort((a, b) => a.y - b.y || a.distanceTo(home) - b.distanceTo(home)),
          };
          if (!accepts(plan)) continue;
          bestCost = cost;
          best = plan;
        }
      }
    }
  return best;
}
