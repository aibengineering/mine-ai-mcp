import type { Bot } from "mineflayer";
import { type NavigationRuntime } from "../../../navigation/index.js";
import type { CombatExecution } from "../execution.js";
import type { ResponseContext } from "../../perception/combat/context.js";
import type { DragonShotObservation } from "../../perception/combat/dragon-shot.js";
import type { PerchObservation } from "../../perception/combat/perch.js";
import { PerchPreparation } from "../../perception/combat/perch-preparation.js";
import type { SurvivalPolicy } from "../../policy/contract.js";
import { type SurvivalResources } from "../../state/resources.js";
import { FootingRecovery } from "../../responses/footing.js";
import type { Facts } from "../../../utils/facts.js";
import type { CrystalObservation } from "../../perception/combat/crystal.js";
import { EndCore, type EndCombatResult } from "./core.js";
import { CrystalAttack } from "./crystal.js";
import { DragonShot } from "./dragon-shot.js";
import { PerchAttack } from "./perch.js";


/** The combat controller delegates End mechanics here while retaining body ownership. */
export class EndCombat {
  readonly #end: EndCore;
  readonly #shot: DragonShot;
  readonly #crystal: CrystalAttack;
  readonly #perch: PerchAttack;

  constructor(
    bot: Bot,
    navigation: NavigationRuntime,
    footing: FootingRecovery,
    policy: () => Readonly<SurvivalPolicy>,
    survival: SurvivalResources,
    execution: CombatExecution,
    threatContext: ResponseContext,
    recordDecision: (evidence: Facts) => void,
    perchPreparation = new PerchPreparation(),
  ) {
    this.#end = new EndCore(bot, navigation, footing, policy, survival, execution, threatContext, recordDecision, perchPreparation);
    this.#shot = new DragonShot(this.#end);
    this.#crystal = new CrystalAttack(this.#end);
    this.#perch = new PerchAttack(this.#end);
  }

  get danger(): boolean {
    return this.#end.danger;
  }

  evade(signal: AbortSignal): Promise<EndCombatResult> {
    return this.#end.evade(signal);
  }

  shootDragon(signal: AbortSignal, observation: DragonShotObservation): Promise<EndCombatResult> {
    return this.#shot.shootDragon(signal, observation);
  }

  crystal(targetId: number, signal: AbortSignal, observation: CrystalObservation): Promise<EndCombatResult> {
    return this.#crystal.crystal(targetId, signal, observation);
  }

  perch(targetId: number, signal: AbortSignal, observation: PerchObservation): Promise<EndCombatResult> {
    return this.#perch.perch(targetId, signal, observation);
  }

  preparePerch(targetId: number, signal: AbortSignal, observation: PerchObservation): Promise<EndCombatResult> {
    return this.#perch.preparePerch(targetId, signal, observation);
  }
}
