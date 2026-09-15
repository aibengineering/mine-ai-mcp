import type { CombatOutcome } from "../../control/combat/contract.js";
import { isHostile } from "../../perception/combat/threats.js";
import { permittedCombatItems } from "../../policy/combat/permissions.js";
import { MELEE_RANGE, selectRangedLoadout } from "../../weapons/equipment.js";
import { combatItemsForTarget, hasMeleeKnockbackRoom, meleeDistance } from "../../weapons/melee.js";
import type { CoverFight } from "./cover.js";
import type { CombatTactic } from "../../policy/combat/tactics.js";
import type { EndermanFight } from "./enderman.js";
import type { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

import { runMeleeTurn } from "./melee-turn.js";
import { runRangedTurn } from "./ranged-turn.js";
/** Observe settlement, maintain protection, answer contact, then execute one attack turn. */
export async function runFightTurn(
  scene: FightScene,
  weapons: FightWeapons,
  locomotion: FightMovement,
  cover: CoverFight,
  roof: EndermanFight,
  tactic: CombatTactic,
): Promise<CombatOutcome | null> {
  scene.signal.throwIfAborted();
  if (scene.footingRecovery.needed) {
    await locomotion.recoverFooting();
    return null;
  }
  if (scene.observed) {
    if (scene.observed === "target_lost")
      roof.reportRoof("stopped", "The selected enderman left observation while the bot held its roof.");
    return scene.result(scene.observed);
  }
  if (scene.target !== scene.requestedTarget && (!scene.target.isValid || scene.dead.has(scene.target.id))) {
    scene.focus(scene.requestedTarget);
  }
  if (!scene.requestedTarget.isValid) {
    roof.reportRoof("stopped", "The selected enderman left observation while the bot held its roof.");
    return scene.result("target_lost");
  }
  // The quarry does not own facing while another shooter's arrow is due.
  // Approach has already settled before this turn can hold the body.
  const defence = weapons.projectileDefence();
  if (tactic.kind === "guard" && defence) {
    scene.reportDecision({ kind: "response", evidence: {
      boundary: "projectile_guard", stage: "guard_admitted",
      projectileIds: defence.projectiles.map(({ entity }) => entity.id),
      windingUpIds: defence.windingUp.map((entity) => entity.id),
      impactInTicks: defence.projectiles.map(({ impactInTicks }) => impactInTicks),
      coversAll: defence.coversAll, aligned: defence.aligned,
    } });
    if (!(await weapons.guardIncoming())) return scene.guardLimit();
    return null;
  }
  // Melee imminence admits the same tactic without a projectile to face. There
  // is nothing to aim the shield at but the attacker already in reach, so this
  // raises the guard and returns; the next turn attacks with it up.
  if (tactic.kind === "guard" && weapons.currentLoadout().shield) {
    await weapons.raiseGuard();
    await weapons.holdFacing(1);
    return null;
  }
  roof.refresh();
  if (
    !scene.policy.combat.melee &&
    !selectRangedLoadout(permittedCombatItems(combatItemsForTarget(scene.bot, scene.target), scene.policy.combat))
  ) {
    if (scene.policy.combat.shield && weapons.currentLoadout().shield) {
      await weapons.raiseGuard();
      await weapons.holdFacing(1);
      return null;
    }
    return {
      ...scene.result("capability_blocked"),
      reason: "policy",
      observation: "[COMBAT_CONSTRAINED] No permitted attack or shield is available.",
    };
  }
  const maintained = await roof.maintain();
  if (maintained.kind !== "ready") return maintained.kind === "outcome" ? maintained.outcome : null;
  const positioning = await locomotion.positionEffect(cover.keepPosition);
  if (positioning.kind === "interrupted") return null;
  const positioned = positioning.value;
  if (positioned.kind === "continue") return null;
  if (positioned.kind === "outcome") {
    return positioned.outcome;
  }
  if (await weapons.defendContact()) return null;
  // Establish landing room before committing to an exposed approach.
  // Contact defence above remains immediate; a nearby sword target is
  // never made to wait for construction.
  if (
    !scene.heightLimitedTarget &&
    isHostile(scene.target) &&
    scene.movement === "pursue" &&
    !scene.position.plan &&
    meleeDistance(scene.bot, scene.target) > MELEE_RANGE &&
    !hasMeleeKnockbackRoom(scene.navigation.world, scene.bot.entity.position, scene.target.position)
  ) {
    if (weapons.currentLoadout().shield) await weapons.raiseGuard();
    try {
      const backstop = await locomotion.positionEffect((effectSignal) =>
        scene.execution.run("establish", () => scene.position.establishBackstop(effectSignal)),
      );
      if (backstop.kind === "interrupted" || backstop.value) return null;
    } finally {
      weapons.itemUse.invalidateShield();
    }
  }
  const loadout = weapons.currentLoadout();
  await weapons.equip(loadout);
  const guarded = loadout.kind === "melee" && loadout.shield !== null;
  // Bow admission owns lowering its guard, after checking the whole shot window.
  if (loadout.kind === "melee" && weapons.itemUse.shieldRaised && !guarded) weapons.itemUse.lowerShield();
  scene.stylesUsed.add(loadout.kind === "bow" ? "bow" : guarded ? "shielded_melee" : "melee");
  scene.weaponsUsed.add(loadout.weapon?.name ?? "hand");
  scene.signal.throwIfAborted();
  if (loadout.kind === "bow") return runRangedTurn(scene, weapons, locomotion, cover, loadout);
  const prepared = await roof.prepare(guarded);
  if (prepared.kind !== "ready") return prepared.kind === "outcome" ? prepared.outcome : null;

  return runMeleeTurn(scene, weapons, locomotion, roof, loadout);
}
