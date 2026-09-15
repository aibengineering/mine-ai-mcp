import type { Budgets, ProgressBudget } from "../../state/budgets.js";

/** One engagement remembers time spent at each refuge across temporary loss of
 * cover, retargeting and recovery. Recreating a plan cannot buy another wait. */
export class ProtectedAttackProgress implements Disposable {
  readonly #spent = new Map<string, { ticks: number }>();
  #current: { cell: string; clock: { ticks: number }; budget: ProgressBudget } | null = null;

  constructor(
    readonly budgets: Budgets,
    readonly targetId: number,
    readonly limit: number,
  ) {}

  enter(cell: string): ProgressBudget {
    if (this.#current?.cell === cell) return this.#current.budget;
    this.leave();
    const clock = this.#spent.get(cell) ?? { ticks: 0 };
    this.#spent.set(cell, clock);
    const budget = this.budgets.progress({
      name: "protected_attack",
      scope: `target:${this.targetId}:cell:${cell}`,
      unit: "ticks",
      measure: () => clock.ticks,
      startedAt: 0,
      limit: this.limit,
      progress: "confirmed_target_damage",
      exhaustion: "Reject this attack position; recovery has a separate clock.",
    });
    this.#current = { cell, clock, budget };
    return budget;
  }

  tick(recovering: boolean): void {
    if (this.#current && !recovering) this.#current.clock.ticks++;
  }

  confirmedTargetDamage(): void {
    if (!this.#current) return;
    this.#current.clock.ticks = 0;
    this.#current.budget.observe("confirmed_target_damage");
  }

  leave(): void {
    this.#current?.budget[Symbol.dispose]();
    this.#current = null;
  }

  [Symbol.dispose](): void {
    this.leave();
  }
}
