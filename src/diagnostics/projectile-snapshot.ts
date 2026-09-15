import type { Bot } from "mineflayer";
import { arrowFlight } from "../survival/perception/combat/arrow-flight.js";
import { arrowImpactInTicks } from "../survival/perception/combat/shield-projectiles.js";

/** Compact incident evidence. Freshness belongs to the production flight tracker. */
export function projectileSnapshot(bot: Bot, entity: Bot["entity"]) {
  if (entity.name !== "arrow" && entity.name !== "spectral_arrow") return undefined;
  const now = performance.now();
  const estimate = arrowFlight(bot, entity, now);
  return {
    // Zero-displacement packets do not refresh the flight anchor.
    positionAgeMs: estimate.positionAt === null ? null : now - estimate.positionAt,
    velocityAgeMs: estimate.velocityAt === null ? null : now - estimate.velocityAt,
    prediction: { basis: "elapsed_flight_estimate", position: estimate.position, velocity: estimate.velocity,
      movementAllowance: 0, impactInTicks: arrowImpactInTicks(bot, entity) },
  };
}
