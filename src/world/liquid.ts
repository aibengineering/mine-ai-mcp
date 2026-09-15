/**
 * What a bucket needs to know about liquid in the world.
 *
 * The bucket action and the casting step both scoop, pour, and count what the
 * pour made, so the facts they share live here rather than in either of them:
 * which state is a source, which flowing cell is fed by which source, where a
 * pour from here would land, and what water landing on lava turned into once
 * it stopped spreading.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { isLiquid, isReplaceableForPlacement } from "./block-classification.js";
import { STANDING_EYE_HEIGHT } from "./block-visibility.js";
import type { WorldBlock } from "./placement.js";

export type LiquidName = "water" | "lava";

/** How far around a pour the obsidian and cobblestone are counted. */
const FORMATION_RADIUS = 10;
/** How long a pour is given to finish spreading before its formations are counted. */
const SPREAD_TIMEOUT_TICKS = 100;
const SPREAD_SETTLED_TICKS = 10;
/**
 * How far a fill will trace a flow back to the source feeding it. A model that
 * names a cell it saw water in is usually a few blocks downstream of the
 * source; beyond a few cells it is naming somewhere else entirely.
 */
const FLOW_TRACE_CELLS = 4;

/** How far the server lets a use ray reach from the eye. */
export const USE_RAY_REACH = 4.5;
/** Ray-walk granularity: a twentieth of a block cannot skip a cell. */
const RAY_STEP = 0.05;

export const HORIZONTAL = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)] as const;

/** Prismarine's block faces, in its own index order, as unit normals. */
const FACE_NORMALS = [
  new Vec3(0, -1, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, 0, -1),
  new Vec3(0, 0, 1),
  new Vec3(-1, 0, 0),
  new Vec3(1, 0, 0),
] as const;

/** Whether a block is the liquid's source state: its lowest level, which is the only one a bucket scoops. */
export function isLiquidSource(bot: Bot, block: WorldBlock | null, liquid: LiquidName): boolean {
  const definition = bot.registry.blocksByName[liquid];
  return block !== null && definition !== undefined && block.stateId === definition.minStateId;
}

/**
 * The source feeding a flowing cell, when one is close enough to walk to.
 *
 * A fill named at flowing water fails in run 10 after a five-second walk that
 * dug on the way. Water states run from the source upward with distance, so
 * the cells around a flow lead back to it; a bounded spread over the liquid
 * from the named cell finds the source or says there is none.
 */
export function sourceFeeding(bot: Bot, cell: Vec3, liquid: LiquidName): Vec3 | null {
  const definition = bot.registry.blocksByName[liquid];
  if (!definition) return null;
  const seen = new Set([`${cell.x},${cell.y},${cell.z}`]);
  let frontier = [cell];
  for (let step = 0; step <= FLOW_TRACE_CELLS; step += 1) {
    const next: Vec3[] = [];
    for (const current of frontier) {
      const block = bot.blockAt(current);
      if (block?.name !== liquid) continue;
      if (block.stateId === definition.minStateId) return current;
      for (const offset of [...HORIZONTAL, new Vec3(0, 1, 0), new Vec3(0, -1, 0)]) {
        const neighbour = current.plus(offset);
        const key = `${neighbour.x},${neighbour.y},${neighbour.z}`;
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(neighbour);
      }
    }
    frontier = next;
  }
  return null;
}

/**
 * Whether the use ray from `eye` reaches the source's surface point without
 * meeting a solid block first. A block raycast never hits a fluid, so the
 * question is not "does the ray hit the water" but "does anything solid stop
 * it before the cell the water is in".
 */
export function sourceInSight(bot: Bot, eye: Vec3, target: Vec3): boolean {
  const point = target.offset(0.5, 0.9, 0.5);
  const toward = point.minus(eye);
  const distance = toward.norm();
  if (distance > USE_RAY_REACH || distance < 0.01) return false;
  const hit = bot.world.raycast(eye, toward.normalize(), distance);
  if (!hit) return true;
  const position = (Reflect.get(hit, "position") as { x: number; y: number; z: number } | undefined) ?? hit;
  return position.x === target.x && position.y === target.y && position.z === target.z;
}

export interface PourAim {
  /** The point to look at, so the server's own ray lands where this one did. */
  readonly lookAt: Vec3;
  /** The cell that holds the poured liquid afterwards. */
  readonly landing: Vec3;
  /** The solid cell the ray lands on; the liquid goes into the cell in front of it. */
  readonly surface: Vec3;
}

function hitCell(hit: unknown): Vec3 {
  const position = Reflect.get(hit as object, "position") as Vec3 | undefined;
  return (position ?? (hit as Vec3)).floored();
}

/**
 * Whether the ray reaches `landing` without passing through liquid first.
 *
 * A pour whose ray crossed lava turns that lava to obsidian too, once the
 * water it placed spreads back along the same line — and the empty bucket's
 * ray then meets that new wall instead of the water behind it. The in-rock run
 * lost sixty-one cells of water and its bucket to rays like that.
 */
function arrivesDry(bot: Bot, eye: Vec3, direction: Vec3, landing: Vec3): boolean {
  for (let travelled = 0; travelled <= USE_RAY_REACH; travelled += RAY_STEP) {
    const cell = eye.plus(direction.scaled(travelled)).floored();
    if (cell.equals(landing)) return true;
    if (isLiquid(bot.blockAt(cell))) return false;
  }
  return false;
}

/**
 * Where a full bucket poured from where the bot stands would put its liquid.
 *
 * The server decides a pour with one ray: a full bucket's ray ignores fluid,
 * stops at the first solid face within reach, and the liquid lands in the cell
 * in front of that face. So this asks that one question the same way — every
 * solid face in reach, a ray to it, landing = the cell the ray struck plus the
 * face it struck — and lets the caller say which landings it wants.
 *
 * `accepts` scores a landing, higher first, or returns null to refuse it; ties
 * go to the shortest ray. Choosing a cell and a face as two separate guesses is
 * what put water across the roof of a buried pool while its lava never changed.
 */
export function pourAim(bot: Bot, accepts: (landing: Vec3) => number | null): PourAim | null {
  const eye = bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0);
  const origin = eye.floored();
  const span = Math.ceil(USE_RAY_REACH);
  let best: { readonly aim: PourAim; readonly score: number; readonly distance: number } | null = null;
  for (let dx = -span; dx <= span; dx += 1) {
    for (let dy = -span; dy <= span; dy += 1) {
      for (let dz = -span; dz <= span; dz += 1) {
        const cell = origin.offset(dx, dy, dz);
        if (bot.blockAt(cell)?.boundingBox !== "block") continue;
        for (const normal of FACE_NORMALS) {
          const landing = cell.plus(normal);
          const score = accepts(landing);
          if (score === null || (best !== null && score < best.score)) continue;
          const lookAt = cell.offset(0.5, 0.5, 0.5).plus(normal.scaled(0.5));
          const distance = lookAt.distanceTo(eye);
          if (distance > USE_RAY_REACH || distance < RAY_STEP) continue;
          if (best !== null && score === best.score && distance >= best.distance) continue;
          if (!isReplaceableForPlacement(bot.blockAt(landing))) continue;
          const direction = lookAt.minus(eye).scaled(1 / distance);
          const hit = bot.world.raycast(eye, direction, USE_RAY_REACH);
          if (hit === null) continue;
          const face = FACE_NORMALS[Number(Reflect.get(hit as object, "face") ?? -1)];
          const surface = hitCell(hit);
          if (face === undefined || !surface.plus(face).equals(landing)) continue;
          if (!arrivesDry(bot, eye, direction, landing)) continue;
          best = { aim: { lookAt, landing, surface }, score, distance };
        }
      }
    }
  }
  return best?.aim ?? null;
}

export interface LiquidFormations {
  readonly obsidian: number;
  readonly cobblestone: number;
}

export function countFormations(bot: Bot, around: Vec3): LiquidFormations {
  const count = (name: string) =>
    bot.findBlocks({
      point: around,
      matching: bot.registry.blocksByName[name]!.id,
      maxDistance: FORMATION_RADIUS,
      count: 512,
    }).length;
  return { obsidian: count("obsidian"), cobblestone: count("cobblestone") };
}

/** Wait for a pour to stop changing the world, then count what it made. */
export async function settledFormations(
  bot: Bot,
  around: Vec3,
  signal: AbortSignal | undefined,
): Promise<LiquidFormations> {
  let last = countFormations(bot, around);
  let stableTicks = 0;
  for (let tick = 0; tick < SPREAD_TIMEOUT_TICKS && stableTicks < SPREAD_SETTLED_TICKS; tick += 1) {
    await bot.waitForTicks(1);
    signal?.throwIfAborted();
    const next = countFormations(bot, around);
    stableTicks = next.obsidian === last.obsidian && next.cobblestone === last.cobblestone ? stableTicks + 1 : 0;
    last = next;
  }
  return last;
}
