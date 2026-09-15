type Entity = Parameters<Bot["attack"]>[0];
import type { Bot } from "mineflayer";
import type { Item } from "prismarine-item";
import { Vec3 } from "vec3";
import { entityDimensions } from "../../world/entity-dimensions.js";
import { type PositionThreat } from "../positioning/combat/exposure.js";
import { shieldCoverage } from "./shield-facing.js";
const ENDERMAN_EYE_HEIGHT = 2.55;
const SHIELD_ARC_COSINE = Math.cos((70 * Math.PI) / 180);
export function aimPoint(bot: Bot, target: Entity) {
  const height =
    target.name === "enderman" ? ENDERMAN_EYE_HEIGHT : Math.max(0.5, entityDimensions(bot, target).height / 2);
  return target.position.offset(0, height, 0);
}

export function shieldAnswersThreats(bot: Bot, shield: Item | null, threats: readonly PositionThreat[]): boolean {
  return (
    shield !== null &&
    shieldCoverage(
      bot.entity.position,
      threats.map((threat) => threat.position),
    ).coversAll
  );
}

export function facing(bot: Bot, target: Entity): boolean {
  const look = new Vec3(-Math.sin(bot.entity.yaw), 0, -Math.cos(bot.entity.yaw));
  const toward = target.position.minus(bot.entity.position);
  toward.y = 0;
  const distance = toward.norm();
  if (distance < 0.01) return true;
  return look.dot(toward.scaled(1 / distance)) >= SHIELD_ARC_COSINE;
}
