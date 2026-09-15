import { SHIELD_READY_TICKS } from "./item-use.js";
import { HEAD_TURN_LEAD_TICKS, type observeProjectileDefence } from "./shield-facing.js";

/** A shot must leave time to restore protection, not merely release its arrow. */
export function assessBowWindow(
  defence: ReturnType<typeof observeProjectileDefence>,
  remainingDrawTicks: number,
  uncertainVolley = false,
) {
  const requiredTicks = remainingDrawTicks + SHIELD_READY_TICKS + HEAD_TURN_LEAD_TICKS + 2;
  const threats = [
    ...(defence?.projectiles.map(({ entity, impactInTicks }) => ({ id: entity.id,
      // Fireballs accelerate; their current-speed quotient is not a safe deadline.
      ticks: entity.name === "small_fireball" ? 0 : impactInTicks })) ?? []),
    ...(defence?.windupForecasts.map(({ entity, impactInTicks }) => ({ id: entity.id, ticks: impactInTicks })) ?? []),
  ].sort((a, b) => a.ticks - b.ticks);
  const earliest = threats[0];
  const held = (defence?.holdRemainingTicks ?? 0) > 0;
  return {
    safe: !uncertainVolley && !held && (!earliest || earliest.ticks > requiredTicks),
    requiredTicks,
    impactInTicks: earliest?.ticks ?? null,
    threatId: earliest?.id ?? defence?.heldProjectileId ?? null,
    reason: uncertainVolley ? "uncertain_volley" : held ? "held_impact" : earliest ? "predicted_impact" : "clear",
  };
}
