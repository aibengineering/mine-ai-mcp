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

/** Recent horizontal positions of each observed attacker, newest last. */
const tracks = new WeakMap<object, { readonly x: number; readonly z: number; readonly at: number }[]>();
/** How far back the attacker's own movement is judged. */
const CLOSING_WINDOW_MS = 500;
/** Movement smaller than this is a mob shuffling in place, not closing. */
const CLOSING_BLOCKS = 0.1;

/**
 * The attacker itself has moved toward the bot within the last half second.
 * Distances are both taken from where the bot stands now, so the bot's own
 * walk does not count: a pinned zombie in a lane is approached, not closing.
 */
function closing(bot: Bot, entity: Entity, now: number): boolean {
  const track = tracks.get(entity) ?? [];
  track.push({ x: entity.position.x, z: entity.position.z, at: now });
  while (track.length > 1 && now - track[0]!.at > CLOSING_WINDOW_MS) track.shift();
  tracks.set(entity, track);
  const { x, z } = bot.entity.position;
  const first = track[0]!;
  return (
    Math.hypot(first.x - x, first.z - z) - Math.hypot(entity.position.x - x, entity.position.z - z) > CLOSING_BLOCKS
  );
}

export function inDefensiveContact(bot: Bot, entity: Entity, now = performance.now()): boolean {
  // A jumping attacker has not left contact just because it is above swing
  // reach. Reuse the controller's airborne test: handing a journey the body
  // under that cube let it jump before the descending hit. Supported mobs on
  // another ledge still do not acquire an indefinite warning-margin hold.
  // Reach alone admits the fight too late for its guard: an attacker and a
  // bot walking into it close the last block and a half to the swing in
  // fewer ticks than a raised shield takes to block. Imminence carries that
  // allowance, so the guard is up when the first swing lands. It is an
  // allowance for an attacker that is coming: a pinned zombie in a lane held
  // a fight at 4.8 blocks waiting for a swing that could never come
  // (navigation-handoff Lane, hunts-regress 2026-10-20T22-26-37-009Z-t00001).
  const tracked = closing(bot, entity, now);
  return (
    meleeDistance(bot, entity) <= MELEE_RANGE ||
    waitingForDescendingCube(bot, entity) ||
    (tracked && meleeImminent(bot, entity))
  );
}
