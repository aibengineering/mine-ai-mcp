export interface BudgetSnapshot {
  readonly name: string;
  readonly scope: string;
  readonly mode: "attempt" | "progress";
  readonly unit: "milliseconds" | "ticks";
  readonly limit: number;
  readonly spent: number;
  readonly remaining: number;
  readonly exhaustion: string;
  readonly progress: string | null;
}

interface BudgetScope {
  readonly name: string;
  readonly scope: string;
  readonly unit: BudgetSnapshot["unit"];
  readonly limit: number;
  readonly measure: () => number;
  /** A resumed attempt retains its original starting measurement. */
  readonly startedAt?: number;
  readonly exhaustion: string;
}

export interface AttemptBudget extends Disposable {
  readonly exhausted: boolean;
  readonly remaining: number;
}

export interface ProgressBudget extends AttemptBudget {
  /** Only the declared objective observation renews this window. */
  observe(evidence: string): void;
}

/** Active spending belongs to its owner. A new route cannot renew an attempt. */
export class Budgets {
  readonly #active = new Set<() => BudgetSnapshot>();

  attempt(scope: BudgetScope): AttemptBudget {
    return this.open(scope, null);
  }

  progress(scope: BudgetScope & { readonly progress: string }): ProgressBudget {
    return this.open(scope, scope.progress);
  }

  private open(scope: BudgetScope, progress: string | null): ProgressBudget {
    let start = scope.startedAt ?? scope.measure();
    const snapshot = (): BudgetSnapshot => {
      const spent = Math.max(0, scope.measure() - start);
      return {
        name: scope.name,
        scope: scope.scope,
        mode: progress === null ? "attempt" : "progress",
        unit: scope.unit,
        limit: scope.limit,
        spent,
        remaining: Math.max(0, scope.limit - spent),
        exhaustion: scope.exhaustion,
        progress,
      };
    };
    this.#active.add(snapshot);
    return {
      get exhausted() {
        return snapshot().remaining === 0;
      },
      get remaining() {
        return snapshot().remaining;
      },
      observe: (evidence) => {
        if (progress !== null && evidence === progress) start = scope.measure();
      },
      [Symbol.dispose]: () => {
        this.#active.delete(snapshot);
      },
    };
  }

  snapshot(): BudgetSnapshot[] {
    return [...this.#active].map((read) => read());
  }
}
