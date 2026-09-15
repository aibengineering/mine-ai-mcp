import type { Bot } from "mineflayer";
import { isDeepStrictEqual } from "node:util";
import { BodyAbort } from "../../session/abort.js";
import type { ActionRunner } from "../../session/action-runner.js";
import { Answered, type Facts } from "../state/answered.js";
import { Budgets } from "../state/budgets.js";
import type { ReflexDefinition, ReflexName, ReflexSnapshot, SurvivalTransition } from "./contract.js";
import { REFLEX_PRIORITY } from "./priority.js";

interface RegisteredReflex {
  readonly name: ReflexName;
  tick(): void;
  stop(reason: BodyAbort): void;
  close(): Promise<void>;
  settled(): Promise<void>;
  snapshot(): ReflexSnapshot;
}

/** One ranked loop and one settlement path for all six survival responses. */
export class ReflexDriver implements AsyncDisposable {
  readonly answered = new Answered();
  readonly budgets = new Budgets();
  readonly #definitions = new Map<ReflexName, RegisteredReflex>();
  readonly #observers = new Set<(transition: SurvivalTransition) => void>();
  #closed = false;
  #listening = false;
  #world = 0;
  #dimension: string;

  constructor(
    readonly bot: Bot,
    readonly runner: ActionRunner,
  ) {
    this.#dimension = bot.game?.dimension;
    bot.on("death", this.#death);
    bot.on("game", this.#game);
  }

  onTransition(observer: (transition: SurvivalTransition) => void): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  #publish(transition: SurvivalTransition): void {
    for (const observer of this.#observers) observer(transition);
  }

  readonly #tick = (): void => {
    if (this.#closed || this.bot.health <= 0 || !this.runner.ownership().connected) return;
    for (const name of REFLEX_PRIORITY) this.#definitions.get(name)?.tick();
  };

  readonly #death = (): void => {
    this.#reset(new BodyAbort({ kind: "death" }, "The bot died."));
  };

  readonly #game = (): void => {
    const to = this.bot.game.dimension;
    if (to === this.#dimension) return;
    const from = this.#dimension;
    this.#dimension = to;
    this.#reset(new BodyAbort({ kind: "dimension_changed", from, to }, `Dimension changed from ${from} to ${to}.`));
  };

  #reset(cause: BodyAbort): void {
    this.#world++;
    this.answered.clear();
    for (const definition of this.#definitions.values()) definition.stop(cause);
  }

  /** Policy settlement waits for this response's effects, without unregistering its sensor. */
  async cancel(name: ReflexName, cause: BodyAbort): Promise<void> {
    const definition = this.#definitions.get(name);
    definition?.stop(cause);
    await definition?.settled();
  }

  register<Danger, Response, Outcome>(definition: ReflexDefinition<Danger, Response, Outcome>): AsyncDisposable {
    if (this.#closed) throw new Error("The survival driver is closed.");
    if (this.#definitions.has(definition.name)) throw new Error(`Duplicate reflex: ${definition.name}`);
    const lifetime = new AbortController();
    let pending: Promise<void> | null = null;
    let active: { name: string; startedAt: number; controller: AbortController; signal: AbortSignal | null } | null =
      null;
    let danger: Facts = null;
    let missing: string | null = null;
    let decision: Facts = null;
    let observedDanger: Facts = null;
    let observedAt: number | null = null;
    let observedWorld = -1;
    let ticks = 0;
    const changeDecision = (next: Facts, inputs: () => Facts = () => danger) => {
      if (isDeepStrictEqual(next, decision)) return;
      decision = next;
      this.#publish({ kind: "decision", reflex: definition.name, evidence: { decision: next, inputs: inputs() } });
    };
    const registration: RegisteredReflex = {
      name: definition.name,
      snapshot: () => ({
        name: definition.name,
        danger,
        missing,
        decision,
        observedAt,
        stale: observedWorld !== this.#world,
        response: active
          ? {
              name: active.name,
              startedAt: active.startedAt,
              releasing: active.controller.signal.aborted || active.signal?.aborted === true,
            }
          : null,
      }),
      stop: (reason) => {
        active?.controller.abort(reason);
      },
      settled: () => pending ?? Promise.resolve(),
      close: async () => {
        lifetime.abort(new BodyAbort({ kind: "cancelled", by: "runtime" }, `${definition.name} closed.`));
        await pending;
      },
      tick: () => {
        if (lifetime.signal.aborted) return;
        if (++ticks % (definition.intervalTicks ?? 1) !== 0) return;
        const sensed = definition.sense();
        observedAt = Date.now();
        observedWorld = this.#world;
        danger = sensed?.kind === "observed" ? sensed.evidence : null;
        missing = sensed?.kind === "unknown" ? sensed.missing : null;
        const nextDanger = { danger, missing };
        if (!isDeepStrictEqual(nextDanger, observedDanger)) {
          observedDanger = structuredClone(nextDanger);
          this.#publish({ kind: "danger", reflex: definition.name, evidence: nextDanger });
        }
        if (pending) return;
        if (sensed?.kind !== "observed") {
          changeDecision(null);
          return;
        }
        const chosen = definition.decide(sensed.danger);
        const inputs = () => definition.decisionFacts?.(sensed.danger) ?? danger;
        if (chosen.kind !== "respond") {
          changeDecision(
            chosen.kind === "handled"
              ? { kind: chosen.kind, by: chosen.by }
              : {
                  kind: chosen.kind,
                  candidates: chosen.candidates.map(({ response, excluded }) => ({
                    response,
                    excluded: { ...excluded },
                  })),
                },
            inputs,
          );
          return;
        }
        const scope = definition.facts(chosen.response);
        const answered = this.answered.find(scope.capability, scope.scope);
        if (answered) {
          changeDecision(
            {
              kind: "stand_down",
              candidates: [{ response: chosen.name, excluded: { kind: "answered", entry: answered.id } }],
            },
            inputs,
          );
          return;
        }
        changeDecision({ kind: "respond", response: chosen.name, reason: chosen.reason }, inputs);
        const controller = new AbortController();
        const world = this.#world;
        let signal: AbortSignal | null = null;
        active = { name: chosen.name, startedAt: Date.now(), controller, signal: null };
        const claim = this.runner.claim(
          definition.name,
          chosen.reason,
          async (bodySignal) => {
            signal = AbortSignal.any([bodySignal, controller.signal, lifetime.signal]);
            if (active) active.signal = signal;
            signal.throwIfAborted();
            const outcome = await definition.act(chosen.response, signal);
            const continuation = definition.continuation(outcome);
            return {
              value: outcome,
              continuation: signal.aborted
                ? {
                    kind: "cancel" as const,
                    cause:
                      signal.reason instanceof BodyAbort
                        ? signal.reason.detail
                        : { kind: "cancelled" as const, by: "runtime" as const },
                  }
                : continuation,
            };
          },
          definition.releaseAfterAdmission,
        );
        if (claim.kind !== "claimed") {
          active = null;
          return;
        }
        this.#publish({
          kind: "claim",
          reflex: definition.name,
          evidence: {
            response: chosen.name,
            interrupted: claim.interrupted ? { ...claim.interrupted } : null,
          },
        });
        pending = claim.outcome
          .then((outcome) => {
            const cancelled = signal?.aborted || lifetime.signal.aborted || world !== this.#world;
            const failure = cancelled ? null : definition.failure(outcome);
            // Movement or construction can change the attempted arrangement.
            // Remember the settled scope, including its identity, so an evade
            // cannot buy another full attempt just by moving before it fails.
            if (failure)
              this.answered.remember(
                definition.facts(chosen.response),
                failure,
                definition.temporal?.(outcome) ?? null,
              );
            definition.settled?.(chosen.response, outcome, claim.interrupted);
            this.#publish({
              kind: "outcome",
              reflex: definition.name,
              evidence: {
                response: chosen.name,
                cancelled: Boolean(cancelled),
                outcome: definition.describe(outcome),
                interrupted: claim.interrupted ? { ...claim.interrupted } : null,
              },
            });
          })
          .catch((cause: unknown) => {
            // An exception is evidence of an execution failure, never proof that geometry is impossible.
            const cancelled = signal?.aborted || lifetime.signal.aborted || world !== this.#world;
            if (!cancelled)
              this.answered.remember(definition.facts(chosen.response), {
                kind: "execution_failed",
                why: cause instanceof Error ? cause.message : String(cause),
              });
            this.#publish({
              kind: "outcome",
              reflex: definition.name,
              evidence: {
                response: chosen.name,
                kind: signal?.aborted || world !== this.#world ? "cancelled" : "execution_failed",
                why: cause instanceof Error ? cause.message : String(cause),
              },
            });
          })
          .finally(() => {
            pending = null;
            active = null;
          });
      },
    };
    this.#definitions.set(definition.name, registration);
    if (!this.#listening) {
      // Register after shared packet/physics observers, so decisions use this tick's attribution.
      this.#listening = true;
      this.bot.on("physicsTick", this.#tick);
    }
    return {
      [Symbol.asyncDispose]: async () => {
        this.#definitions.delete(definition.name);
        await registration.close();
      },
    };
  }

  snapshot(): ReflexSnapshot[] {
    return REFLEX_PRIORITY.flatMap((name) => {
      const definition = this.#definitions.get(name);
      return definition ? [definition.snapshot()] : [];
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.bot.off("physicsTick", this.#tick);
    this.bot.off("death", this.#death);
    this.bot.off("game", this.#game);
    const closing = [...this.#definitions.values()].map((definition) => definition.close());
    await Promise.all(closing);
    this.answered.clear();
    this.#definitions.clear();
  }
}
