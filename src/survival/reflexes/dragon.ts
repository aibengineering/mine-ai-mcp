import type { Bot } from "mineflayer";
import type { CombatController } from "../control/combat/contract.js";

import { incomingDragonFireballs, readDragonBreathHazards } from "../../world/dragon-hazards.js";
import { dragonPhase } from "../../world/end-fight.js";
import type { ReflexDriver } from "../control/driver.js";
import { decideEndResponse } from "../policy/combat/end-decision.js";
import { responsePermissions } from "../policy/combat/permissions.js";

/** The same End executor answers hazards between requests. */
export function attachDragonReflex(
  bot: Bot,
  driver: ReflexDriver,
  combat: Pick<CombatController, "runEnd" | "activeEngagement" | "endDanger" | "policy">,
): AsyncDisposable {
  const scene = () => ({
    clouds: readDragonBreathHazards(bot).map((cloud) => ({ ...cloud })),
    projectiles: incomingDragonFireballs(bot).map((entity) => entity.id),
    bodies: Object.values(bot.entities)
      .filter((entity) => entity.isValid && entity.name === "ender_dragon")
      .map((entity) => ({
        id: entity.id,
        phase: dragonPhase(bot, entity),
        cell: entity.position.floored().toString(),
        yaw: entity.yaw,
      })),
  });
  return driver.register({
    name: "dragon_reflex",
    sense: () => {
      if (!combat.endDanger()) return null;
      const facts = {
        ...scene(),
        combatActive: combat.activeEngagement() !== null,
        policySettling: combat.policy.settling,
        policy: { ...combat.policy.combat, terrain: { ...combat.policy.combat.terrain } },
      };
      return { kind: "observed", danger: facts, evidence: facts };
    },
    decide: (facts) => {
      if (facts.combatActive) return { kind: "handled", by: "combat" };
      if (facts.policySettling) return { kind: "handled", by: "policy_settlement" };
      const response = decideEndResponse(facts.policy, true, "evade");
      if (response.kind === "constrained")
        return {
          kind: "stand_down",
          candidates: [{ response: "evade", excluded: { kind: "prohibited", field: response.field } }],
        };
      return {
        kind: "respond",
        response: "evade",
        name: "evade",
        reason: "Dragon breath, projectile or body contact threatens the bot",
      };
    },
    facts: () => ({
      capability: "dragon",
      response: "evade",
      scope: `cell:${bot.entity.position.floored()}`,
      facts: scene,
      permissions: () => ({
        ...responsePermissions(combat.policy.combat, "evade"),
        shelter: responsePermissions(combat.policy.combat, "hide"),
        food: { ...combat.policy.food.raw },
      }),
    }),
    act: (_response, signal) => combat.runEnd({ kind: "evade" }, signal),
    continuation: (outcome) =>
      outcome.outcome === "evaded" && !combat.endDanger()
        ? { kind: "resume" }
        : { kind: "return", reason: outcome.reason },
    failure: (outcome) =>
      outcome.outcome === "stopped"
        ? { kind: "escape_stopped", why: outcome.reason ?? "Dragon escape stopped." }
        : null,
    describe: (outcome) => ({ ...outcome }),
  });
}
