import { decideCombatTactic, type CombatTacticalFacts, type CombatTactic } from "../../policy/combat/tactics.js";
import { creeperRetreatHeading } from "../../positioning/combat/creeper-retreat.js";
import type { FightScene } from "../../responses/fight/scene.js";
import type { FightWeapons } from "../../responses/fight/weapons.js";
import { blastBarrierCells, blastBarrierMaterial } from "../../positioning/combat/blast-barrier.js";
import { blastBarrierScope } from "./scopes/blast-barrier.js";
import { permitsHide } from "../../policy/combat/permissions.js";
import { selectPolicyFood } from "../../perception/food.js";
import { canMeleeTarget } from "../../weapons/melee.js";

/** One interruptible effect under the existing combat owner. Observation selects;
 * cancellation only requests release. The caller awaits it before the next tactic. */
export class CombatTactics {
  #effect: { stop: AbortController; signal: AbortSignal; kind: CombatTactic["kind"] } | null = null;
  #key = "";
  constructor(readonly lifetime: AbortSignal) {}
  get signal(): AbortSignal { return this.#effect?.signal ?? this.lifetime; }
  observe(scene: FightScene, weapons: FightWeapons): CombatTactic {
    const { bot, perception } = scene;
    const creepers = perception.creeperClearance.observe(perception.tick, perception.resolvedIds);
    const projectile = weapons.projectileDefence();
    const loadout = weapons.currentLoadout();
    const counter = scene.policy.combat.melee ? creepers
      .filter(threat => threat.observed && canMeleeTarget(bot, bot.entities[threat.id]!))
      .sort((a, b) => Number(b.swelling) - Number(a.swelling) || a.distance - b.distance)[0] : null;
    const escapeAvailable = creepers.length > 0 && creeperRetreatHeading(bot, creepers, null, perception.resolvedIds) !== null;
    const canBuild = !escapeAvailable && scene.policy.combat.terrain?.place &&
      permitsHide(scene.policy.combat, bot.food >= 18 || selectPolicyFood(bot, scene.policy.food).food !== null) && blastBarrierMaterial(bot);
    const barrier = canBuild ? blastBarrierCells(bot, creepers).find(cell => {
      const scope = blastBarrierScope(bot, cell, () => scene.policy.combat);
      return !scene.survival.answered.find(scope.capability, scope.scope);
    }) : null;
    const facts: CombatTacticalFacts = {
      creepers: creepers.map(({ id, distance, swelling, observed, exposed, fuseRemainingTicks }) => ({ id, distance, swelling, observed, exposed, fuseRemainingTicks })),
      clearancePending: perception.creeperClearance.pending,
      retreatPermitted: scene.policy.combat.retreat,
      escapeAvailable,
      counterTarget: counter?.id ?? null,
      counterReady: scene.elapsedTicks >= weapons.weaponReadyAt,
      barrier: barrier ? { x: barrier.x, y: barrier.y, z: barrier.z } : null,
      // Contact defence executes before a quarry's bow turn. Price the next
      // available action, rather than treating a carried bow as a commitment.
      stationaryCommitment: weapons.itemUse.drawingBow ||
        (loadout.kind === "bow" && !(scene.policy.combat.melee && weapons.contact())),
      footingRecovery: scene.footingRecovery.needed,
      shield: { available: loadout.shield !== null, raised: weapons.itemUse.shieldRaised },
      // Any hostile in reach, not only the selected quarry: the swing that
      // opens a fight is often from the one the bot did not pick.
      meleeImminent: perception.read().some((threat) => threat.meleeImminent),
      projectile: projectile ? { imminent: projectile.imminent, aligned: projectile.aligned, coversAll: projectile.coversAll,
        impactInTicks: projectile.projectiles[0]?.impactInTicks ?? projectile.windupForecasts[0]?.impactInTicks ?? null } : null,
    };
    const decision = decideCombatTactic(facts);
    if (decision.kind === "escape") perception.creeperClearance.require(creepers.filter(threat => decision.threatIds.includes(threat.id)));
    if (["counter_blast", "blast_barrier", "brace_blast"].includes(decision.kind)) perception.creeperClearance.require(creepers.filter(threat => threat.distance <= 8));
    const key = JSON.stringify([decision, facts.creepers.map(threat => [threat.id, threat.swelling]), facts.clearancePending]);
    if (key !== this.#key) {
      this.#key = key;
      scene.reportDecision({ kind: "response", evidence: { boundary: "tactic", inputs: { ...facts }, decision: { ...decision } } });
    }
    if (decision.kind === "recover_footing" && this.#effect && this.#effect.kind !== "recover_footing")
      this.#effect.stop.abort(new Error("An unsafe impulse requires a protected landing."));
    if ((decision.kind === "escape" || decision.kind === "constrained" || decision.kind === "counter_blast" || decision.kind === "blast_barrier" || decision.kind === "brace_blast") && this.#effect && !["escape", "recover_footing", "counter_blast", "blast_barrier", "brace_blast"].includes(this.#effect.kind))
      this.#effect.stop.abort(new Error("Surrounding blast danger requires a defensive tactic."));
    return decision;
  }
  async run<T>(decision: CombatTactic, effect: () => Promise<T>): Promise<{ kind: "completed"; value: T } | { kind: "interrupted" }> {
    const stop = new AbortController();
    this.#effect = { stop, signal: AbortSignal.any([this.lifetime, stop.signal]), kind: decision.kind };
    try {
      const value = await effect();
      this.lifetime.throwIfAborted();
      return stop.signal.aborted ? { kind: "interrupted" } : { kind: "completed", value };
    } catch (cause) {
      this.lifetime.throwIfAborted();
      // Only our cancellation is an interrupted tactic. A failing release is
      // still a combat failure; it cannot authorise another effect on the body.
      if (!stop.signal.aborted || cause !== stop.signal.reason) throw cause;
      return { kind: "interrupted" };
    } finally { this.#effect = null; }
  }
}
