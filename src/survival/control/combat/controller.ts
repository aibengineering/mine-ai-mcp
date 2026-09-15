import { isDeepStrictEqual } from "node:util";
import type { Bot } from "mineflayer";
import { ExecutionScope } from "../../../execution/execution-scope.js";
import { type NavigationRuntime } from "../../../navigation/index.js";
import { BodyAbort } from "../../../session/abort.js";
import { dragonDanger } from "../../../world/dragon-hazards.js";
import type { CrystalObservation } from "../../perception/combat/crystal.js";
import { CombatPerception } from "../../perception/combat/observations.js";
import type { PerchObservation } from "../../perception/combat/perch.js";
import { PerchPreparation } from "../../perception/combat/perch-preparation.js";
import { responsePolicyChanged } from "../../policy/combat/permissions.js";
import { CombatPosition } from "../../positioning/combat/position.js";
import { EndCombat, type EndCombatResult } from "../../responses/end/execute.js";
import { FootingRecovery } from "../../responses/footing.js";
import { SurvivalPolicyState } from "../../state/survival-policy.js";
import { type SurvivalResources } from "../../state/resources.js";
import type { CombatController, CombatDecision, CombatEngagement, CombatOutcome } from "./contract.js";
import { CombatExecution, type CombatExecutionSnapshot } from "./execution.js";
import { secureCombatHandoff, type CombatHandoff } from "./handoff.js";
import { emptyCombatEvidence, runMobEngagement } from "./mob.js";
import { combatResourceRefusal } from "./preparation.js";

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** One combat operation owns the body at a time; policy changes settle that operation before another begins. */

export function createCombatController(
  bot: Bot,
  navigation: NavigationRuntime,
  perception: CombatPerception,
  footingRecovery: FootingRecovery,
  survival: SurvivalResources,
): CombatController {
  const policy = new SurvivalPolicyState(bot);
  const perchPreparation = new PerchPreparation();
  let previousPolicy = policy.combat;
  let previousFood = policy.food;
  let policyUse: "fight" | "recovery" | "handoff" | "end" = "fight";
  policy.onChange(async () => {
    const changed =
      !isDeepStrictEqual(previousFood, policy.food) ||
      responsePolicyChanged(previousPolicy, policy.combat, "fight") ||
      (policyUse !== "fight" &&
        (responsePolicyChanged(previousPolicy, policy.combat, "hide") ||
          responsePolicyChanged(previousPolicy, policy.combat, "evade")));
    previousPolicy = policy.combat;
    previousFood = policy.food;
    if (changed)
      await stop(
        new BodyAbort(
          { kind: "policy_changed", revision: policy.snapshot().revision },
          "Combat policy changed; reconcile physical effects.",
        ),
      );
  });
  const decisionListeners = new Set<(event: CombatDecision) => void>();
  const reportDecision = (event: CombatDecision) => {
    for (const listener of decisionListeners) listener(event);
  };
  let fightingPosition: CombatPosition | null = null;
  let executionSnapshot: (() => CombatExecutionSnapshot) | null = null;
  let active:
    | (CombatEngagement & {
        readonly controller: AbortController;
        readonly outcome: Promise<unknown>;
      })
    | null = null;
  async function runEnd(
    request:
      | { kind: "crystal"; targetId: number; observation: CrystalObservation }
      | { kind: "dragon_bow"; targetId: number; observation: DragonShotObservation }
      | { kind: "perch" | "prepare_perch"; targetId: number; observation: PerchObservation }
      | { kind: "evade" },
    signal: AbortSignal,
  ): Promise<EndCombatResult> {
    if (active) throw new Error("Combat controller is already engaged");
    const targetId = request.kind === "evade" ? bot.entity.id : request.targetId;
    using scope = new ExecutionScope({ bot: bot.username, operation: "end_combat", targetId });
    const execution = new CombatExecution(scope, (phase, completedEffects) =>
      reportDecision({ kind: "phase", targetId, phase, completedEffects }),
    );
    const attacks = () => (request.kind === "evade" ? 0 : request.observation.attacks);
    executionSnapshot = () => execution.snapshot(attacks());
    const tick = () => {
      execution.tick();
      execution.progress.observe(bot.health);
    };
    bot.on("physicsTick", tick);
    const end = new EndCombat(bot, navigation, footingRecovery, () => policy.effective, survival, execution, {
      perception,
      resolvedIds: perception.resolvedIds,
      attackerIds: perception.attackerIds,
      unreachableIds: new Set<number>(),
      policy: policy.combat,
      food: policy.food,
      survival,
    }, (evidence) => reportDecision({ kind: "response", evidence }), perchPreparation);
    const controller = new AbortController();
    const joined = AbortSignal.any([signal, controller.signal]);
    policyUse = "end";
    const outcome =
      request.kind === "crystal"
        ? end.crystal(request.targetId, joined, request.observation)
        : request.kind === "dragon_bow"
          ? end.shootDragon(joined, request.observation)
          : request.kind === "perch"
            ? end.perch(request.targetId, joined, request.observation)
            : request.kind === "prepare_perch"
              ? end.preparePerch(request.targetId, joined, request.observation)
              : end.evade(joined);
    // Evasion protects the bot's body; it has no selected enemy to pursue.
    const engagement = {
      kind: "end" as const,
      targetId: request.kind === "evade" ? bot.entity.id : request.targetId,
      controller,
      outcome,
    };
    active = engagement;
    reportDecision({
      kind: "engagement",
      state: "started",
      targetId,
      targetDistance: null,
      execution: execution.snapshot(attacks()),
      outcome: null,
      observation: `End ${request.kind} request.`,
    });
    try {
      const result = await outcome;
      reportDecision({
        kind: "engagement",
        state: "ended",
        targetId,
        targetDistance: null,
        execution: execution.snapshot(attacks()),
        outcome: result.outcome,
        observation: result.reason,
      });
      return result;
    } catch (cause) {
      reportDecision({
        kind: "engagement",
        state: "ended",
        targetId,
        targetDistance: null,
        execution: execution.snapshot(attacks()),
        outcome: joined.aborted ? "cancelled" : "failed",
        observation: message(cause),
      });
      throw cause;
    } finally {
      bot.off("physicsTick", tick);
      policyUse = "fight";
      if (active === engagement) active = null;
    }
  }
  async function engage(targetId: number, signal: AbortSignal, movement: "pursue" | "hold"): Promise<CombatOutcome> {
    if (active)
      return { ...emptyCombatEvidence(targetId, "failed"), observation: "Combat controller is already engaged." };
    signal.throwIfAborted();
    if (policy.settling)
      return {
        ...emptyCombatEvidence(targetId, "capability_blocked"),
        reason: "policy",
        observation: "[COMBAT_CONSTRAINED] Combat policy is settling.",
      };
    const controller = new AbortController();
    const joined = AbortSignal.any([signal, controller.signal]);
    const outcome = runMobEngagement(
      {
        bot,
        navigation,
        policy,
        survival,
        reportDecision,
        perception: perception,
        footingRecovery: footingRecovery,
      },
      targetId,
      movement,
      joined,
      {
        position: (value) => {
          fightingPosition = value;
        },
        execution: (read) => {
          executionSnapshot = read;
        },
        policyUse: (value) => {
          policyUse = value;
        },
      },
    );
    const engagement = { kind: "mob" as const, targetId, controller, outcome };
    active = engagement;
    try {
      return await outcome;
    } finally {
      if (active === engagement) active = null;
    }
  }

  /** Abort the current engagement and wait for it to leave the bot neutral. */

  async function stop(reason: string | BodyAbort): Promise<void> {
    const engagement = active;
    if (!engagement) return;
    engagement.controller.abort(reason);
    try {
      await engagement.outcome;
    } catch (cause) {
      if (cause !== engagement.controller.signal.reason) throw cause;
    }
  }

  async function finish(signal: AbortSignal): Promise<CombatHandoff> {
    if (active) throw new Error("Cannot finish while another combat operation owns the body.");
    const controller = new AbortController();
    fightingPosition = null;
    using scope = new ExecutionScope({ bot: bot.username, operation: "combat_handoff", targetId: null });
    const execution = new CombatExecution(scope, (phase, completedEffects) =>
      reportDecision({ kind: "phase", targetId: bot.entity.id, phase, completedEffects }),
    );
    executionSnapshot = () => execution.snapshot(0);
    const tick = () => execution.tick();
    bot.on("physicsTick", tick);
    policyUse = "handoff";
    const outcome = execution.run("withdraw", () =>
      secureCombatHandoff(
        bot,
        navigation,
        {
          resolvedIds: perception.resolvedIds,
          attackerIds: perception.attackerIds,
          unreachableIds: new Set<number>(),
          perception,
          policy: policy.combat,
          food: policy.food,
          survival,
        },
        AbortSignal.any([signal, controller.signal]),
        (evidence) => reportDecision({ kind: "response", evidence }),
      ),
    );
    const engagement = { kind: "mob" as const, targetId: bot.entity.id, controller, outcome };
    active = engagement;
    try {
      return await outcome;
    } finally {
      bot.off("physicsTick", tick);
      policyUse = "fight";
      if (active === engagement) active = null;
    }
  }

  function canRecover(): boolean {
    if (
      policy.combat.recover === "never" ||
      active === null ||
      fightingPosition === null ||
      fightingPosition.plan === null
    )
      return false;
    return fightingPosition.canReturn();
  }

  return {
    policy,
    resourceRefusal: (target, admitted) =>
      combatResourceRefusal(bot, navigation, target, admitted, perception, survival.answered),
    runEnd,
    endDanger: () => dragonDanger(bot),
    onDecision: (listener) => {
      decisionListeners.add(listener);
      return () => {
        decisionListeners.delete(listener);
      };
    },
    engage,
    finish,
    stop,
    activeEngagement: () => (active === null ? null : { kind: active.kind, targetId: active.targetId }),
    execution: () => (active === null ? null : (executionSnapshot?.() ?? null)),
    activePosition: () => (active === null ? null : (fightingPosition?.plan ?? null)),
    canRecover,
  };
}
import type { DragonShotObservation } from "../../perception/combat/dragon-shot.js";
