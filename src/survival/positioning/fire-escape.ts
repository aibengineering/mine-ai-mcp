import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { isHeadPassable, isPassable, isSafeSupport, type WorldView } from "../../navigation/index.js";
import { cellIntersectsBody } from "../../utils/geometry.js";
import { advancingLavaAt } from "../../world/lava-flow.js";
import { isInFire, isInLava } from "../perception/body.js";

/** A local escape borrows navigation's live world and block geometry. */
export interface FireEscapeDeparture {
  readonly position: Vec3;
  readonly inLava: boolean;
}

export function fireEscapeDeparture(bot: Bot): FireEscapeDeparture {
  return { position: bot.entity.position.clone(), inLava: isInLava(bot) };
}

export function clearFireEscape(
  bot: Bot,
  world: WorldView,
  target: Vec3,
  departure: FireEscapeDeparture = fireEscapeDeparture(bot),
): boolean {
  const start = bot.entity.position;
  const { inLava } = departure;
  const body = { position: departure.position, width: bot.entity.width ?? 0.6, height: bot.entity.height ?? 1.8 };
  const radius = body.width / 2;
  const distance = start.distanceTo(target);
  const steps = Math.max(1, Math.ceil(distance / 0.25));
  for (let step = 0; step <= steps; step++) {
    const p = start.plus(target.minus(start).scaled(step / steps));
    for (const x of [Math.floor(p.x - radius + 0.001), Math.floor(p.x + radius - 0.001)])
      for (const z of [Math.floor(p.z - radius + 0.001), Math.floor(p.z + radius - 0.001)]) {
        const floor = world.blockAt(x, Math.floor(p.y - 1), z);
        if (
          !isSafeSupport(floor) &&
          !(
            floor.kind === "loaded" &&
            (floor.traits.liquid === "water" || (step < steps && inLava && floor.traits.liquid === "lava"))
          )
        )
          return false;
        // Jump headroom is not the body's path. A raised destination must
        // still reject newly entered fire at foot level along the approach.
        for (let y = Math.floor(p.y); y <= Math.floor(p.y + body.height - 0.001); y++) {
          const block = world.blockAt(x, y, z);
          if (block.kind !== "loaded") return false;
          if (!block.traits.damaging || (step < steps && inLava && block.traits.liquid === "lava")) continue;
          if (
            step < steps &&
            block.collisionShapes.length === 0 &&
            block.traits.liquid === null &&
            cellIntersectsBody({ x, y, z }, body)
          )
            continue;
          return false;
        }
        // The original swimming/jumping response can climb one block. Check
        // its raised corridor; longer routes still belong to navigation.
        for (const y of [
          Math.floor(Math.max(start.y, target.y) + 0.1),
          Math.floor(Math.max(start.y, target.y) + 1.7),
        ]) {
          const block = world.blockAt(x, y, z);
          if (block.kind !== "loaded") return false;
          if (isPassable(block) && isHeadPassable(block)) continue;
          if (step < steps && inLava && block.traits.liquid === "lava") continue;
          // Leaving an occupied fire cell necessarily overlaps that cell on
          // the way out. Never admit a new damaging cell or a burning destination.
          if (
            step < steps &&
            block.traits.damaging &&
            block.collisionShapes.length === 0 &&
            block.traits.liquid === null &&
            cellIntersectsBody({ x, y, z }, body)
          )
            continue;
          return false;
        }
      }
  }
  return true;
}

/** Immediate swimming/jumping reach; longer journeys belong to navigation. */
export type FireEscapeReason = "contact" | "advancing_lava";
export const FIRE_ESCAPE_RADIUS = 4;

export function nearbyFireEscape(bot: Bot, world: WorldView, reason: FireEscapeReason = "contact"): Vec3 | null {
  const origin = bot.entity.position.floored();
  const needsDryEscape = reason === "advancing_lava" || isInLava(bot) || isInFire(bot);
  const water: Vec3[] = [];
  const dry: Vec3[] = [];
  for (let dx = -FIRE_ESCAPE_RADIUS; dx <= FIRE_ESCAPE_RADIUS; dx++)
    for (let dz = -FIRE_ESCAPE_RADIUS; dz <= FIRE_ESCAPE_RADIUS; dz++)
      for (let dy = -1; dy <= 1; dy++) {
        const cell = origin.offset(dx, dy, dz);
        const feet = world.blockAt(cell.x, cell.y, cell.z);
        const head = world.blockAt(cell.x, cell.y + 1, cell.z);
        const floor = world.blockAt(cell.x, cell.y - 1, cell.z);
        if (feet.kind !== "loaded" || !isHeadPassable(head)) continue;
        const point = cell.offset(0.5, 0, 0.5);
        if (reason === "advancing_lava" && advancingLavaAt(bot, point)) continue;
        if (feet.traits.liquid === "water") water.push(point);
        else if (needsDryEscape && isPassable(feet) && isSafeSupport(floor)) dry.push(point);
      }
  const nearest = (a: Vec3, b: Vec3) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position);
  return [...water.sort(nearest), ...dry.sort(nearest)].find((point) => clearFireEscape(bot, world, point)) ?? null;
}
