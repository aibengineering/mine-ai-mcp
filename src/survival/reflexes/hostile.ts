import { isDeepStrictEqual } from "node:util";
import type { Bot, BotEvents } from "mineflayer";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ResponseContext } from "../control/combat/context.js";
import type { CombatController } from "../control/combat/contract.js";
import { answeredResponses, responseScope } from "../control/combat/scopes/response.js";
import { CombatPerception } from "../perception/combat/observations.js";
import { recoveryHealth } from "../policy/combat/health.js";
import { responsePolicyChanged } from "../policy/combat/permissions.js";
import { decideHostileReflex } from "../policy/combat/reflex-decision.js";

import type { NavigationRuntime } from "../../navigation/index.js";
import { BodyAbort } from "../../session/abort.js";
import { observeCombatDecision } from "../control/combat/observation.js";
import { recoveryScope } from "../control/combat/scopes/recovery.js";
import type { ReflexDriver } from "../control/driver.js";
import { incomingFireball } from "../perception/combat/fireball.js";
import { HOSTILE_OBSERVATION_RANGE, isHostile, observeHostileContact } from "../perception/combat/threats.js";
import { combatDecisionEvidence, decideCombatResponse } from "../policy/combat/decision.js";
import type { Facts } from "../state/answered.js";

import { executeHostileResponse } from "../control/combat/respond.js";
import {
  encounterBaseline,
  type EncounterEvidence,
  type HostileSettlement,
} from "../control/combat/response-result.js";
import {
  completeResponse,
  describeResponse,
  responseContinuation,
  responseFailure,
} from "../control/combat/settlement.js";
import type { HostileResponse } from "../policy/combat/response.js";

import type { ResponseDecision } from "../control/contract.js";

type ShieldPreparation = { readonly kind: "prepare_shield" };
type ShieldPrepared = { readonly kind: "shield_prepared"; readonly equipped: boolean; readonly error: string | null };

export const HOSTILE_REFLEX = "hostile_reflex" as const;

export interface HostileReflex extends AsyncDisposable {
  readonly threats: ResponseContext;
  activeResponse(): HostileResponse["kind"] | null;
}

/** Hostile observations and execution; admission, cancellation and failure retention belong to the driver. */
export function attachHostileReflex(
  bot: Bot,
  driver: ReflexDriver,
  navigation: NavigationRuntime,
  controller: CombatController,
  perception: CombatPerception,
): HostileReflex {
  const policy = controller.policy;
  const { resolvedIds, attackerIds } = perception;
  const encounterThreats = new Set<number>();
  let activeResponse: HostileResponse["kind"] | null = null;
  let responseRevision = policy.snapshot().revision;
  let previousPolicy = policy.combat;
  let previousFood = policy.food;
  let closing: Promise<void> | null = null;

  function answered(kind: HostileResponse["kind"], targetId?: number) {
    const scope = responseScope(bot, () => policy.effective, kind, targetId);
    return driver.answered.find(scope.capability, scope.scope);
  }

  const context: ResponseContext = {
    perception,
    resolvedIds,
    attackerIds,
    survival: driver,
    get policy() {
      return policy.combat;
    },
    get food() {
      return policy.food;
    },
    unreachableIds: new Set(),
    get blockedResponses() {
      return answeredResponses(bot, () => policy.effective, driver);
    },
  };

  const unsubscribePolicy = policy.onChange(async (snapshot) => {
    const changed = activeResponse && (
      responsePolicyChanged(previousPolicy, policy.combat, activeResponse) ||
      (activeResponse === "hide" && !isDeepStrictEqual(previousFood, policy.food))
    );
    previousPolicy = policy.combat;
    previousFood = policy.food;
    if (changed)
      await driver.cancel(
        HOSTILE_REFLEX,
        new BodyAbort({ kind: "policy_changed", revision: snapshot.revision }, "Combat policy changed."),
      );
  });
  const transition = (pending: Promise<void>) => {
    void pending.catch((cause) => policy.constrain(message(cause)));
  };
  const resetPolicy = () => {
    encounterThreats.clear();
    transition(policy.reset("Death or dimension change; defaults restored."));
  };
  bot.on("death", resetPolicy);
  let dimension = bot.game.dimension;
  const dimensionChanged = () => {
    if (dimension === bot.game.dimension) return;
    dimension = bot.game.dimension;
    resetPolicy();
  };
  bot.on("game", dimensionChanged);

  const registration = driver.register({
    name: HOSTILE_REFLEX,
    sense: () => {
      transition(policy.refresh());
      const contacts = observeHostileContact(bot, context);
      for (const contact of contacts) encounterThreats.add(contact.id);
      for (const id of encounterThreats) {
        const entity = bot.entities[id];
        if (
          !entity?.isValid ||
          resolvedIds.has(id) ||
          entity.position.distanceTo(bot.entity.position) >= policy.combat.evade_safe_range
        )
          encounterThreats.delete(id);
      }
      if (encounterThreats.size) policy.beginEncounter();
      else if (policy.snapshot().encounter) {
        policy.constrain(null);
        transition(policy.endEncounter());
      }
      // Aggression without attribution can require avoidance; it is not an attack authorization.
      const facts = observeCombatDecision(bot, context);
      const purpose = { kind: "automatic", quarry: policy.quarry } as const;
      const directive = decideCombatResponse(facts, purpose);
      const prepareShield = policy.combat.shield && bot.inventory.slots[45]?.name !== "shield" &&
        !bot.usingHeldItem && !bot.currentWindow && bot.inventory.items().some((item) => item.name === "shield") &&
        Object.values(bot.entities).some((entity) => isHostile(entity) &&
          entity.position.distanceTo(bot.entity.position) < HOSTILE_OBSERVATION_RANGE);
      if (!prepareShield && !facts.contacts.length && directive.kind === "none" && !incomingFireball(bot, 16)) return null;
      const entries = new Map<string, number>();
      for (const kind of ["hide", "evade"] as const) {
        const entry = answered(kind);
        if (entry) entries.set(kind, entry.id);
      }
      for (const contact of facts.contacts) {
        const entry = answered("fight", contact.id);
        if (entry) entries.set("fight", entry.id);
      }
      const recovery = recoveryScope(bot, () => policy.effective, recoveryHealth(policy.combat));
      const exhaustedRecovery = driver.answered.find(recovery.capability, recovery.scope);
      if (exhaustedRecovery) entries.set("recovery", exhaustedRecovery.id);
      if (facts.fireball) {
        const entry = answered("deflect", facts.fireball.id);
        if (entry) entries.set("deflect", entry.id);
      }

      const settling = policy.settling;
      const combatOwnsBody = controller.activeEngagement()?.kind === "mob";
      if (!settling && !combatOwnsBody) policy.constrain(directive.kind === "constrained" ? directive.reason : null);
      return {
        kind: "observed",
        danger: {
          directive,
          purpose,
          prepareShield,
          facts,
          settling,
          combatOwnsBody,
          entries: [...entries].map(([response, entry]) => ({ response, entry })),
        },
        evidence: {
          threats: facts.contacts.map((contact) => ({
            id: contact.id,
            name: contact.name,
            cell: bot.entities[contact.id]?.position.floored().toString() ?? null,
            relationship: { ...contact.relationship },
            confirmedAttacker: attackerIds.has(contact.id),
          })),
          fireball: facts.fireball ? { ...facts.fireball, position: { ...facts.fireball.position } } : null,
        },
      };
    },
    decisionFacts: ({ facts, directive, purpose, prepareShield, settling, combatOwnsBody, entries }): Facts => ({
      selection: combatDecisionEvidence(facts, purpose, directive),
      prepareShield,
      settling,
      combatOwnsBody,
      entries: entries.map((entry) => ({ ...entry })),
    }),
    decide: (observed): ResponseDecision<HostileResponse | ShieldPreparation> => {
      if (observed.prepareShield && observed.directive.kind === "none" && !observed.settling && !observed.combatOwnsBody)
        return { kind: "respond", response: { kind: "prepare_shield" }, name: "prepare_shield",
          reason: "Equip an available shield before nearby hostiles require a guard." };
      return decideHostileReflex(observed);
    },
    facts: (response) =>
      response.kind === "prepare_shield"
        ? { capability: "combat.prepare_shield", response: "prepare_shield", scope: "off-hand",
            facts: () => ({ offHand: bot.inventory.slots[45]?.name ?? null,
              shields: bot.inventory.items().filter((item) => item.name === "shield").map((item) => item.slot) }),
            permissions: () => ({ shield: policy.combat.shield }) }
        : responseScope(bot, () => policy.effective, response.kind, "targetId" in response ? response.targetId : undefined),
    act: async (directive, signal): Promise<HostileSettlement | ShieldPrepared> => {
      if (directive.kind === "prepare_shield") {
        let error: string | null = null;
        try {
          signal.throwIfAborted();
          if (policy.combat.shield && !bot.usingHeldItem && !bot.currentWindow && bot.inventory.slots[45]?.name !== "shield") {
            const shield = bot.inventory.items().find((item) => item.name === "shield");
            if (shield) {
              await bot.equip(shield, "off-hand");
              if (bot.inventory.slots[45]?.name !== "shield") error = "Shield equip did not settle in the off-hand.";
            }
          }
        } catch (cause) {
          error = message(cause);
        }
        return { kind: "shield_prepared", equipped: bot.inventory.slots[45]?.name === "shield", error };
      }
      activeResponse = directive.kind;
      responseRevision = policy.snapshot().revision;
      policy.observeResponse({
        kind: directive.kind,
        revision: responseRevision,
        reason: directive.kind === "fight" ? "Permitted response to hostile contact." : directive.reason,
      });
      const healthBefore = bot.health;
      const death: {
        value: {
          position: EncounterEvidence["finalPosition"];
          health: number;
          distances: Map<number, number>;
        } | null;
      } = { value: null };
      const captureDeath = () => {
        death.value ??= {
          position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
          health: bot.health,
          distances: new Map(
            Object.values(bot.entities).map((entity) => [entity.id, entity.position.distanceTo(bot.entity.position)]),
          ),
        };
      };
      const answeredAttackers = new Set(
        directive.threats.filter((threat) => attackerIds.has(threat.id)).map((threat) => threat.id),
      );
      const preserveNewAttack: BotEvents["entityHurt"] = (entity, source) => {
        if (entity.id === bot.entity.id && source) answeredAttackers.delete(source.id);
      };
      bot.on("death", captureDeath);
      if (directive.kind === "evade") bot.on("entityHurt", preserveNewAttack);
      try {
        let settlement: HostileSettlement;
        try {
          signal.throwIfAborted();
          await prepareBotForMovement(bot, navigation);
          signal.throwIfAborted();
          const physical = await executeHostileResponse(
            bot,
            navigation,
            controller,
            directive,
            context,
            healthBefore,
            signal,
          );
          settlement = completeResponse(physical, signal);
        } catch (cause) {
          settlement = abandonedEvidence(bot, directive, healthBefore, cause, signal);
        }
        const evidence = settlement.evidence;
        const atDeath = death.value;
        if (atDeath)
          return {
            ...settlement,
            kind: "bot_died",
            reason: "The bot died during this response.",
            evidence: {
              ...evidence,
              healthAfter: atDeath.health,
              finalPosition: atDeath.position,
              finalDistances: evidence.threats.map((threat) => ({
                id: threat.id,
                distance:
                  atDeath.distances.get(threat.id) ??
                  Math.hypot(
                    threat.position.x - atDeath.position.x,
                    threat.position.y - atDeath.position.y,
                    threat.position.z - atDeath.position.z,
                  ),
              })),
            },
          };
        if (signal.aborted && settlement.kind !== "failed")
          return { ...settlement, kind: "cancelled", reason: message(signal.reason) };
        for (const id of evidence.killedTargetIds) {
          resolvedIds.add(id);
          attackerIds.delete(id);
        }
        if (settlement.physical?.response === "evade" && settlement.physical.result.kind === "separated")
          for (const id of answeredAttackers) attackerIds.delete(id);
        return settlement;
      } finally {
        bot.off("death", captureDeath);
        bot.off("entityHurt", preserveNewAttack);
        activeResponse = null;
        policy.observeResponse(null);
      }
    },
    continuation: (outcome) => outcome.kind === "shield_prepared" ? { kind: "resume" } : responseContinuation(outcome),
    failure: (outcome) => outcome.kind === "shield_prepared" ? (outcome.error ? { kind: "equip_failed", why: outcome.error } : null) : responseFailure(outcome),
    describe: (outcome) => outcome.kind === "shield_prepared" ? { kind: outcome.kind, equipped: outcome.equipped, error: outcome.error } : describeResponse(outcome),
  });

  return {
    threats: context,
    activeResponse: () => activeResponse,
    [Symbol.asyncDispose]: () =>
      (closing ??= (async () => {
        unsubscribePolicy();
        bot.off("death", resetPolicy);
        bot.off("game", dimensionChanged);
        await registration[Symbol.asyncDispose]();
        await controller.stop("hostile contact observer closed");
      })()),
  };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function abandonedEvidence(
  bot: Bot,
  directive: HostileResponse,
  healthBefore: number,
  cause: unknown,
  signal: AbortSignal,
): HostileSettlement {
  return {
    response: directive.kind,
    kind: signal.aborted && cause === signal.reason ? "cancelled" : "failed",
    reason: message(cause),
    physical: null,
    evidence: {
      ...encounterBaseline(bot, directive, healthBefore),
      killedTargetIds: [],
      attacks: 0,
      combatStyles: [],
      weaponsUsed: [],
      shieldRaisedSwings: 0,
      projectileGuards: 0,
      explosions: 0,
    },
  };
}
