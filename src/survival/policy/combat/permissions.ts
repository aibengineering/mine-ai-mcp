import { isDeepStrictEqual } from "node:util";
import type { CombatPolicy } from "./contract.js";
export function permitsHide(policy: Readonly<CombatPolicy>, recoveryAvailable: boolean): boolean {
  return (
    policy.hide === "when_exposed" ||
    (policy.hide === "when_recovery_possible" && policy.recover !== "never" && recoveryAvailable)
  );
}

/** Keep weapon eligibility identical in ordinary, prepared, and retreat combat. */
export function permittedCombatItems<Item extends { name: string }>(
  items: readonly Item[],
  policy: Readonly<CombatPolicy>,
): Item[] {
  return items.filter((item) => (item.name === "bow" ? policy.bow : item.name === "shield" ? policy.shield : true));
}

/** Only changed permissions consumed by this response require physical reconciliation. */
export function responsePolicyChanged(
  before: Readonly<CombatPolicy>,
  after: Readonly<CombatPolicy>,
  response: "fight" | "hide" | "evade" | "deflect",
): boolean {
  return !isDeepStrictEqual(responsePermissions(before, response), responsePermissions(after, response));
}

/** The same projection governs active settlement and failed-scope invalidation. */
export function responsePermissions(policy: Readonly<CombatPolicy>, response: "fight" | "hide" | "evade" | "deflect") {
  if (response === "deflect") return { melee: policy.melee };
  const terrain = { melee: policy.melee, dig: policy.terrain.dig, place: policy.terrain.place };
  const recovery = {
    recover: policy.recover,
    engage_min_health: policy.engage_min_health,
    recover_to_health: policy.recover_to_health,
    recovery_timeout_ms: policy.recovery_timeout_ms,
  };
  if (response === "hide") return { ...terrain, ...recovery, hide: policy.hide };
  const defence = {
    ...terrain,
    shield: policy.shield,
    retreat: policy.retreat,
    critical_health: policy.critical_health,
  };
  return response === "evade"
    ? { ...defence, evade_timeout_ms: policy.evade_timeout_ms, evade_safe_range: policy.evade_safe_range }
    : {
        ...defence,
        engagement: policy.engagement,
        bow: policy.bow,
        ...recovery,
        protected_wait_ticks: policy.protected_wait_ticks,
        enderman_wait_ticks: policy.enderman_wait_ticks,
        volley_wait_ticks: policy.volley_wait_ticks,
      };
}
