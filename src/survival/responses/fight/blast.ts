import { Vec3 } from "vec3";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import { placeSolidBlockInto } from "../../../world/placement.js";
import { blastBarrierScope } from "../../control/combat/scopes/blast-barrier.js";
import { permittedCombatItems } from "../../policy/combat/permissions.js";
import { blastBarrierMaterial } from "../../positioning/combat/blast-barrier.js";
import { selectMeleeLoadout } from "../../weapons/equipment.js";
import { canMeleeTarget, combatItemsForTarget } from "../../weapons/melee.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

/** Short defensive effects under the existing fight owner. None settles the
 * quarry or clears the connection's outstanding blast observations. */
export class BlastDefence {
  constructor(readonly scene: FightScene, readonly weapons: FightWeapons) {}

  /** Also usable while the same owner recovers footing: looking and guarding
   * do not replace recovery's movement controls. */
  readonly protect = async (): Promise<void> => {
    const { scene, weapons } = this;
    const threats = scene.perception.creeperClearance.observe(scene.perception.tick, scene.perception.resolvedIds);
    const threat = [...threats].sort((a, b) => Number(b.swelling) - Number(a.swelling) || a.distance - b.distance)[0];
    const target = threat && scene.bot.entities[threat.id]?.isValid ? scene.bot.entities[threat.id]! : scene.target;
    const loadout = selectMeleeLoadout(permittedCombatItems(combatItemsForTarget(scene.bot, target), scene.policy.combat));
    await weapons.equip(loadout);
    if (threat) await scene.bot.lookAt(threat.position.offset(0, 1, 0), true);
    else await weapons.faceGuard();
    scene.signal.throwIfAborted();
    if (loadout.shield && !weapons.itemUse.shieldRaised) weapons.itemUse.activateShield();
  };

  async brace(): Promise<null> {
    await this.scene.execution.run("guard", async () => {
      await this.protect();
      await waitForPhysicsTicks(this.scene.bot, 1, this.scene.signal);
    });
    return null;
  }

  async counter(targetId: number): Promise<null> {
    const { scene, weapons } = this;
    await scene.execution.run("swing", async () => {
      const target = scene.bot.entities[targetId];
      if (!target?.isValid || !scene.policy.combat.melee || !canMeleeTarget(scene.bot, target)) return;
      const loadout = selectMeleeLoadout(permittedCombatItems(combatItemsForTarget(scene.bot, target), scene.policy.combat));
      await weapons.equip(loadout);
      if (scene.elapsedTicks < weapons.weaponReadyAt) { await this.protect(); return; }
      weapons.itemUse.lowerShield();
      await weapons.face(target);
      // Sprint adds knockback to a ready hit. Forward movement is not required
      // and could walk off the only supported cell or into the other fuse.
      scene.bot.setControlState("sprint", true);
      try {
        scene.signal.throwIfAborted();
        if (!canMeleeTarget(scene.bot, target)) return;
        scene.bot.attack(target);
        weapons.weaponReadyAt = scene.elapsedTicks + loadout.cooldownTicks;
        scene.attacks++;
        scene.stylesUsed.add("melee");
        scene.weaponsUsed.add(loadout.weapon?.name ?? "hand");
        scene.reportDecision({ kind: "response", evidence: { boundary: "blast_counter", targetId, requestedTargetId: scene.targetId } });
      } finally { scene.bot.setControlState("sprint", false); }
      await this.protect();
    });
    return null;
  }

  async barrier(at: { x: number; y: number; z: number }): Promise<null> {
    const { scene, weapons } = this;
    const cell = new Vec3(at.x, at.y, at.z);
    const scope = blastBarrierScope(scene.bot, cell, () => scene.policy.combat);
    await scene.execution.run("establish", async () => {
      try {
        const result = await placeSolidBlockInto(scene.bot, cell, blastBarrierMaterial(scene.bot), { signal: scene.signal });
        scene.signal.throwIfAborted();
        scene.reportDecision({ kind: "response", evidence: { boundary: "blast_barrier", cell: { ...at }, result: result.kind,
          ...(result.kind === "failed" && { why: result.error }) } });
        if (result.kind === "failed") scene.survival.answered.remember(scope, { kind: "placement_failed", why: result.error });
      } finally { weapons.itemUse.invalidateShield(); }
      await this.protect();
    });
    return null;
  }
}
