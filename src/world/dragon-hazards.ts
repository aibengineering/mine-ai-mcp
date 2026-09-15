import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { Position3 } from "../navigation/world/world.js";
import { dragonPhase, entityMetadata, isDragonPerched, observedDragonLandingCenter, perchedDragonHeadPosition } from "./end-fight.js";

export interface DragonCloud {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
}

/** Vanilla cloud damage checks a horizontal radius and a half-block-high box. */
export function cloudExposure(cloud: DragonCloud, feet: Position3, jumpClearance = 0): number {
  if (feet.y >= cloud.y + 0.5 || feet.y + 1.8 + jumpClearance <= cloud.y) return 0;
  // Include the player's half width so routes do not skim the visible edge.
  return Math.max(0, cloud.radius + 0.3 - Math.hypot(feet.x - cloud.x, feet.z - cloud.z));
}

/** Dragon particles identify native dragon clouds; ordinary potion clouds are not assumed harmful. */
export function readDragonClouds(bot: Bot): DragonCloud[] {
  const clouds: DragonCloud[] = [];
  for (const entity of Object.values(bot.entities)) {
    if (!entity.isValid || entity.name !== "area_effect_cloud") continue;
    const particle = entityMetadata(bot, entity, "particle");
    const id = typeof particle === "object" && particle !== null && "type" in particle ? particle.type : null;
    if (id !== "dragon_breath") continue;
    const radius = entityMetadata(bot, entity, "radius");
    if (typeof radius !== "number" || radius <= 0) continue;
    clouds.push({ id: entity.id, ...entity.position, radius });
  }
  return clouds;
}

/** Vanilla 1.21.4 perched clouds stay exactly radius five. Fireball clouds
 * start at three and grow toward seven over their lifetime; reserve that
 * footprint once so their per-tick growth does not repeatedly cancel escape.
 * Keep raw observed radii in readDragonClouds for status and shot evidence. */
export function readDragonCloudHazards(bot: Bot): DragonCloud[] {
  return readDragonClouds(bot).map((cloud) => ({
    ...cloud,
    radius: cloud.radius === 5 ? 5 : Math.max(7, cloud.radius),
  }));
}

/** Native roar (phase 7) precedes flaming (5); the cloud spawns ten ticks
 * into flaming and waits twenty more before damage. Keep the warning through
 * flaming so there is no safe-looking gap before its entity arrives.
 * The native cloud lies 2.5 blocks beyond the head, on the floor beneath it.
 * Seven blocks include the uncertainty in our transmitted-pose head estimate. */
export function readDragonBreathHazards(bot: Bot): DragonCloud[] {
  const clouds = readDragonCloudHazards(bot);
  for (const dragon of readDragonBodies(bot)) {
    if ((dragon.phase !== 7 && dragon.phase !== 5) || !dragon.head) continue;
    const outward = dragon.head.minus(dragon.position);
    const length = Math.hypot(outward.x, outward.z);
    const center = dragon.head.offset((outward.x / length) * 2.5, 0, (outward.z / length) * 2.5);
    // Vanilla searches downward from the head to its supporting floor. Only
    // loaded terrain supplies that height; never manufacture a safe tunnel.
    for (let y = Math.floor(center.y); y >= 0; y--) {
      const block = bot.blockAt(new Vec3(center.x, y, center.z));
      if (!block) break;
      if (block.boundingBox !== "block") continue;
      // Once its native cloud arrives, use that observation rather than
      // retaining a second estimated cloud at a slightly different position.
      const observed =
        dragon.phase === 5 &&
        clouds.some(
          (cloud) => Math.hypot(cloud.x - center.x, cloud.z - center.z) <= 7 && Math.abs(cloud.y - (y + 1)) <= 2,
        );
      if (!observed) clouds.push({ id: dragon.id, x: center.x, y: y + 1, z: center.z, radius: 7 });
      break;
    }
  }
  return clouds;
}

/** The route and combat read the same geometric predicate, including still-waiting clouds. */
export function dragonExposure(bot: Bot, feet: Position3): number {
  return readDragonBreathHazards(bot).reduce((sum, cloud) => sum + cloudExposure(cloud, feet), 0);
}

function readDragonBodies(bot: Bot) {
  return Object.values(bot.entities)
    .filter((e) => e.isValid && e.name === "ender_dragon")
    .map((e) => ({
      id: e.id,
      position: e.position.clone(),
      velocity: e.velocity.clone(),
      yaw: e.yaw,
      phase: dragonPhase(bot, e),
      head: perchedDragonHeadPosition(bot, e),
      landingCenter: dragonPhase(bot, e) === 3 ? observedDragonLandingCenter(bot) : null,
    }));
}
function readDragonFireballs(bot: Bot) {
  return Object.values(bot.entities)
    .filter((e) => e.isValid && e.name === "dragon_fireball")
    .map((e) => ({ id: e.id, position: e.position.clone(), velocity: e.velocity.clone() }));
}

/** Perched head/neck damage boxes and wing knockback boxes from vanilla 1.21.4.
 * Flight history is not transmitted, so this deliberately makes no flying-part claim. */
export function perchedDragonContact(bot: Bot, feet: Position3): boolean {
  return bodyContact(readDragonBodies(bot), feet);
}

function bodyContact(bodies: ReturnType<typeof readDragonBodies>, feet: Position3): boolean {
  const overlaps = (x: number, y: number, z: number, halfWidth: number, height: number) =>
    feet.y < y + height &&
    feet.y + 1.8 > y &&
    Math.abs(feet.x - x) < halfWidth + 0.3 &&
    Math.abs(feet.z - z) < halfWidth + 0.3;
  for (const dragon of bodies) {
    const head = dragon.head;
    if (!head) continue;
    if (overlaps(head.x, head.y - 1, head.z, 1.5, 3)) return true;
    const neck = dragon.position.offset(Math.sin(dragon.yaw) * 5.5, -1, Math.cos(dragon.yaw) * 5.5);
    if (overlaps(neck.x, neck.y - 1, neck.z, 2.5, 5)) return true;
    for (const side of [-1, 1]) {
      const wing = dragon.position.offset(Math.cos(dragon.yaw) * 4.5 * side, -2, -Math.sin(dragon.yaw) * 4.5 * side);
      if (overlaps(wing.x, wing.y, wing.z, 6, 6)) return true;
    }
  }
  return false;
}

/** Two seconds cover walking clear of a seven-block cloud. Native dragon
 * fireballs accelerate, so constant current velocity predicts danger too late. */
export function incomingDragonFireballs(bot: Bot, feet = bot.entity.position) {
  return incomingFireballs(readDragonFireballs(bot), feet);
}

function incomingFireballs(projectiles: ReturnType<typeof readDragonFireballs>, feet: Vec3) {
  return projectiles.filter((entity) => {
    const delta = feet.offset(0, 0.9, 0).minus(entity.position);
    let speed = entity.velocity.norm();
    if (speed === 0) return entity.position.distanceTo(feet) < 7;
    const direction = entity.velocity.scaled(1 / speed);
    const along = delta.dot(direction);
    let travel = 0;
    for (let tick = 0; tick < 40; tick++) {
      speed = (speed + 0.1) * 0.95;
      travel += speed;
    }
    return along >= 0 && along <= travel + 7 && delta.minus(direction.scaled(along)).norm() < 7;
  });
}

/** A conservative corridor for low flying/charging bodies, not reconstructed
 * flying hitboxes. Three seconds allow walking sideways out of the inflated
 * twelve-block wing corridor before the recorded native charge reaches us. */
export function incomingDragonBodies(bot: Bot, feet = bot.entity.position) {
  return incomingBodies(readDragonBodies(bot), feet);
}

function incomingBodies(bodies: ReturnType<typeof readDragonBodies>, feet: Vec3) {
  return bodies.filter((dragon) => {
    if (isDragonPerched(dragon.phase)) return false;
    if (dragon.landingCenter) {
      // Landing converges on the observed fountain, not a straight velocity
      // ray. Extrapolating that curved descent repeatedly declared cells under
      // the arriving wings safe, then steered an idle bot back toward them.
      // Reserve the same conservative body corridor at the destination and
      // current body. Its lower bound leaves the prepared low notch usable.
      return [dragon.position, dragon.landingCenter].some(center =>
        feet.y < center.y + 5 && feet.y + 1.8 > center.y - 5 &&
        Math.hypot(feet.x - center.x, feet.z - center.z) < 12);
    }
    const v = dragon.velocity;
    const dx = feet.x - dragon.position.x,
      dz = feet.z - dragon.position.z;
    const speed = v.x * v.x + v.z * v.z;
    const nearest = speed === 0 ? 0 : Math.max(0, Math.min(60, (dx * v.x + dz * v.z) / speed));
    return [0, nearest].some((ticks) => {
      const y = dragon.position.y + v.y * ticks;
      return feet.y < y + 5 && feet.y + 1.8 > y - 5 && Math.hypot(dx - v.x * ticks, dz - v.z * ticks) < 12;
    });
  });
}

/** A search must keep its hazard geometry fixed. Its next resolution gets a
 * new identity if moving bodies, projectiles or clouds change the question. */
export function observeDragonEscape(bot: Bot) {
  const clouds = readDragonBreathHazards(bot).map((c) => ({ ...c, radius: Math.max(7, c.radius) + 0.5 }));
  const bodies = readDragonBodies(bot);
  const projectiles = readDragonFireballs(bot);
  return {
    revision: JSON.stringify({ clouds, bodies, projectiles }),
    contactAt: (feet: Vec3) => bodyContact(bodies, feet),
    clearAt: (feet: Vec3) =>
      clouds.every((c) => cloudExposure(c, feet) === 0) &&
      incomingFireballs(projectiles, feet).length === 0 &&
      incomingBodies(bodies, feet).length === 0 &&
      !bodyContact(bodies, feet),
  };
}

export function dragonDanger(bot: Bot): boolean {
  return (
    dragonExposure(bot, bot.entity.position) > 0 ||
    incomingDragonFireballs(bot).length > 0 ||
    incomingDragonBodies(bot).length > 0 ||
    perchedDragonContact(bot, bot.entity.position)
  );
}
