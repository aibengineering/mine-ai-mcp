import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import type { CombatOutcome } from "../../control/combat/contract.js";
import { type CombatLoadout } from "../../weapons/equipment.js";
import type { CoverFight } from "./cover.js";
import type { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

/** One ranged attack turn, including the observed limits that require repositioning. */
export async function runRangedTurn(
  scene: FightScene,
  weapons: FightWeapons,
  locomotion: FightMovement,
  cover: CoverFight,
  loadout: Extract<CombatLoadout, { kind: "bow" }>,
): Promise<CombatOutcome | null> {
  const shot = await weapons.shoot(loadout.shield);
  if (shot === "windup_limit") {
    if (scene.movement === "pursue" && scene.position.canEstablish) {
      const established = await locomotion.positionEffect(cover.establishCover);
      if (established.kind === "interrupted") return null;
      const stopped = established.value;
      if (!stopped || (stopped.kind === "unreachable" && scene.position.canEstablish)) return null;
    }
    return scene.guardLimit();
  }
  if (shot === "obstructed") {
    if (scene.movement === "hold") {
      // The caller chose this position and owns any screen blocking
      // it. Return that observed limit so it can change the position;
      // waiting here forever prevents that caller from acting.
      return {
        ...scene.result("unreachable"),
        observation: "Bow trajectory is obstructed from the held position.",
      };
    }
    if (scene.position.plan) {
      if (loadout.shield) await weapons.raiseGuard();
      await scene.execution.run("hold", () => weapons.holdFacing(1));
      return null;
    }
    const stopped = await locomotion.approach(false, null);
    if (stopped && !scene.settled()) {
      return { ...scene.result("unreachable"), observation: `Combat approach stopped: ${stopped}.` };
    }
    await waitForPhysicsTicks(scene.bot, 1, scene.signal);
  }
  return null;
}
