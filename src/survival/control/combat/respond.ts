import type { Bot } from "mineflayer";
import { type NavigationRuntime } from "../../../navigation/index.js";
import { defendsOnContact, inDefensiveContact } from "../../perception/combat/contact.js";
import { decideFightMovement } from "../../policy/combat/decision.js";
import { recoveryHealth } from "../../policy/combat/health.js";
import type { HostileDirective, HostileResponse } from "../../policy/combat/response.js";
import { deflectFireball } from "../../responses/deflect.js";
import { evade } from "../../responses/evade.js";
import { hideInPlace } from "../../responses/hide.js";
import { contextPolicy, type ResponseContext } from "./context.js";
import type { CombatController, CombatOutcome } from "./contract.js";
import {
  encounterBaseline,
  type DeflectResponseResult,
  type FightResponseResult,
  type HideResponseResult,
  type HostileResponseResult,
} from "./response-result.js";
import { responseScope } from "./scopes/response.js";
import { creeperEscape } from "../../policy/combat/tactics.js";
async function fight(
  bot: Bot,
  controller: CombatController,
  request: Extract<HostileDirective, { kind: "fight" }>,
  context: ResponseContext,
  healthBefore: number,
  signal: AbortSignal,
): Promise<FightResponseResult> {
  const contactEnded = new AbortController();
  const policyRevision = controller.policy.snapshot().revision;
  const target = bot.entities[request.targetId];
  const observeContact = () => {
    const { perception } = context;
    const creepers = perception.creeperClearance.observe(perception.tick, perception.resolvedIds);
    if (creeperEscape({ creepers, clearancePending: perception.creeperClearance.pending, stationaryCommitment: false })) return;
    if (target?.isValid && defendsOnContact(target) && !inDefensiveContact(bot, target))
      contactEnded.abort("Melee target left defensive reach.");
  };
  bot.on("physicsTick", observeContact);
  let result: CombatOutcome;
  try {
    const pending = controller.engage(
      request.targetId,
      AbortSignal.any([signal, contactEnded.signal]),
      decideFightMovement({
        policy: controller.policy.combat,
        health: bot.health,
        target: target ? { name: target.name ?? "unknown", defendsOnContact: defendsOnContact(target) } : null,
      }),
    );
    observeContact();
    result = await pending;
  } finally {
    bot.off("physicsTick", observeContact);
  }
  // A settled controller still owns useful statistics after cancellation.
  // The claim owner classifies cancellation/death without discarding them.
  const common = {
    ...encounterBaseline(bot, request, healthBefore),
    attacks: result.attacks,
    combatStyles: result.stylesUsed,
    weaponsUsed: result.weaponsUsed,
    shieldRaisedSwings: result.shieldRaisedSwings,
    projectileGuards: result.projectileGuards,
    explosions: result.explosions,
  };
  return {
    ...common,
    response: "fight",
    killedTargetIds: result.kind === "died" ? [result.targetId] : [],
    result:
      result.kind === "cancelled" && contactEnded.signal.aborted && !signal.aborted
        ? { kind: "contact_ended" }
        : result.kind === "cancelled" && !signal.aborted && controller.policy.snapshot().revision === policyRevision
          ? { ...result, kind: "failed", observation: "Combat was cancelled without an aborted session signal." }
          : result,
  };
}

async function hide(
  bot: Bot,
  request: Extract<HostileDirective, { kind: "hide" }>,
  context: ResponseContext,
  healthBefore: number,
  signal: AbortSignal,
): Promise<HideResponseResult> {
  const result = await hideInPlace(bot, {
    signal,
    threatContext: context,
    recoverTo: recoveryHealth(context.policy),
    maximumMs: context.policy.recovery_timeout_ms,
  });
  return {
    ...encounterBaseline(bot, request, healthBefore),
    response: "hide",
    result,
    attacks: 0,
    combatStyles: [],
    weaponsUsed: [],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
    killedTargetIds: [],
  };
}

async function deflect(
  bot: Bot,
  request: Extract<HostileResponse, { kind: "deflect" }>,
  healthBefore: number,
  signal: AbortSignal,
): Promise<DeflectResponseResult> {
  let explosions = 0;
  const onExplosion = () => {
    explosions += 1;
  };
  bot._client.on("explosion", onExplosion);
  try {
    const result = await deflectFireball(bot, request.targetId, signal);
    return {
      ...encounterBaseline(bot, request, healthBefore),
      response: "deflect",
      result,
      attacks: result.attacks,
      killedTargetIds: [],
      combatStyles: result.attacks > 0 ? ["melee"] : [],
      weaponsUsed: result.attacks > 0 ? [bot.heldItem?.name ?? "hand"] : [],
      shieldRaisedSwings: 0,
      projectileGuards: 0,
      explosions,
    };
  } finally {
    bot._client.off("explosion", onExplosion);
  }
}

/** Execute one selected response. The claim owner classifies interruption after effects settle. */
export async function executeHostileResponse(
  bot: Bot,
  navigation: NavigationRuntime,
  controller: CombatController,
  request: HostileResponse,
  context: ResponseContext,
  healthBefore: number,
  signal: AbortSignal,
): Promise<HostileResponseResult> {
  signal.throwIfAborted();
  switch (request.kind) {
    case "deflect":
      return deflect(bot, request, healthBefore, signal);
    case "fight":
      return fight(bot, controller, request, context, healthBefore, signal);
    case "hide":
      return hide(bot, request, context, healthBefore, signal);
    case "evade":
      return evade(bot, navigation, request, context, healthBefore, signal);
  }
}

/** A combat request keeps ownership and retains an unobserved deflection before reconsidering. */
export async function deflectWithinCombat(bot: Bot, targetId: number, context: ResponseContext, signal: AbortSignal) {
  const scope = responseScope(bot, contextPolicy(context), "deflect", targetId);
  const result = await deflectFireball(bot, targetId, signal);
  signal.throwIfAborted();
  if (result.kind === "unobserved")
    context.survival.answered.remember(scope, { kind: "deflection_unobserved", why: result.observation });
  return result;
}
