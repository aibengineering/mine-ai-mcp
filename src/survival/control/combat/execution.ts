import { z } from "zod";
import type { ExecutionScope } from "../../../execution/execution-scope.js";
import { CombatProgress, combatProgressSchema } from "./progress.js";

/** Physical effects keep their lifetime across ticks; this names their current owner. */
export const combatPhaseSchema = z.enum([
  "decide",
  "approach",
  "guard",
  "shoot",
  "swing",
  "defend",
  "return",
  "hold",
  "lure",
  "recover",
  "withdraw",
  "recover_footing",
  "establish",
  "release",
  "wait_perch",
  "observe_shot",
]);
export type CombatPhase = z.output<typeof combatPhaseSchema>;

export const combatExecutionSnapshotSchema = z.object({
  phase: combatPhaseSchema,
  phaseTicks: z.number(),
  attacks: z.number(),
  expected: z.string(),
  completedEffects: z.number(),
  phaseHistory: z.partialRecord(combatPhaseSchema, z.number()),
  progress: combatProgressSchema,
});
export type CombatExecutionSnapshot = z.output<typeof combatExecutionSnapshotSchema>;

/** Every state names the observation it is trying to obtain. Returning from an
 * effect, refreshing a shield, and changing state do not establish that observation. */
export const COMBAT_PHASE_CONTRACTS: Record<CombatPhase, string> = {
  decide: "A changed scene permits the next combat effect.",
  approach: "An observed route step reaches new ground or a usable attack position.",
  guard: "The incoming volley finishes; requested-target damage advances the fight.",
  shoot: "The arrow is released; server-confirmed target damage advances the fight.",
  swing: "The swing is sent; server-confirmed target damage advances the fight.",
  defend: "The incidental attacker takes confirmed damage or contact ends.",
  return: "The bot reaches observed protection.",
  hold: "The target enters a usable attack position or the threat ends.",
  lure: "Native target hostility is observed before defensive construction begins.",
  recover: "Observed health recovers while protection remains usable.",
  withdraw: "The bot reaches observed protection or separation before handing back the request.",
  recover_footing: "The body reaches a supported landing.",
  establish: "Observed blocks provide usable protection.",
  release: "Owned item use, navigation and movement controls finish releasing.",
  wait_perch: "This requested dragon perch begins, ends, or the dragon's death is observed.",
  observe_shot: "Server death or explosion evidence settles the already released shot.",
};

/** A phase names the controller's current work. Repeated hold ticks remain one
 * phase; nested effects temporarily own it and then return to their caller. */
export class CombatExecution {
  readonly progress = new CombatProgress();
  constructor(
    private readonly trace: ExecutionScope,
    private readonly changed: (phase: CombatPhase, completedEffects: number) => void = () => {},
  ) {}
  #phase: CombatPhase = "decide";
  #ticks = 0;
  #entered = 0;
  #completed = 0;
  #depth = 0;
  readonly #phaseHistory: Partial<Record<CombatPhase, number>> = {};

  tick(): void {
    this.#ticks++;
    this.#phaseHistory[this.#phase] = (this.#phaseHistory[this.#phase] ?? 0) + 1;
  }

  snapshot(attacks: number): CombatExecutionSnapshot {
    return {
      phase: this.#phase,
      phaseTicks: this.#ticks - this.#entered,
      attacks,
      expected: COMBAT_PHASE_CONTRACTS[this.#phase],
      completedEffects: this.#completed,
      phaseHistory: { ...this.#phaseHistory },
      progress: this.progress.snapshot(),
    };
  }

  async run<T>(phase: CombatPhase, effect: () => Promise<T>): Promise<T> {
    const previous = this.#phase;
    const entered = this.#entered;
    const nested = this.#depth++ > 0;
    this.#phase = phase;
    if (previous !== phase) this.#entered = this.#ticks;
    if (previous !== phase) this.changed(phase, this.#completed);
    try {
      const result = await this.trace.run(phase, effect);
      this.#completed++;
      return result;
    } finally {
      this.#depth--;
      if (nested) {
        this.#phase = previous;
        this.#entered = entered;
        if (previous !== phase) this.changed(previous, this.#completed);
      }
    }
  }
}
