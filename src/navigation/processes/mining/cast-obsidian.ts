import { holdWaterPosition } from "../../steering/hold-water-position.js";
/**
 * Make obsidian where there is none: water flowing onto lava sources.
 *
 * This is a step of the mine loop, not a process of its own. Obsidian is the
 * only block a bot can manufacture, and once it exists it is an ordinary
 * mining target — sealed by `target-safety.ts` and broken by the same loop
 * that breaks ore.
 *
 * Two facts from vanilla shape the step, both measured on a flat shore in
 * `pour-through-lava`: water touching a lava *source* makes obsidian, and a
 * full bucket's ray ignores fluid, so looking through the pool at its floor
 * lands the water in the lava cell itself, destroying that source. Casting
 * instead lands above or beside the pool to preserve its yield. `pourAim`
 * answers where a pour lands; this file says which landings a cast wants, opens a sight line
 * when rock is in the way, and performs the pour.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { asVec3, cellKey } from "../../../utils/index.js";
import { STANDING_EYE_HEIGHT } from "../../../world/block-visibility.js";
import {
  countFormations,
  HORIZONTAL,
  isReplaceableForPlacement,
  pourAim,
  settledFormations,
  USE_RAY_REACH,
  type PourAim,
  type useItemAt,
} from "../../../world/index.js";
import type { BlockPosition, BreakBlockInPlace, MovementPolicy } from "../../index.js";

/**
 * How close the route brings the bot to a lava source, feet cell to cell.
 *
 * Two, because the pour is a ray under the shore's lip. The eye sits 1.62
 * above the standing cell and the pool floor a block below it, so the ray
 * clears the lip only within about 1.3 blocks horizontally of where it lands.
 * At four the bot stopped on the shore and every ray to the pool met the shore
 * block first, which is why both flat cast fixtures found nowhere to pour.
 */
export const CAST_REACH = 2;
/** How many blocks the cast will break to open a sight line into a buried pool. */
const EXPOSING_BREAKS = 3;
/** The scoop is retried once: the poured cell spends a moment under its own flow. */
const SCOOP_ATTEMPTS = 2;

/** The physical effects a cast needs, which the mine request already owns. */
export interface CastPhysics {
  readonly useItem: typeof useItemAt;
  readonly breakInPlace: BreakBlockInPlace;
  readonly movements: MovementPolicy;
  readonly signal?: AbortSignal;
}

export type CastOutcome =
  | {
      readonly kind: "cast";
      readonly landing: Vec3;
      readonly obsidianFormed: number;
      readonly waterRecovered: boolean;
    }
  | { readonly kind: "reposition"; readonly reason: string }
  | { readonly kind: "failed"; readonly reason: string };

const eyeOf = (bot: Bot) => bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0);
const carried = (bot: Bot, name: string) => bot.inventory.items().find((item) => item.name === name) ?? null;

/** Whether the bot is holding the one thing that turns lava into obsidian. */
export function carriesWaterBucket(bot: Bot): boolean {
  return carried(bot, "water_bucket") !== null;
}

/**
 * Preserve the pool's material: water must flow onto lava, never replace it.
 * Prefer directly above a source, then beside it or on the shore above its
 * neighbour. The latter gives an open pool a pour face without a placed block.
 */
function castScore(bot: Bot, sources: ReadonlySet<string>, landing: Vec3): number | null {
  if (bot.blockAt(landing)?.name === "lava") return null;
  if (sources.has(cellKey(landing.offset(0, -1, 0)))) return 2;
  const reachesSource = HORIZONTAL.some((direction) => {
    const beside = landing.plus(direction);
    if (sources.has(cellKey(beside))) return true;
    // A buried source's stone lid blocks flow from a neighbouring shore cell.
    return sources.has(cellKey(beside.offset(0, -1, 0))) && isReplaceableForPlacement(bot.blockAt(beside));
  });
  return reachesSource ? 1 : null;
}

function nearestSource(bot: Bot, sources: readonly BlockPosition[]): Vec3 | null {
  const eye = eyeOf(bot);
  return sources
    .map(asVec3)
    .reduce<Vec3 | null>(
      (closest, source) => (closest === null || eye.distanceTo(source) < eye.distanceTo(closest) ? source : closest),
      null,
    );
}

/**
 * The first solid cell between the eye and a lava source: what stands between
 * the bot and a pour when a pool is under a lid. The ray stops at the source,
 * so nothing beyond the pool is ever named — and never the cell under the
 * feet, which would drop the bot toward the lava.
 */
function firstSolidTowards(bot: Bot, source: Vec3): BlockPosition | null {
  const eye = eyeOf(bot);
  const toward = source.offset(0.5, 0.9, 0.5).minus(eye);
  const distance = toward.norm();
  if (distance > USE_RAY_REACH || distance < 0.01) return null;
  const hit = bot.world.raycast(eye, toward.scaled(1 / distance), distance);
  if (hit === null) return null;
  const position = Reflect.get(hit as object, "position") as Vec3 | undefined;
  const cell = (position ?? (hit as unknown as Vec3)).floored();
  const feet = bot.entity.position.floored();
  if (cell.x === feet.x && cell.y === feet.y - 1 && cell.z === feet.z) return null;
  return { x: cell.x, y: cell.y, z: cell.z };
}

/**
 * Get the water back by looking at the cell it landed in with the empty
 * bucket, whose ray stops at source liquid. Retried once: the poured cell
 * spends a moment under its own flow and Mineflayer reads the flow first.
 */
async function scoopBack(bot: Bot, physics: CastPhysics, aim: PourAim): Promise<boolean> {
  for (let attempt = 0; attempt < SCOOP_ATTEMPTS; attempt += 1) {
    physics.signal?.throwIfAborted();
    if (carried(bot, "water_bucket")) return true;
    const bucket = carried(bot, "bucket");
    if (!bucket) return false;
    const use = await physics.useItem(bot, {
      item: bucket,
      // The pour proved this ray reaches the landing through the opening.
      // Keep that opening instead of assuming the source's centre is visible.
      // The empty bucket stops at the source on the same ray.
      lookAt: aim.lookAt,
      expectedInventoryGain: { item: "water_bucket", count: 1 },
      ...(physics.signal && { signal: physics.signal }),
    });
    if (use.kind === "used") return true;
  }
  return carried(bot, "water_bucket") !== null;
}

/**
 * One pour onto one pool, from where the bot already stands. The loop calls
 * this and then rescans; whatever obsidian appeared is an ordinary target.
 *
 * A scoop that fails returns the known source to the mine loop, which must
 * recover it before resuming mining or declaring the request satisfied.
 */
export async function castOntoPool(
  bot: Bot,
  physics: CastPhysics,
  sources: readonly BlockPosition[],
): Promise<CastOutcome> {
  const item = carried(bot, "water_bucket");
  if (!item) return { kind: "failed", reason: "the bucket holds no water" };
  const keys = new Set(sources.map(cellKey));
  const accepts = (landing: Vec3) => castScore(bot, keys, landing);

  let aim = pourAim(bot, accepts);
  for (let opened = 0; aim === null && opened < EXPOSING_BREAKS; opened += 1) {
    const source = nearestSource(bot, sources);
    const blocking = source === null ? null : firstSolidTowards(bot, source);
    if (blocking === null) break;
    const swing = await physics.breakInPlace({
      movements: physics.movements,
      position: blocking,
      ...(physics.signal && { signal: physics.signal }),
    });
    if (swing.status === "failed") {
      return {
        kind: "reposition",
        reason: `${cellKey(blocking)} is in the way and could not be opened: ${swing.reason}`,
      };
    }
    aim = pourAim(bot, accepts);
  }
  if (aim === null) return { kind: "reposition", reason: "no pour from here lands on the pool" };

  // The newly poured flow can otherwise carry the bot away while formations
  // settle, leaving both the original scoop ray and the bucket out of reach.
  const releaseStance = holdWaterPosition(bot, physics.signal);
  try {
    const before = countFormations(bot, aim.landing);
    const use = await physics.useItem(bot, {
      item,
      lookAt: aim.lookAt,
      expectedCells: [{ position: aim.landing, matches: (block) => block.name === "water" }],
      expectedHeldItem: "bucket",
      ...(physics.signal && { signal: physics.signal }),
    });
    if (use.kind === "failed") return { kind: "failed", reason: use.error };
    // Water spreads for a while and turns every source it reaches; counting the
    // obsidian is this step's evidence that the pour was worth anything.
    const after = await settledFormations(bot, aim.landing, physics.signal);
    return {
      kind: "cast",
      landing: aim.landing,
      obsidianFormed: Math.max(0, after.obsidian - before.obsidian),
      waterRecovered: await scoopBack(bot, physics, aim),
    };
  } finally {
    releaseStance();
  }
}
