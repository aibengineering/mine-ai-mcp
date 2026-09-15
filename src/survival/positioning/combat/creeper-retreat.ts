/** Loaded terrain and crowd geometry for a creeper escape. No controls or policy. */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { isHostile } from "../../perception/combat/threats.js";
import { isCreeper, type CreeperObservation } from "../../perception/combat/creepers.js";
type Entity = Bot["entity"];
const RETREAT_HEADING_FAN_DEGREES = [0, 45, -45, 90, -90];
function groundAheadIsSafe(bot: Bot, heading: Vec3): boolean {
  // The endpoint can lie beyond a corner or a one-block wall. Check the
  // body's swept width, so a visible cell beyond it does not admit a sprint.
  const half = (bot.entity.width ?? 0.6) / 2 - 0.01;
  for (const distance of [0.3, 0.6, 0.9, 1.2]) {
    const ahead = bot.entity.position.plus(heading.scaled(distance));
    for (const x of [-half, half]) for (const z of [-half, half]) {
      const at = ahead.offset(x, 0, z);
      const feet = bot.blockAt(at);
      const head = bot.blockAt(at.offset(0, 1, 0));
      const floor = bot.blockAt(at.offset(0, -1, 0));
      const below = bot.blockAt(at.offset(0, -2, 0));
      if (!feet || !head || !floor || !below) return false;
      if ([feet, head, floor].some(block => block.name === "water" || block.name === "lava")) return false;
      if (feet.boundingBox !== "empty" || head.boundingBox !== "empty") return false;
      if (floor.boundingBox !== "block" && below.boundingBox !== "block") return false;
    }
  }
  return true;
}

/** Rotate a horizontal heading about the vertical axis. */
function rotated(heading: Vec3, degrees: number): Vec3 {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return new Vec3(heading.x * cos - heading.z * sin, 0, heading.x * sin + heading.z * cos);
}



/** Do not commit the next few sprint steps through another mob's body.
 * When already in contact, allow headings that increase separation. */
function clearsCrowd(bot: Bot, heading: Vec3, crowd: readonly Entity[]): boolean {
  return crowd.every((entity) => {
    if (Math.abs(entity.position.y - bot.entity.position.y) > 2) return true;
    const toward = entity.position.minus(bot.entity.position); toward.y = 0;
    const along = toward.dot(heading);
    if (along <= 1e-10) return true;
    const closest = toward.minus(heading.scaled(Math.min(along, 2.5)));
    return closest.norm() >= ((bot.entity.width ?? 0.6) + (entity.width ?? 0.6)) / 2 + 0.6;
  });
}



export function creeperRetreatHeading(bot: Bot, nearby: readonly CreeperObservation[], committed: Vec3 | null, dead: ReadonlySet<number>): Vec3 | null {
  // Crowd separation ranks the headings that clear the fuses. Its weighted
  // sum can point toward an individual threat, so it cannot by itself
  // establish that a heading separates from a creeper.
  const away = new Vec3(0, 0, 0);
  const threats = new Map<number, { id: number; position: Vec3 }>();
  const crowd = Object.values(bot.entities).filter(entity => entity.isValid && !dead.has(entity.id) && isHostile(entity) && !isCreeper(entity) && entity.position.distanceTo(bot.entity.position) <= 16);
  for (const threat of [...nearby, ...crowd]) threats.set(threat.id, threat);
  for (const threat of threats.values()) {
    const separation = bot.entity.position.minus(threat.position);
    separation.y = 0;
    const distance = Math.max(separation.norm(), 0.5);
    away.add(separation.scaled(1 / (distance * distance)));
  }
  const swelling = nearby.filter((threat) => threat.swelling);
  const fuses = swelling.length > 0 ? swelling : nearby;
  const fuseAway = new Vec3(0, 0, 0);
  for (const threat of fuses) {
    const separation = bot.entity.position.minus(threat.position);
    separation.y = 0;
    const distance = Math.max(separation.norm(), 0.5);
    fuseAway.add(separation.scaled(1 / (distance * distance)));
  }
  const separatesFromFuses = (heading: Vec3) =>
    fuses.every((threat) => {
      const separation = bot.entity.position.minus(threat.position);
      separation.y = 0;
      // A perpendicular heading is valid; tolerate floating-point rotation error.
      return heading.dot(separation) >= -1e-10;
    });
  const candidates =
    fuseAway.norm() < 0.01
      ? []
      : RETREAT_HEADING_FAN_DEGREES.map((degrees) => rotated(fuseAway.normalize(), degrees));
  if (away.norm() >= 0.01) candidates.unshift(away.normalize());
  const viable = candidates.filter((heading) => separatesFromFuses(heading) && groundAheadIsSafe(bot, heading) && clearsCrowd(bot, heading, crowd));
  viable.sort((a, b) => b.dot(away) - a.dot(away));
  const heading =
    committed && separatesFromFuses(committed) && groundAheadIsSafe(bot, committed) && clearsCrowd(bot, committed, crowd)
      ? committed : (viable[0] ?? null);
  return heading;
}
