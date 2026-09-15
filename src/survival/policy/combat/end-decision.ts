import type { CombatPolicy } from "./contract.js";

export type EndResponse =
  | { readonly kind: "continue" }
  | { readonly kind: "evade" }
  | { readonly kind: "constrained"; readonly field: "retreat" | "melee" | "bow" | "melee,bow"; readonly reason: string };

/** The End request and its reflex share authority at each physical boundary. */
export function decideEndResponse(
  policy: Readonly<CombatPolicy>,
  danger: boolean,
  request: "crystal" | "perch" | "bow" | "evade",
): EndResponse {
  if (danger)
    return policy.retreat
      ? { kind: "evade" }
      : { kind: "constrained", field: "retreat", reason: "[COMBAT_CONSTRAINED] Combat retreat is prohibited." };
  if (request === "perch" && !policy.melee)
    return { kind: "constrained", field: "melee", reason: "[COMBAT_CONSTRAINED] Melee is prohibited." };
  if (request === "bow" && !policy.bow)
    return { kind: "constrained", field: "bow", reason: "[COMBAT_CONSTRAINED] Bow use is prohibited." };
  if (request === "crystal" && !policy.melee && !policy.bow)
    return {
      kind: "constrained",
      field: "melee,bow",
      reason: "[COMBAT_CONSTRAINED] Both crystal attack methods are prohibited.",
    };
  return { kind: "continue" };
}
