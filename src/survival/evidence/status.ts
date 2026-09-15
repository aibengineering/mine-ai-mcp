import type { Bot } from "mineflayer";
import type { CombatController } from "../control/combat/contract.js";

import type { ActionRunner } from "../../session/action-runner.js";
import { airSupplyTicks } from "../../world/air-supply.js";
import { isInWater } from "../perception/body.js";
import type { ReflexDriver } from "../control/driver.js";
import type { SurvivalStatus } from "./contract.js";

/** A view of independent lifetimes; no cached summary or second state machine. */
export class SurvivalObserver implements Disposable {
  #physicsObservedAt: number | null = null;
  readonly #tick = () => {
    this.#physicsObservedAt = Date.now();
  };

  constructor(
    readonly bot: Bot,
    readonly runner: ActionRunner,
    readonly driver: ReflexDriver,
    readonly combat: CombatController,
  ) {
    bot.on("physicsTick", this.#tick);
  }

  snapshot(): SurvivalStatus {
    const owner = this.runner.ownership();
    const reflexes = this.driver.snapshot();
    const selected = reflexes.find((reflex) => reflex.name === (owner.reserved ?? owner.current));
    const fighting = this.combat.activeEngagement();
    const execution = fighting ? this.combat.execution() : null;
    const air = airSupplyTicks(this.bot);
    const missing = reflexes.flatMap((reflex) => (reflex.missing ? [reflex.missing] : []));
    const stale = reflexes.filter((reflex) => reflex.stale).map((reflex) => reflex.name);
    if (air === null && !missing.includes("own_air_metadata")) missing.push("own_air_metadata");
    const dangers = reflexes
      .filter((reflex) => reflex.danger !== null)
      .map((reflex) => ({
        reflex: reflex.name,
        evidence: reflex.danger,
        selected: reflex === selected,
        unresolved: true,
        observedAt: reflex.observedAt,
        stale: reflex.stale,
      }));
    const standingDown = reflexes.some(
      (reflex) =>
        reflex.decision !== null &&
        typeof reflex.decision === "object" &&
        "kind" in reflex.decision &&
        reflex.decision.kind === "stand_down",
    );
    const responding =
      owner.reserved !== null || (selected?.response !== null && selected?.response !== undefined) || fighting !== null;
    return {
      summary:
        this.bot.health <= 0
          ? "dead"
          : responding
            ? "responding"
            : standingDown
              ? "standing_down"
              : dangers.length
                ? "threatened"
                : missing.length || stale.length
                  ? "unknown"
                  : "safe",
      request: this.runner.request(),
      owner,
      dangers,
      response: execution
        ? {
            capability: fighting?.kind === "end" ? "end" : "combat",
            kind: selected?.response?.name ?? "fight",
            phase: execution.phase,
            phaseTicks: execution.phaseTicks,
            startedAt: selected?.response?.startedAt ?? null,
          }
        : selected?.response
          ? {
              capability: selected.name,
              kind: selected.response.name,
              phase: selected.response.releasing ? "release" : selected.response.name,
              phaseTicks: null,
              startedAt: selected.response.startedAt,
            }
          : null,
      decisions: reflexes
        .filter((reflex) => reflex.decision !== null)
        .map((reflex) => ({ reflex: reflex.name, decision: reflex.decision })),
      budgets: this.driver.budgets.snapshot(),
      answered: this.driver.answered.snapshot(),
      observations: { missing, stale },
      policy: this.combat.policy.snapshot(),
      vitals: { health: this.bot.health, food: this.bot.food, air: air === null ? null : air / 15, inWater: isInWater(this.bot) },
      // The external supervisor detects a stopped process. This timestamp says only when this process answered.
      runtime: {
        liveness: owner.connected ? "observed_in_process" : "disconnected",
        observedAt: Date.now(),
        physicsObservedAt: this.#physicsObservedAt,
      },
    };
  }

  [Symbol.dispose](): void {
    this.bot.off("physicsTick", this.#tick);
  }
}
