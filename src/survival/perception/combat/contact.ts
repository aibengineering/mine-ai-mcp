import type { Bot } from "mineflayer";
import { MELEE_RANGE } from "../../weapons/equipment.js";
import { meleeDistance, waitingForDescendingCube } from "../../weapons/melee.js";
import { meleeImminent } from "./observations.js";

type Entity = Parameters<Bot["attack"]>[0];

/** These attacks need the controller's ranged, dive, teleport or fuse mechanics. */
const SPECIAL_ATTACKS = new Set([
  "skeleton",
  "stray",
  "bogged",
  "pillager",
  "blaze",
  "ghast",
  "witch",
  "guardian",
  "elder_guardian",
  "shulker",
  "evoker",
  "ender_dragon",
  "wither",
  "creeper",
  "phantom",
  "vex",
  "enderman",
]);

/** Ordinary melee mobs must come into reach to interrupt a journey; an explicit hunt still pursues them. */
export function defendsOnContact(entity: Entity): boolean {
  return (
    !SPECIAL_ATTACKS.has(entity.name ?? "") && entity.heldItem?.name !== "bow" && entity.heldItem?.name !== "crossbow"
  );
}

export function inDefensiveContact(bot: Bot, entity: Entity): boolean {
  // A jumping attacker has not left contact just because it is above swing
  // reach. Reuse the controller's airborne test: handing a journey the body
  // under that cube let it jump before the descending hit. Supported mobs on
  // another ledge still do not acquire an indefinite warning-margin hold.
  // Reach alone admits the fight too late for its guard: an attacker and a
  // bot walking into it close the last block and a half to the swing in
  // fewer ticks than a raised shield takes to block. Imminence carries that
  // allowance, so the guard is up when the first swing lands.
  return meleeDistance(bot, entity) <= MELEE_RANGE || waitingForDescendingCube(bot, entity) || meleeImminent(bot, entity);
}
