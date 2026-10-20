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
  const policyRevision = controller.policy.snapshot().revision;
  const contact = (entity: (typeof bot.entities)[number] | undefined) =>
    entity !== undefined && entity.isValid && defendsOnContact(entity) && inDefensiveContact(bot, entity);
  const killedTargetIds: number[] = [];
  const totals = { attacks: 0, shieldRaisedSwings: 0, projectileGuards: 0, explosions: 0 };
  const styles = new Set<CombatOutcome["stylesUsed"][number]>();
  const weapons = new Set<string>();
  let targetId = request.targetId;
  let settled: FightResponseResult["result"];
  for (;;) {
    const contactEnded = new AbortController();
    const target = bot.entities[targetId];
    // Ending here lowers the shield, and a later fight raises it five ticks
    // before it blocks. With another attacker of this response still in
    // reach that gap is a hit; the controller defends it inside this engagement.
    const otherContactRemains = () =>
      request.threats.some(({ id }) => id !== targetId && contact(bot.entities[id]));
    const observeContact = () => {
      const { perception } = context;
      const creepers = perception.creeperClearance.observe(perception.tick, perception.resolvedIds);
      if (creeperEscape({ creepers, clearancePending: perception.creeperClearance.pending, stationaryCommitment: false })) return;
      if (target?.isValid && defendsOnContact(target) && !inDefensiveContact(bot, target) && !otherContactRemains())
        contactEnded.abort("Melee target left defensive reach.");
    };
    bot.on("physicsTick", observeContact);
    let result: CombatOutcome;
    try {
      const pending = controller.engage(
        targetId,
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
    totals.attacks += result.attacks;
    totals.shieldRaisedSwings += result.shieldRaisedSwings;
    totals.projectileGuards += result.projectileGuards;
    totals.explosions += result.explosions;
    for (const style of result.stylesUsed) styles.add(style);
    for (const weapon of result.weaponsUsed) weapons.add(weapon);
    if (result.kind === "died") killedTargetIds.push(result.targetId);
    settled =
      result.kind === "cancelled" && contactEnded.signal.aborted && !signal.aborted
        ? { kind: "contact_ended" }
        : result.kind === "cancelled" && !signal.aborted && controller.policy.snapshot().revision === policyRevision
          ? { ...result, kind: "failed", observation: "Combat was cancelled without an aborted session signal." }
          : result;
    // The next of this response's attackers is already in reach: fight it
    // within the same response. Handing the body back between them lowers
    // the guard for the resumed request, and the partner swings into that gap.
    const next = settled.kind === "died" && !signal.aborted
      ? request.threats.find(({ id }) => !killedTargetIds.includes(id) && contact(bot.entities[id]))
      : undefined;
    if (!next) break;
    targetId = next.id;
  }
  return {
    ...encounterBaseline(bot, request, healthBefore),
    attacks: totals.attacks,
    combatStyles: [...styles],
    weaponsUsed: [...weapons],
    shieldRaisedSwings: totals.shieldRaisedSwings,
    projectileGuards: totals.projectileGuards,
    explosions: totals.explosions,
    response: "fight",
    killedTargetIds,
    result: settled,
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
