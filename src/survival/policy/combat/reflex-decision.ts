import type { ResponseDecision } from "../../control/contract.js";
import { combatResponseExclusions, type CombatDecisionFacts } from "./decision.js";
import type { EvadeReason, HideReason, HostileDirective, HostileResponse } from "./response.js";

export interface HostileDecisionFacts {
  readonly facts: CombatDecisionFacts;
  readonly directive: HostileDirective;
  readonly settling: boolean;
  readonly combatOwnsBody: boolean;
  readonly entries: readonly { readonly response: string; readonly entry: number }[];
}

/** Admission gates use the same captured observation as response selection and its receipt. */
export function decideHostileReflex(observed: HostileDecisionFacts): ResponseDecision<HostileResponse> {
  const { facts, directive } = observed;
  if (observed.settling) return { kind: "handled", by: "policy_settlement" };
  if (observed.combatOwnsBody) return { kind: "handled", by: "combat" };
  if (directive.kind === "none") return { kind: "handled", by: "no_contact" };
  if (directive.kind === "constrained")
    return {
      kind: "stand_down",
      candidates: combatResponseExclusions(
        facts,
        directive.reason,
        new Map(observed.entries.map(({ response, entry }) => [response, entry])),
      ),
    };
  // Where the threat stood is what lets a caller judge the withdrawal: the same
  // skeleton five blocks away and forty blocks away are different decisions.
  const names = directive.threats
    .map(
      (threat) =>
        `${threat.name}#${threat.id} at ${Math.floor(threat.position.x)},${Math.floor(threat.position.y)},${Math.floor(threat.position.z)}` +
        ` (${Math.round(threat.distance * 10) / 10} blocks)`,
    )
    .join(", ");
  const why = "reason" in directive ? ` (${describeDirectiveReason(directive.reason)})` : "";
  return {
    kind: "respond",
    response: directive,
    name: directive.kind,
    reason: `[HOSTILE_CONTACT] ${directive.kind} response for ${names}${why}.`,
  };
}

/**
 * The decision's own reason, spelled out for the caller whose request it
 * interrupts. Every action returns the interruption verbatim, so this is the
 * one place that decides whether a model can tell a withdrawal it should
 * accept from one it should fix with a policy edit or a different request.
 */
export function describeDirectiveReason(reason: EvadeReason | HideReason | "incoming_fireball"): string {
  switch (reason) {
    case "hurt":
      return "hurt: health is below the engagement minimum";
    case "creeper":
      return "creeper: creeper contact without a safe weapon answer";
    case "unreachable":
      return "unreachable: no fight answer remains for this contact";
    case "observed_aggression":
      return "observed_aggression: aggression without attack authorization";
    case "withdraw":
      return "withdraw: no permitted attack, or defend_only engagement out of reach";
    case "cornered":
      return "cornered: withdrawal already answered";
    case "incoming_fireball":
      return "incoming fireball";
  }
}
