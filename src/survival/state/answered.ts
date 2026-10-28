import { isDeepStrictEqual } from "node:util";
import type { Facts } from "../../utils/facts.js";

export interface AnsweredScope {
  readonly capability: string;
  readonly response: string;
  readonly scope: string;
  readonly facts: () => Facts;
  readonly permissions: () => Facts;
  /** Release observation subscriptions when this conclusion expires. */
  readonly dispose?: () => void;
}

export interface AnsweredEntry {
  readonly id: number;
  readonly capability: string;
  readonly response: string;
  readonly scope: string;
  readonly facts: Facts;
  readonly consumed: Facts;
  readonly failure: { readonly kind: string; readonly why: string };
  readonly since: number;
}

interface RetainedAnswer {
  readonly entry: AnsweredEntry;
  readonly read: AnsweredScope;
}

/** One runtime's failed scopes. Cancellation and policy refusals are not failures. */
export class Answered {
  readonly #entries = new Map<number, RetainedAnswer>();
  #nextId = 1;

  constructor(private readonly now: () => number = Date.now) {}

  /** Capture after settlement, so the attempt's own construction cannot rearm itself. */
  remember(scope: AnsweredScope, failure: AnsweredEntry["failure"]): AnsweredEntry {
    this.forget(scope.capability, scope.scope);
    const entry: AnsweredEntry = {
      id: this.#nextId++,
      capability: scope.capability,
      response: scope.response,
      scope: scope.scope,
      facts: structuredClone(scope.facts()),
      consumed: structuredClone(scope.permissions()),
      failure,
      since: this.now(),
    };
    this.#entries.set(entry.id, { entry, read: scope });
    return entry;
  }

  /** Each capability declares the facts that can reopen its conclusion. */
  find(capability: string, scope: string): AnsweredEntry | null {
    for (const [id, answer] of this.#entries) {
      if (answer.entry.capability !== capability || answer.entry.scope !== scope) continue;
      if (this.current(answer)) return answer.entry;
      answer.read.dispose?.();
      this.#entries.delete(id);
    }
    return null;
  }

  private current({ entry, read }: RetainedAnswer): boolean {
    return (
      isDeepStrictEqual(entry.facts, read.facts()) &&
      isDeepStrictEqual(entry.consumed, read.permissions())
    );
  }

  forget(capability: string, scope?: string): void {
    for (const [id, { entry, read }] of this.#entries)
      if (entry.capability === capability && (scope === undefined || entry.scope === scope)) {
        read.dispose?.();
        this.#entries.delete(id);
      }
  }

  clear(): void {
    for (const { read } of this.#entries.values()) read.dispose?.();
    this.#entries.clear();
  }

  snapshot(): AnsweredEntry[] {
    for (const [id, answer] of this.#entries)
      if (!this.current(answer)) {
        answer.read.dispose?.();
        this.#entries.delete(id);
      }
    return [...this.#entries.values()].map(({ entry }) => entry);
  }
}
