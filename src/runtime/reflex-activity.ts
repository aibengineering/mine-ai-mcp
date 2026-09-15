import type { ActionRunner } from "../session/action-runner.js";
import { reflexStateKey, type ReflexStateIdentity } from "../session/progress.js";
import type { CombatController } from "../survival/control/combat/contract.js";
import type { ReflexDriver } from "../survival/control/driver.js";
import type { Facts } from "../survival/state/answered.js";

function record(value: Facts | undefined): value is { readonly [name: string]: Facts } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The states one reflex decision occupies: the response it runs, or every
 * candidate it withheld with the reason. "handled" delegates elsewhere and
 * occupies nothing, so a stand-down summary never blames a busy body on policy. */
export function decisionStates(reflex: string, decision: Facts | undefined): ReflexStateIdentity[] {
  if (!record(decision)) return [];
  if (decision.kind === "respond" && typeof decision.response === "string") {
    return [{ kind: "response", reflex, name: decision.response, exclusion: null, detail: null }];
  }
  if (decision.kind !== "stand_down" || !Array.isArray(decision.candidates)) return [];
  return decision.candidates.flatMap((candidate) => {
    if (!record(candidate) || typeof candidate.response !== "string" || !record(candidate.excluded)) return [];
    const { kind, ...rest } = candidate.excluded;
    if (typeof kind !== "string") return [];
    const detail = Object.values(rest).find((value) => typeof value === "string" || typeof value === "number");
    return [{ kind: "withheld", reflex, name: candidate.response, exclusion: kind, detail: detail === undefined ? null : String(detail) }];
  });
}

/** Translate reflex decisions and combat phases into state boundaries the active request accrues.
 * Decisions are published only on change, so each boundary here is one real entry or exit. */
export function observeReflexActivity(
  driver: Pick<ReflexDriver, "onTransition">,
  combat: Pick<CombatController, "onDecision">,
  runner: Pick<ActionRunner, "recordReflexActivity">,
): () => void {
  const occupied = new Map<string, Map<string, ReflexStateIdentity>>();
  const apply = (source: string, next: readonly ReflexStateIdentity[]) => {
    const current = occupied.get(source) ?? new Map<string, ReflexStateIdentity>();
    occupied.set(source, current);
    const wanted = new Map(next.map((state) => [reflexStateKey(state), state] as const));
    for (const [key, state] of current) {
      if (wanted.has(key)) continue;
      current.delete(key);
      runner.recordReflexActivity({ kind: "left", state });
    }
    for (const [key, state] of wanted) {
      if (current.has(key)) continue;
      current.set(key, state);
      runner.recordReflexActivity({ kind: "entered", state });
    }
  };
  const subscriptions = [
    driver.onTransition((transition) => {
      if (transition.kind !== "decision") return;
      apply(transition.reflex, decisionStates(transition.reflex, record(transition.evidence) ? transition.evidence.decision : null));
    }),
    combat.onDecision((event) => {
      if (event.kind === "phase") {
        apply("combat", [{ kind: "combat_phase", reflex: "combat", name: event.phase, exclusion: null, detail: null }]);
      } else if (event.kind === "engagement" && event.state === "ended") apply("combat", []);
    }),
  ];
  return () => {
    for (const unsubscribe of subscriptions) unsubscribe();
    for (const source of occupied.keys()) apply(source, []);
  };
}
