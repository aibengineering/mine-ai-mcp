export const HOLD_GROUND_RANGE = 16;
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import type { CombatOutcome } from "../../control/combat/contract.js";
import { isRangedAttacker } from "../../perception/combat/observations.js";
import { isHostile } from "../../perception/combat/threats.js";
import { isCreeper } from "../../perception/combat/creepers.js";
import { facing } from "../../weapons/aim.js";
import { MELEE_RANGE, type CombatLoadout } from "../../weapons/equipment.js";
import {
  canMeleeTarget,
  hasMeleeKnockbackRoom,
  hasSweepBystander,
  meleeDistance,
  waitingForDescendingCube,
} from "../../weapons/melee.js";
import type { EndermanFight } from "./enderman.js";

import type { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

/** One supported melee approach or ready swing; defensive contact keeps its guard. */
/** Any hostile in reach whose next action is a hit, not only the selected quarry. */
const meleeThreatInReach = (scene: FightScene): boolean =>
  scene.perception.read().some((threat) => threat.meleeImminent);

export async function runMeleeTurn(
  scene: FightScene,
  weapons: FightWeapons,
  locomotion: FightMovement,
  roof: EndermanFight,
  loadout: Extract<CombatLoadout, { kind: "melee" }>,
): Promise<CombatOutcome | null> {
  const distance = scene.target.position.distanceTo(scene.bot.entity.position);
  const guarded = loadout.shield !== null;

  if (meleeDistance(scene.bot, scene.target) > MELEE_RANGE && scene.holdsGround) {
    if (distance > HOLD_GROUND_RANGE) {
      return {
        ...scene.result("unreachable"),
        observation: `Target ${scene.targetId} left holding range without attacking.`,
      };
    }
    if (guarded) await weapons.raiseGuard();
    await scene.execution.run("hold", () => weapons.holdFacing(1));
    return null;
  }
  if (!canMeleeTarget(scene.bot, scene.target)) {
    if (scene.movement === "hold" || scene.position.plan || waitingForDescendingCube(scene.bot, scene.target)) {
      if (guarded) await weapons.raiseGuard();
      await scene.execution.run("hold", () => weapons.holdFacing(1));
      return null;
    }
    // Turn toward an off-axis volley with the shield raised before
    // resuming approach. Beyond melee reach this does not wait out the
    // volley; standing through every draw let retreating skeletons escape.
    if (guarded && weapons.volleyActive() && !facing(scene.bot, scene.target)) {
      await weapons.raiseGuard();
      await weapons.faceGuard();
      return null;
    }
    // Closing is exactly when the guard is needed, and approach lowers a
    // shield it is not told to keep. A mob already in reach of the bot - the
    // quarry or the one beside it - is answered before the step, not after
    // its first swing.
    const stopped = await locomotion.approach(
      guarded && (weapons.projectileDefence() !== null || weapons.volleyActive() || meleeThreatInReach(scene)),
      guarded && isRangedAttacker(scene.target) ? locomotion.volleyStop : null,
    );
    // A route also stops when its target dies mid-way, which is not a
    // reachability verdict: the next iteration reports what settled it.
    if (stopped && !scene.settled()) {
      if (scene.settled()) return null;
      return { ...scene.result("unreachable"), observation: `Combat approach stopped: ${stopped}.` };
    }
    return null;
  }
  // Once an attacker is in reach of our shielded bot, combat must retain facing.
  // Routing to a safer stance on the Nether slope turned the shield away
  // and admitted repeated enderman hits. Defend this contact in place;
  // footing recovery owns an actual impulse that threatens the landing.
  // A caller holding a position likewise owns where to stand.
  // Explicit pursuit can observe anger after admission, before attribution
  // records a hit. That contact still needs the current shielded stance.
  const immediateGuard =
    guarded &&
    (scene.perception.attackerIds.has(scene.target.id) ||
      meleeThreatInReach(scene) ||
      weapons.volleyActive() ||
      isRangedAttacker(scene.target) ||
      (scene.heightLimitedTarget && (scene.defendingAtStart || scene.roofTargetHostile())));
  const defendCurrentStance =
    !isHostile(scene.target) || scene.movement === "hold" || immediateGuard || roof.state.kind === "committed";
  if (
    !defendCurrentStance &&
    scene.bot.entity.onGround &&
    !hasMeleeKnockbackRoom(scene.navigation.world, scene.bot.entity.position, scene.target.position)
  ) {
    const stopped = await locomotion.approach(guarded, null);
    if (stopped && !scene.settled()) {
      return { ...scene.result("unreachable"), observation: `No supported melee stance: ${stopped}.` };
    }
    await waitForPhysicsTicks(scene.bot, 1, scene.signal);
    return null;
  }
  if (guarded) {
    // A melee swing keeps the shield raised. Waiting out a volley here
    // let retreating skeletons leave reach before every attack, and a
    // charged blaze could wait indefinitely. Only a bow needs to lower
    // its guard for an attack window.
    await weapons.raiseGuard();
    if (scene.settled()) return null;
    if (weapons.volleyActive()) scene.projectileGuards++;
  }
  await weapons.readyWeapon();
  if (guarded) await weapons.faceGuard();
  else await weapons.face();
  if (scene.settled()) return null;
  if (!canMeleeTarget(scene.bot, scene.target)) return null;
  // The attacker can circle during shield readiness or the weapon
  // cooldown. Its old direction does not establish this swing's footing.
  if (
    !defendCurrentStance &&
    scene.bot.entity.onGround &&
    !hasMeleeKnockbackRoom(scene.navigation.world, scene.bot.entity.position, scene.target.position)
  )
    return null;
  // A bystander can enter during shield readiness or aiming. Select the
  // non-sweeping loadout on the next iteration before any attack lands.
  if (loadout.weapon?.name.endsWith("_sword") && hasSweepBystander(scene.bot, scene.target)) return null;
  if (!scene.policy.combat.melee)
    return {
      ...scene.result("capability_blocked"),
      reason: "policy",
      observation: "[COMBAT_CONSTRAINED] Melee is prohibited and no permitted shot is available.",
    };
  await scene.execution.run("swing", async () => {
    // Knockback is a property of this hit, not a separate fight mode. Report
    // the clearance obligation and let shared policy choose the next effect.
    const knockback = isCreeper(scene.target);
    if (knockback) {
      weapons.itemUse.lowerShield();
      scene.bot.setControlState("sprint", true);
    }
    try { if (!weapons.strike(scene.target, loadout)) return; }
    finally { if (knockback) scene.bot.setControlState("sprint", false); }
    if (knockback) scene.perception.creeperClearance.require(
      scene.perception.creeperClearance.observe(scene.perception.tick, scene.perception.resolvedIds)
        .filter(threat => threat.id === scene.target.id),
    );
    await weapons.holdFacing(loadout.cooldownTicks);
  });
  return null;
}
