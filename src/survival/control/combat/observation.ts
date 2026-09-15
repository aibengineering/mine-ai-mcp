import type { Bot } from "mineflayer";
import { isBurning } from "../../perception/body.js";
import { bowDrawAimedAtBot } from "../../perception/combat/attention.js";
import { defendsOnContact, inDefensiveContact } from "../../perception/combat/contact.js";
import { incomingFireball } from "../../perception/combat/fireball.js";
import { isRangedAttacker } from "../../perception/combat/observations.js";
import { recoveryAvailable } from "../../perception/combat/recovery.js";
import { targetFacts } from "../../perception/combat/target.js";
import {
  HOSTILE_CONTACT_RANGE,
  HOSTILE_OBSERVATION_RANGE,
  hostileRelationship,
  observeExposedAvoidanceContact,
} from "../../perception/combat/threats.js";
import { DEFAULT_COMBAT_POLICY, type CombatPolicy } from "../../policy/combat/contract.js";
import { DEFAULT_FOOD_POLICY } from "../../policy/contract.js";
import { decideCombatResponse, type CombatDecisionFacts } from "../../policy/combat/decision.js";
import { permitsHide } from "../../policy/combat/permissions.js";
import type { HostileDirective, HostileThreat } from "../../policy/combat/response.js";
import { carriesCombatWeapon, carriesRangedWeapon, readCombatItems } from "../../weapons/equipment.js";
import { contextPolicy, type HostileContext } from "./context.js";
import { responseScope } from "./scopes/response.js";
const NO_CONTEXT: HostileContext = { resolvedIds: new Set(), attackerIds: new Set(), unreachableIds: new Set() };
function inContact(threat: HostileThreat, context: HostileContext): boolean {
  return threat.distance <= HOSTILE_CONTACT_RANGE || context.attackerIds.has(threat.id);
}

/** Read shared relationship, exposure and equipment once before deciding. */
export function observeCombatDecision(bot: Bot, context: HostileContext = NO_CONTEXT): CombatDecisionFacts {
  const policy = context.policy ?? DEFAULT_COMBAT_POLICY;
  const canRecover = recoveryAvailable(bot, context.food ?? DEFAULT_FOOD_POLICY);
  const fireball = incomingFireball(bot, HOSTILE_OBSERVATION_RANGE);
  const answered = new Set(context.blockedResponses);
  const answeredFights = new Map<number, number>();
  if (context.survival) {
    for (const entity of Object.values(bot.entities)) {
      const scope = responseScope(bot, contextPolicy(context), "fight", entity.id);
      const entry = context.survival.answered.find(scope.capability, scope.scope);
      if (entry) answeredFights.set(entity.id, entry.id);
    }
  }
  if (fireball && context.survival) {
    const scope = responseScope(bot, contextPolicy(context), "deflect", fireball.id);
    if (context.survival.answered.find(scope.capability, scope.scope)) answered.add("deflect");
  }
  return {
    policy,
    health: bot.health,
    burning: isBurning(bot),
    hideAllowed: permitsHide(policy, canRecover),
    recoveryAvailable: canRecover,
    weapon: carriesCombatWeapon(bot),
    rangedWeapon: carriesRangedWeapon(bot),
    shield: readCombatItems(bot).some((item) => item.name === "shield"),
    fireball: fireball
      ? {
          id: fireball.id,
          name: "fireball",
          position: { x: fireball.position.x, y: fireball.position.y, z: fireball.position.z },
          distance: fireball.position.distanceTo(bot.entity.position),
        }
      : null,
    contacts: observeExposedAvoidanceContact(bot, context)
      .filter((threat) => threat.name !== "ender_dragon")
      .map((threat) => {
        const entity = bot.entities[threat.id]!;
        return {
          ...threat,
          relationship: hostileRelationship(bot, entity, context),
          // Exposed bow draws aimed at us are contact before their first projectile hits.
          inContact: inContact(threat, context) || bowDrawAimedAtBot(bot, entity),
          inReach: inDefensiveContact(bot, entity),
          defendsOnContact: defendsOnContact(entity),
          ranged: isRangedAttacker(entity),
          utility: targetFacts(bot, entity, context.attackerIds.has(entity.id)),
        };
      }),
    unreachable: context.unreachableIds,
    answeredFights,
    answered,
  };
}

export function observeHostileResponse(
  bot: Bot,
  context: HostileContext = NO_CONTEXT,
  policy: Readonly<CombatPolicy> = context.policy ?? DEFAULT_COMBAT_POLICY,
): HostileDirective {
  return decideCombatResponse(observeCombatDecision(bot, { ...context, policy }), { kind: "automatic" });
}
