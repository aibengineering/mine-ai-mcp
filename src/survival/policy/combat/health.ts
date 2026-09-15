import type { CombatPolicy } from "./contract.js";

/** A configured recovery target cannot resume a hostile pursuit below its admission threshold. */
export function recoveryHealth(policy: Readonly<CombatPolicy>): number {
  return Math.max(policy.recover_to_health, policy.engage_min_health);
}

/** The same threshold governs admission, suspension and recovery completion. */
export function needsCombatRecovery(health: number, minimum: number): boolean {
  return health > 0 && health < minimum;
}

export function guardHealthRefusal(health: number, policy: Readonly<CombatPolicy>): string | null {
  return health < policy.critical_health ? `Stationary projectile guard reached ${health} health.` : null;
}
