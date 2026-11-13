export const HOLD_GROUND_AGAINST = new Set(["phantom", "vex"]);
import type { Bot } from "mineflayer";
import { ExecutionScope } from "../../../execution/execution-scope.js";
import { type NavigationRuntime } from "../../../navigation/index.js";
import { entityMetadata } from "../../../world/end-fight.js";
import { selectPolicyFood } from "../../perception/food.js";
import { ProtectedAttackProgress } from "../attack-progress.js";
import type { CombatDecision, CombatOutcome, CombatResult } from "../contract.js";
import type { FightOutcome } from "../engagement.js";
import { CombatExecution } from "../execution.js";
import { CombatTactics } from "./tactics.js";
import { observeCombatDecision } from "../observation.js";
import type { CombatProgressChange } from "../progress.js";
import { answeredResponses } from "../../responses/scopes/response.js";
import { isThreat } from "../../perception/combat/threats.js";
import { combatDecisionEvidence, decideCombatResponse } from "../../policy/combat/decision.js";
import { decideFightBoundary, type FightBoundaryDecision } from "../../policy/combat/fight-boundary.js";
import { CombatPosition } from "../../positioning/combat/position.js";
import { SurvivalPolicyState } from "../../state/survival-policy.js";
import { type SurvivalResources } from "../../state/resources.js";
import type { Position3 } from "../../../utils/index.js";
import { FootingRecovery } from "../../responses/footing.js";
import { creeperEscape, creeperEscapeAdmits } from "../../policy/combat/tactics.js";
import { CombatPerception } from "../../perception/combat/observations.js";
import type { CombatStyle } from "../../weapons/equipment.js";

export interface FightEnvironment {
  readonly bot: Bot;
  readonly navigation: NavigationRuntime;
  readonly policy: SurvivalPolicyState;
  readonly perception: CombatPerception;
  readonly footingRecovery: FootingRecovery;
  readonly survival: SurvivalResources;
  readonly reportDecision: (event: CombatDecision) => void;
}
export interface FightRequest {
  readonly target: Parameters<Bot["attack"]>[0];
  readonly movement: "pursue" | "hold";
  readonly signal: AbortSignal;
  readonly ownerSignal: AbortSignal;
  readonly minimumHealth: number;
  /** Where a pursuing request began; see EngageOptions. */
  readonly ground?: Position3;
}
/** The observed scene and evidence of one physical fight, shared by its tactics. */
export class FightScene implements Disposable {
  readonly dragonDefense = new AbortController();
  readonly responseRequired = new AbortController();
  recoveryTarget: number | null = null;
  boundaryDecision: FightBoundaryDecision = { kind: "fight" };
  private boundaryKey: string | null = null;
  readonly dead = new Set<number>();
  readonly stylesUsed = new Set<CombatStyle>();
  readonly weaponsUsed = new Set<string>();
  readonly tactics: CombatTactics;
  get signal(): AbortSignal { return this.tactics.signal; }
  readonly position: CombatPosition;
  readonly responsiveness: ExecutionScope;
  readonly execution: CombatExecution;
  readonly defendingAtStart: boolean;
  #target: Parameters<Bot["attack"]>[0];
  get target() { return this.#target; }
  get holdsGround(): boolean { return HOLD_GROUND_AGAINST.has(this.target.name ?? ""); }
  get heightLimitedTarget(): boolean { return this.target.name === "enderman"; }
  observed: "died" | "target_lost" | "bot_died" | null = null;
  attacks = 0;
  shieldRaisedSwings = 0;
  projectileGuards = 0;
  explosions = 0;
  elapsedTicks = 0;
  /** When a hovering flier was first seen above sword reach in this fight. */
  hoverWaitStartedAt: number | null = null;
  /** Hold and guard ticks since the last evidence that the fight can happen: an
   * attack position, an attack, a confirmed hit, or damage taken. */
  holdTicks = 0;
  #holdAttacks = 0;
  #holdHealth: number | null = null;
  constructor(
    readonly environment: FightEnvironment,
    readonly request: FightRequest,
    readonly protectedProgress: ProtectedAttackProgress,
  ) {
    this.#target = request.target;
    this.tactics = new CombatTactics(AbortSignal.any([request.signal, this.dragonDefense.signal, this.responseRequired.signal]));
    this.responsiveness = new ExecutionScope({ bot: this.bot.username, operation: "combat", targetId: this.targetId });
    this.execution = new CombatExecution(this.responsiveness, (phase, completedEffects) =>
      this.reportDecision({ kind: "phase", targetId: this.targetId, phase, completedEffects }),
    );
    this.position = new CombatPosition(
      this.bot,
      this.navigation,
      this.target,
      this.dead,
      this.perception,
      () => this.policy.combat,
      this.survival.answered,
    );
    this.defendingAtStart = isThreat(this.bot, this.requestedTarget, this.perception);
  }
  get bot() {
    return this.environment.bot;
  }
  get navigation() {
    return this.environment.navigation;
  }
  get policy() {
    return this.environment.policy;
  }
  get perception() {
    return this.environment.perception;
  }
  get footingRecovery() {
    return this.environment.footingRecovery;
  }
  get survival() {
    return this.environment.survival;
  }
  get reportDecision() {
    return this.environment.reportDecision;
  }
  get requestedTarget() {
    return this.request.target;
  }
  /** A defensive focus changes physical mechanics, never the requested quarry. */
  focus(target: Parameters<Bot["attack"]>[0]): void {
    if (this.target === target) return;
    this.reportDecision({ kind: "retarget", from: this.target.id, to: target.id });
    this.#target = target;
    this.position.target = target;
  }
  get targetId() {
    return this.request.target.id;
  }
  get movement() {
    return this.request.movement;
  }
  get parentSignal() {
    return this.request.signal;
  }
  get ownerSignal() {
    return this.request.ownerSignal;
  }
  readonly result = <Kind extends FightOutcome["kind"]>(kind: Kind): CombatResult<Kind> => ({
    kind,
    targetId: this.targetId,
    attacks: this.attacks,
    stylesUsed: [...this.stylesUsed],
    weaponsUsed: [...this.weaponsUsed],
    shieldRaisedSwings: this.shieldRaisedSwings,
    projectileGuards: this.projectileGuards,
    explosions: this.explosions,
  });
  readonly failure = (observation: string): CombatOutcome => ({ ...this.result("failed"), observation });
  /** Reconsider only at observed boundaries; a selected recovery keeps this refuge alive. */
  readonly observeBoundary = (): void => {
    if (this.settled() || this.tactics.lifetime.aborted) return;
    // A health boundary cannot replace unresolved blast defence with an
    // ordinary hunt/recovery decision. Reconsider that response after clearance.
    const creepers = this.perception.creeperClearance.observe(this.perception.tick, this.perception.resolvedIds);
    const blast = creeperEscape({ creepers, clearancePending: this.perception.creeperClearance.pending, stationaryCommitment: false });
    if (blast) {
      this.perception.creeperClearance.require(creepers.filter(threat => creeperEscapeAdmits(blast).includes(threat.id)));
      return;
    }
    const facts = observeCombatDecision(this.bot, {
      resolvedIds: this.perception.resolvedIds,
      attackerIds: this.perception.attackerIds,
      unreachableIds: new Set(),
      perception: this.perception,
      policy: this.policy.combat,
      food: this.policy.food,
      survival: this.survival,
      blockedResponses: answeredResponses(this.bot, () => this.policy.effective, this.survival),
    });
    const purpose =
      this.movement === "hold"
        ? ({ kind: "contact_defence", targetId: this.targetId } as const)
        : ({
            kind: "pursuit",
            targetId: this.targetId,
            minimumHealth: this.recoveryTarget ?? this.request.minimumHealth,
          } as const);
    const protection = {
      returnable: this.position.canReturn(),
      atProtection: this.position.plan !== null && this.position.at(this.position.plan.protected),
      foodLow: this.bot.food < 18,
      foodAvailable: selectPolicyFood(this.bot, this.policy.food).food !== null,
    };
    const decision = decideFightBoundary(facts, purpose, protection);
    this.boundaryDecision = decision;
    const key = JSON.stringify(decision);
    if (key !== this.boundaryKey) {
      this.boundaryKey = key;
      this.reportDecision({
        kind: "response",
        evidence: {
          boundary: "fight",
          protection: { ...protection },
          selection: combatDecisionEvidence(facts, purpose, decideCombatResponse(facts, purpose)),
          decision: decision.kind === "respond" ? { kind: decision.kind } : { ...decision },
        },
      });
    }
    if (decision.kind === "recover") this.recoveryTarget = decision.health;
    if (decision.kind === "respond") this.responseRequired.abort("The shared decision selected a different response.");
  };
  readonly settled = (): boolean => this.observed !== null || !this.requestedTarget.isValid;
  readonly reportProgress = (
    state: "started" | "ended" | CombatProgressChange,
    outcome: string | null = null,
    observation: string | null = null,
  ) => {
    const entity = this.bot.entities[this.targetId];
    this.reportDecision({
      kind: "engagement",
      state,
      targetId: this.targetId,
      targetDistance: entity?.isValid ? entity.position.distanceTo(this.bot.entity.position) : null,
      execution: this.execution.snapshot(this.attacks),
      outcome,
      observation,
    });
  };
  /** Count one physics tick of holding. Nothing else ends a hold whose target
   * never reaches a usable attack position: a zombie behind a block held the
   * body for hours on 23 October 2026 while the foreground request waited. */
  readonly observeHold = (attackPosition: boolean): void => {
    const health = this.bot.health;
    const hurt = this.#holdHealth !== null && health < this.#holdHealth;
    this.#holdHealth = health;
    if (attackPosition || hurt || this.attacks !== this.#holdAttacks) {
      this.#holdAttacks = this.attacks;
      this.holdTicks = 0;
      return;
    }
    const phase = this.execution.phase;
    if (phase === "hold" || phase === "guard") this.holdTicks++;
  };
  readonly holdProgress = (): void => {
    this.holdTicks = 0;
  };
  /** The released body returns to its caller; the answered fight keeps this target from taking it again. */
  readonly holdLimit = (): CombatOutcome | null => {
    const limit = this.policy.combat.hold_wait_ticks;
    if (this.settled() || this.holdTicks < limit) return null;
    const distance = this.target.position.distanceTo(this.bot.entity.position);
    this.reportDecision({
      kind: "response",
      evidence: {
        boundary: "hold_limit",
        targetId: this.target.id,
        targetName: this.target.name ?? null,
        targetDistance: distance,
        holdTicks: this.holdTicks,
        limit,
        attacks: this.attacks,
        health: this.bot.health,
      },
    });
    return {
      ...this.result("unreachable"),
      observation:
        `[COMBAT_HOLD_LIMIT] Held ${this.holdTicks} ticks against ${this.target.name ?? "target"} ${this.target.id} ` +
        `${distance.toFixed(1)} blocks away with no attack position, attack, confirmed hit or damage taken.`,
    };
  };
  readonly guardLimit = (): CombatOutcome => ({
    ...this.result("unreachable"),
    observation: `Ranged guard did not observe a finished volley within ${this.policy.combat.volley_wait_ticks} ticks.`,
  });
  readonly roofTargetHostile = () =>
    isThreat(this.bot, this.requestedTarget, this.perception) ||
    (this.movement === "pursue" &&
      this.heightLimitedTarget &&
      entityMetadata(this.bot, this.requestedTarget, "creepy") === true);
  [Symbol.dispose]() {
    this.protectedProgress.leave();
    this.responsiveness[Symbol.dispose]();
  }
}
