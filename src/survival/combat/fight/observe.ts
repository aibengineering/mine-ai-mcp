import { z } from "zod";
import { dragonDanger } from "../../../world/dragon-hazards.js";
import { isThreat } from "../../perception/combat/threats.js";
import { canMeleeTarget } from "../../weapons/melee.js";
import { confirmShieldBlock } from "../../weapons/shield-facing.js";
import type { CoverFight } from "./cover.js";
import type { EndermanFight } from "./enderman.js";
export const targetDamageSchema = z.object({ entityId: z.number(), sourceCauseId: z.number() });

import type { FightMovement } from "./movement.js";
import type { FightScene } from "./scene.js";
import type { FightWeapons } from "./weapons.js";

/** Packet and movement evidence stays active until this fight finishes releasing the body. */
export function observeFight(
  scene: FightScene,
  weapons: FightWeapons,
  locomotion: FightMovement,
  cover: CoverFight,
  roof: EndermanFight,
): { stopEffects(): void; close(): void } {
  let effectsActive = true;
  const onStatus = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId === scene.bot.entity.id && packet.entityStatus === 29) confirmShieldBlock(scene.bot);
  };
  const onDeath = (entity) => {
    scene.dead.add(entity.id);
    if (entity.id === scene.targetId && scene.observed === null) scene.observed = "died";
  };
  const onGone = (entity) => {
    if (entity.id === scene.targetId && scene.observed === null) scene.observed = "target_lost";
  };
  const onBotDeath = () => {
    if (scene.observed === null) scene.observed = "bot_died";
  };
  const onSwing = (entity) => {
    if (entity.id === scene.targetId && weapons.itemUse.shieldRaised) scene.shieldRaisedSwings += 1;
  };
  const onExplosion = () => {
    scene.explosions += 1;
  };
  const observeBody = () => {
    scene.tactics.observe(scene, weapons);
    scene.observeBoundary();
    if (dragonDanger(scene.bot)) scene.dragonDefense.abort("Dragon hazard requires immediate evasion.");
    scene.elapsedTicks++;
    scene.execution.tick();
    if (canMeleeTarget(scene.bot, scene.target))
      scene.execution.progress.milestone("attack_position", String(scene.target.id));
    const change = scene.execution.progress.observe(scene.bot.health);
    if (change) scene.reportProgress(change);
    if (scene.position.plan) scene.protectedProgress.tick(cover.recovering);
    weapons.observeVolley();
    locomotion.observeFooting();
    if (effectsActive) weapons.aimGuardBeforeMovement();
  };
  const onTargetDamage = (packet: unknown) => {
    const parsed = targetDamageSchema.safeParse(packet);
    if (!parsed.success || parsed.data.sourceCauseId !== scene.bot.entity.id + 1) return;
    const hit = parsed.data.entityId;
    const entity = scene.bot.entities[hit];
    if (hit !== scene.targetId && (!entity || !isThreat(scene.bot, entity, scene.perception))) return;
    scene.execution.progress.confirmedHit(hit === scene.targetId);
    if (hit === scene.targetId) {
      scene.protectedProgress.confirmedTargetDamage();
      roof.confirmedHit();
    }
  };
  const stopNavigation = scene.navigation.onEvent((event) => {
    if (event.kind === "step_completed")
      scene.execution.progress.milestone("route_step", scene.bot.entity.position.floored().toString());
  });
  scene.bot.on("physicsTick", observeBody);
  scene.bot.on("health", scene.observeBoundary);
  scene.bot.on("entityDead", onDeath);
  scene.bot.on("entityGone", onGone);
  scene.bot.on("death", onBotDeath);
  scene.bot.on("entitySwingArm", onSwing);
  scene.bot._client.on("explosion", onExplosion);
  scene.bot._client.on("damage_event", onTargetDamage);
  scene.bot._client.on("entity_status", onStatus);
  return {
    stopEffects() {
      effectsActive = false;
      scene.bot.off("health", scene.observeBoundary);
      scene.bot.off("entityDead", onDeath);
      scene.bot.off("entityGone", onGone);
      scene.bot.off("death", onBotDeath);
      scene.bot.off("entitySwingArm", onSwing);
      scene.bot._client.off("explosion", onExplosion);
      scene.bot._client.off("damage_event", onTargetDamage);
      scene.bot._client.off("entity_status", onStatus);
      stopNavigation();
    },
    close() {
      scene.bot.off("physicsTick", observeBody);
      locomotion.footing.release();
    },
  };
}
