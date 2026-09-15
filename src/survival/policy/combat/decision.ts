import type { ResponseExclusion } from "../../control/contract.js";
import type { Facts } from "../../state/answered.js";
import type { CombatPolicy } from "./contract.js";
import { needsCombatRecovery } from "./health.js";
import type { EvadeReason, HostileDirective, HostileThreat } from "./response.js";
import { compareTargets, type TargetFacts } from "./target-utility.js";

/** Intent authorizes a quarry; automatic engagement permission does not erase it. */
export type CombatPurpose =
  /** `quarry` names species an admitted hunt is deliberately pursuing; contact with them is fought, not fled. */
  | { readonly kind: "automatic"; readonly quarry?: readonly string[] }
  | { readonly kind: "pursuit"; readonly targetId: number; readonly minimumHealth: number }
  | { readonly kind: "contact_defence"; readonly targetId: number }
  | { readonly kind: "recovery"; readonly targetId: number | null }
  | { readonly kind: "handoff" };

export interface CombatContact extends HostileThreat {
  readonly relationship: {
    readonly avoid: boolean;
    readonly defend: boolean;
    readonly attention: "on_sight" | "observed_attack" | "inferred_head_gaze" | "unknown";
  };
  readonly inContact: boolean;
  readonly inReach: boolean;
  readonly defendsOnContact: boolean;
  readonly ranged: boolean;
  readonly utility: TargetFacts;
}

/** A single observation is consumed by a pure decision. No controls or world reads here. */
export interface CombatDecisionFacts {
  readonly policy: Readonly<CombatPolicy>;
  readonly health: number;
  readonly burning: boolean;
  readonly hideAllowed: boolean;
  readonly recoveryAvailable: boolean;
  readonly weapon: boolean;
  readonly rangedWeapon: boolean;
  readonly shield: boolean;
  readonly contacts: readonly CombatContact[];
  readonly fireball: HostileThreat | null;
  readonly unreachable: ReadonlySet<number>;
  /** Target -> retained failed-fight entry for the current scope, independently of reachability. */
  readonly answeredFights: ReadonlyMap<number, number>;
  readonly answered: ReadonlySet<string>;
}

/** Automatic defence can hold contact without authorizing a pursuit at low health. */
export function decideFightMovement(facts: {
  readonly policy: Readonly<CombatPolicy>;
  readonly health: number;
  readonly target: { readonly name: string; readonly defendsOnContact: boolean } | null;
}): "hold" | "pursue" {
  return facts.policy.engagement === "defend_only" ||
    needsCombatRecovery(facts.health, facts.policy.engage_min_health) ||
    (!facts.policy.melee && !facts.policy.bow) ||
    facts.target?.defendsOnContact ||
    facts.target?.name === "enderman"
    ? "hold"
    : "pursue";
}

/** The exact pure inputs and output, converted once at the receipt boundary. */
export function combatDecisionEvidence(
  facts: CombatDecisionFacts,
  purpose: CombatPurpose,
  decision: HostileDirective,
): Facts {
  return {
    purpose: { ...purpose },
    inputs: {
      ...facts,
      policy: { ...facts.policy, terrain: { ...facts.policy.terrain } },
      contacts: facts.contacts.map((contact) => ({
        ...contact,
        position: { ...contact.position },
        relationship: { ...contact.relationship },
        utility: { ...contact.utility },
      })),
      fireball: facts.fireball ? { ...facts.fireball, position: { ...facts.fireball.position } } : null,
      unreachable: [...facts.unreachable],
      answeredFights: [...facts.answeredFights],
      answered: [...facts.answered],
    },
    decision:
      "threats" in decision
        ? { ...decision, threats: decision.threats.map((threat) => ({ ...threat, position: { ...threat.position } })) }
        : { ...decision },
  };
}

/** Explain a refused automatic decision using its actual permissions and retained answers. */
export function combatResponseExclusions(
  facts: CombatDecisionFacts,
  reason: string,
  entries: ReadonlyMap<string, number>,
): readonly { response: string; excluded: ResponseExclusion }[] {
  const unavailable = { kind: "infeasible_now", premise: reason } as const;
  const answered = (response: string, fallback: ResponseExclusion): ResponseExclusion => {
    const entry = entries.get(response);
    return entry === undefined ? fallback : { kind: "answered", entry };
  };
  const policy = facts.policy;
  const hide: ResponseExclusion =
    policy.hide === "never"
      ? { kind: "prohibited", field: "hide" }
      : policy.hide === "when_recovery_possible" && policy.recover === "never"
        ? { kind: "prohibited", field: "recover" }
        : !facts.hideAllowed
          ? { kind: "missing_equipment", item: "food or an observed source of regeneration" }
          : answered("hide", answered("recovery", unavailable));
  const fight: ResponseExclusion =
    !policy.melee && !policy.bow ? { kind: "prohibited", field: "melee,bow" } : answered("fight", unavailable);
  const evade: ResponseExclusion = !policy.retreat
    ? { kind: "prohibited", field: "retreat" }
    : answered("evade", unavailable);
  return [
    { response: "fight", excluded: fight },
    { response: "hide", excluded: hide },
    { response: "evade", excluded: evade },
    ...(facts.fireball
      ? [
          {
            response: "deflect",
            excluded: !policy.melee
              ? { kind: "prohibited" as const, field: "melee" }
              : answered("deflect", unavailable),
          },
        ]
      : []),
  ];
}

export function decideCombatResponse(facts: CombatDecisionFacts, purpose: CombatPurpose): HostileDirective {
  const { policy, contacts, health, answered } = facts;
  const fightAnswered = (targetId: number) => answered.has("fight") || facts.answeredFights.has(targetId);
  const threats = contacts.map(({ id, name, position, distance }) => ({ id, name, position, distance }));
  const blocked = (why: string): HostileDirective => ({ kind: "constrained", reason: `[COMBAT_CONSTRAINED] ${why}` });
  const defend = (): HostileDirective => {
    const target = contacts.find(
      (threat) =>
        !fightAnswered(threat.id) &&
        threat.relationship.defend &&
        (threat.inReach || (policy.shield && facts.shield && threat.ranged && threat.inContact)),
    );
    return target && !answered.has("fight") && (policy.melee || (policy.shield && facts.shield))
      ? { kind: "fight", targetId: target.id, threats }
      : blocked(
          `No permitted response can progress. Retreat ${policy.retreat ? "answered" : "prohibited"}; no authorized immediate defence.`,
        );
  };
  const evade = (reason: EvadeReason): HostileDirective =>
    policy.retreat && !answered.has("evade")
      ? { kind: "evade", threats, safeRange: policy.evade_safe_range, reason }
      : purpose.kind === "automatic"
        ? defend()
        : blocked("Withdrawal is prohibited or answered for this scope.");
  const hideAvailable = facts.hideAllowed && !answered.has("hide");

  if (facts.fireball && policy.melee && !answered.has("deflect"))
    return { kind: "deflect", targetId: facts.fireball.id, reason: "incoming_fireball", threats: [facts.fireball] };
  if (purpose.kind === "contact_defence" && fightAnswered(purpose.targetId)) return evade("unreachable");
  if (purpose.kind === "contact_defence")
    return policy.melee || policy.bow || (policy.shield && facts.shield)
      ? { kind: "fight", targetId: purpose.targetId, threats }
      : blocked("No permitted attack or shield capability remains for contact defence.");
  if (purpose.kind === "recovery") {
    if (answered.has("recovery")) return blocked("Protected recovery is exhausted under unchanged recovery premises.");
    if (policy.recover === "never" || !facts.recoveryAvailable)
      return blocked(
        "Recovery is prohibited or no carried food, sufficient hunger or regeneration effect can restore health.",
      );
    return hideAvailable ? { kind: "hide", threats, reason: "hurt" } : evade("withdraw");
  }
  if (purpose.kind === "handoff") {
    if (health < policy.engage_min_health && hideAvailable) return { kind: "hide", threats, reason: "hurt" };
    if (policy.retreat && !answered.has("evade")) return evade("withdraw");
    return hideAvailable
      ? { kind: "hide", threats, reason: "cornered" }
      : blocked("No permitted, unanswered handoff response remains.");
  }
  if (purpose.kind === "pursuit") {
    if (fightAnswered(purpose.targetId)) return evade("unreachable");
    if (needsCombatRecovery(health, purpose.minimumHealth))
      return decideCombatResponse(facts, { kind: "recovery", targetId: purpose.targetId });
    return policy.melee || policy.bow
      ? { kind: "fight", targetId: purpose.targetId, threats }
      : blocked("The requested target remains authorized, but both attack capabilities are prohibited.");
  }

  const hurtBadly = health < policy.critical_health;
  if (!(hurtBadly ? threats.length > 0 : contacts.some((threat) => threat.inContact))) return { kind: "none" };
  if (hurtBadly)
    return hideAvailable && !answered.has("recovery") ? { kind: "hide", threats, reason: "hurt" } : evade("hurt");
  if (!policy.melee && !policy.bow) return evade("withdraw");
  // A hunted species is the request's objective. Health rules above still
  // withdraw from it; nothing below does, because the hunt owns giving up on
  // a quarry it cannot fight, and it does so by its own stop counts.
  const quarry = new Set(purpose.kind === "automatic" ? (purpose.quarry ?? []) : []);
  const hunted = (threat: CombatContact) => quarry.has(threat.name);
  const candidates = contacts.filter(
    (threat) =>
      threat.inContact &&
      (health < policy.engage_min_health || !threat.defendsOnContact || threat.inReach || hunted(threat)),
  );
  const target = candidates
    .filter((contact) => !fightAnswered(contact.id))
    .sort(
      (a, b) =>
        Number(a.name === "creeper") - Number(b.name === "creeper") ||
        Number(hunted(b)) - Number(hunted(a)) ||
        compareTargets(a.utility, b.utility) ||
        a.id - b.id,
    )[0];
  if (!target) return candidates.some((threat) => !hunted(threat)) ? evade("unreachable") : { kind: "none" };
  if (answered.has("evade") && hideAvailable && !answered.has("recovery") && !hunted(target))
    return { kind: "hide", threats, reason: "cornered" };
  if (!target.relationship.defend && !hunted(target)) return evade("observed_aggression");
  const creepers = contacts.filter((threat) => threat.name === "creeper");
  if (
    creepers.some((threat) => threat.inContact) &&
    (!facts.weapon || (creepers.length > 1 && (!policy.bow || !facts.rangedWeapon)))
  )
    return evade("creeper");
  const needsRangedRecovery =
    (facts.burning || !policy.shield || !facts.shield) && contacts.every((threat) => threat.ranged && !threat.inReach);
  if (health < policy.engage_min_health && hideAvailable && !answered.has("recovery") && needsRangedRecovery)
    return { kind: "hide", threats, reason: "hurt" };
  if (facts.unreachable.has(target.id) && !(health >= policy.engage_min_health && target.inReach))
    return hunted(target) ? { kind: "none" } : evade("unreachable");
  if (health < policy.engage_min_health) {
    if (
      hideAvailable &&
      !answered.has("recovery") &&
      contacts.some((threat) => threat.name === "enderman" && threat.inContact)
    )
      return { kind: "hide", threats, reason: "hurt" };
    return evade("hurt");
  }
  if (answered.has("fight")) return hunted(target) ? { kind: "none" } : evade("unreachable");
  return policy.engagement === "defend_only" && !hunted(target)
    ? target.inReach
      ? defend()
      : evade("withdraw")
    : { kind: "fight", targetId: target.id, threats };
}
