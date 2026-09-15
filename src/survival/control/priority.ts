/** Higher urgency can cancel a lower takeover, but must await its physical release. */
export const REFLEX_PRIORITY = [
  "fire_reflex",
  "breath_reflex",
  "recover_footing",
  "dragon_reflex",
  "hostile_reflex",
  "hunger_reflex",
] as const;

export function outranksReflex(requested: string, current: string): boolean {
  const requestedRank = REFLEX_PRIORITY.findIndex((name) => name === requested);
  const currentRank = REFLEX_PRIORITY.findIndex((name) => name === current);
  return requestedRank >= 0 && currentRank >= 0 && requestedRank < currentRank;
}
