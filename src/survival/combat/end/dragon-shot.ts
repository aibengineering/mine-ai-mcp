import { isDragonPerched } from "../../../world/end-fight.js";
import { observedEyeHeight } from "../../../world/block-visibility.js";
import type { DragonShotObservation } from "../../perception/combat/dragon-shot.js";
import { endermanGazeRisk } from "../../perception/combat/gaze.js";
import { decideEndResponse } from "../../policy/combat/end-decision.js";
import { permittedCombatItems } from "../../policy/combat/permissions.js";
import { bowTrajectory, clearBowTrajectory } from "../../positioning/combat/bow-trajectory.js";
import { fitsDragonShot } from "../../weapons/dragon-shot.js";
import { CombatItemUse } from "../../weapons/item-use.js";
import { equipCombatLoadout, readCombatItems, selectRangedLoadout } from "../../weapons/equipment.js";
import { EndCore, type EndCombatResult } from "./core.js";

/** Shoots the perched or circling dragon with a bow and reports the hit. */
export class DragonShot {
  constructor(private readonly end: EndCore) {}

  /** One flight shot from the current footing; no perch preparation or tower chase. */
  async shootDragon(signal: AbortSignal, observation: DragonShotObservation): Promise<EndCombatResult> {
    const bot = this.end.bot;
    const finish = (outcome: EndCombatResult["outcome"], reason: string | null = null): EndCombatResult => {
      observation.phase = "settled";
      return { outcome, reason, attacks: observation.attacks, healthBefore: observation.healthBefore,
        healthAfter: observation.healthAfter, bow: observation.evidence };
    };
    const unavailable = () => {
      if (!this.end.policy().combat.bow) return "[COMBAT_CONSTRAINED] Bow use is prohibited.";
      if (!selectRangedLoadout(permittedCombatItems(readCombatItems(bot), this.end.policy().combat)))
        return "[DRAGON_BOW_UNAVAILABLE] Carry a permitted bow and arrows before shooting.";
      return null;
    };
    // The body pose does not require unsent head/neck flight history. Lead its
    // centre from observed motion; the parent's 16-wide box is not a hitbox.
    const aim = () => {
      const dragon = observation.target!, velocity = observation.velocity, previousVelocity = observation.previousVelocity;
      if (!velocity || !previousVelocity) { observation.blockedBy = "Waiting for fresh dragon motion."; return null; }
      const target = dragon.position.offset(Math.sin(dragon.yaw) * 0.5, 1.5, Math.cos(dragon.yaw) * 0.5);
      if (bot.entity.position.distanceTo(target) > 64) {
        observation.blockedBy = "Dragon is beyond the 64-block firing range; move closer or wait for its next pass.";
        return null;
      }
      const trajectory = bowTrajectory(this.end.bot.entity.position.offset(0, observedEyeHeight(this.end.bot.entity) - 0.1, 0), target, velocity);
      if (!trajectory || !clearBowTrajectory(trajectory, (p, d, n) => bot.world.raycast(p, d, n))) {
        observation.blockedBy = "No clear intercept from this footing; wait for a pass or move to an exposed position.";
        return null;
      }
      if (!fitsDragonShot(trajectory.points.at(-1)!, target, velocity, previousVelocity,
          trajectory.flightTicks, observation.hitboxMargin)) {
        observation.blockedBy = "Dragon motion leaves the inset body estimates; holding the arrow for a steadier or closer pass.";
        return null;
      }
      const yaw = Math.atan2(-trajectory.velocity.x, -trajectory.velocity.z);
      const pitch = Math.atan2(trajectory.velocity.y, Math.hypot(trajectory.velocity.x, trajectory.velocity.z));
      if (endermanGazeRisk(bot, bot.entity.position, yaw, pitch)) {
        observation.blockedBy = "An Enderman obstructs the safe aim direction.";
        return null;
      }
      observation.blockedBy = null;
      return { trajectory, yaw, pitch };
    };
    const use = new CombatItemUse(bot, async ticks => { for (let i = 0; i < ticks; i++) await this.end.tick(signal); });
    try {
      for (;;) {
        signal.throwIfAborted();
        if (observation.died) return finish("dragon_died");
        if (!observation.loaded) return finish("stopped", "Selected dragon is no longer loaded in the original dimension; disappearance is not a kill.");
        // Reconcile a released arrow before checking equipment or firing again,
        // including when a hostile reflex consumed the whole observation window.
        if (observation.attacks > 0) {
          if (observation.damageObserved > 0) {
            this.end.execution.progress.confirmedHit(true);
            return finish("dragon_damaged", "Dragon health decreased after the shot; this observation does not identify damage from other players.");
          }
          if (observation.remainingFlightTicks <= 0)
            return finish("shot_missed", "No dragon health loss observed after the released arrow. Its turn, terrain or a perch transition may have prevented damage.");
        } else {
          const refusal = unavailable();
          if (refusal) return finish("weapon_unavailable", refusal);
          if (isDragonPerched(observation.nativePhase))
            return finish("stopped", "[DRAGON_PERCHED] A sitting dragon is immune to arrows. Use attack_dragon_perch or wait for takeoff.");
          if (observation.nativePhase === null || observation.nativePhase === 9)
            return finish("stopped", "Dragon flight is not available for a bow shot; inspect its phase again.");
          if (observation.aimingTicks >= 200)
            return finish("stopped", `[DRAGON_SHOT_BLOCKED] ${observation.blockedBy ?? "No safe flight shot opened within 200 aiming ticks."}`);
        }
        const response = decideEndResponse(this.end.policy().combat, this.end.danger, "bow");
        if (response.kind === "constrained") return finish("stopped", response.reason);
        if (response.kind === "evade") {
          const escaped = await this.end.evade(signal);
          if (escaped.outcome !== "evaded") return finish("stopped", escaped.reason);
          continue;
        }
        if (observation.attacks > 0) { await this.end.phase("observe_shot", () => this.end.tick(signal)); continue; }
        await this.end.settle(signal);
        if (!aim()) { observation.aimingTicks++; await this.end.tick(signal); continue; }
        await equipCombatLoadout(bot, selectRangedLoadout(permittedCombatItems(readCombatItems(bot), this.end.policy().combat))!);
        await this.end.phase("shoot", async () => {
          using draw = use.drawBow();
          // Re-aim throughout the charge; a flying dragon moves tens of blocks
          // during a full draw. Revalidate again at release, after the last tick.
          for (let tick = 0; tick <= 21; tick++) {
            if (!observation.loaded || observation.died || this.end.danger || this.end.footing.needed ||
                isDragonPerched(observation.nativePhase) || observation.nativePhase === 9 || unavailable()) return;
            const shot = aim();
            if (!shot) return;
            await bot.look(shot.yaw, shot.pitch, true);
            signal.throwIfAborted();
            if (!observation.loaded || observation.died || this.end.danger || this.end.footing.needed ||
                isDragonPerched(observation.nativePhase) || observation.nativePhase === null ||
                observation.nativePhase === 9 || unavailable()) return;
            if (tick === 21) { observation.released(shot.trajectory.flightTicks); draw.release(); return; }
            observation.aimingTicks++;
            await this.end.tick(signal);
          }
        });
      }
    } finally {
      await use.neutralise(async () => { if (!signal.aborted) await this.end.settle(signal); }, signal);
    }
  }
}
