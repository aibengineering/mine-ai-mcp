/** Survival's public capabilities; runtime composition attaches its required lifetimes. */
export type {
  CombatController,
  CombatDecision,
  CombatEngagement,
  CombatOutcome,
} from "./combat/contract.js";
export * from "./combat/controller.js";

export * from "./perception/combat/threats.js";
export type { HostileResponse } from "./policy/combat/response.js";
export * from "./positioning/combat/hostile-field.js";
export { HOSTILE_REFLEX, attachHostileReflex, type HostileReflex } from "./reflexes/hostile.js";
export type { CombatStyle } from "./weapons/equipment.js";
export { carriesCombatWeapon, carriesRangedWeapon } from "./weapons/equipment.js";
