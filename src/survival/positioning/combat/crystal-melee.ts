import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { customGoal, HORIZONTAL_TICKS_PER_BLOCK, type Goal } from "../../../navigation/index.js";
import { observedEyeHeight } from "../../../world/block-visibility.js";

/** A native crystal sits on the top face of a bedrock block. Every blast ray
 * descending from that point enters the pedestal immediately. Keeping the
 * entire standing body below that face shields it and its lower scaffolds.
 * Require this observed geometry; an arbitrary floating crystal is not safe. */
export function crystalBlastCovered(bot: Bot, crystal: Vec3, feet: Vec3): boolean {
  return crystalBlastCoverCell(bot, crystal, feet) !== null;
}

/** Return the observed block that physically provides blast cover. */
export function crystalBlastCoverCell(bot: Bot, crystal: Vec3, feet: Vec3): Vec3 | null {
  const pedestal = bot.blockAt(crystal.offset(0, -0.01, 0));
  return (
    pedestal !== null &&
    (pedestal.name === "bedrock" || pedestal.name === "obsidian") &&
    crystal.y === pedestal.position.y + 1 &&
    crystal.x > pedestal.position.x &&
    crystal.x < pedestal.position.x + 1 &&
    crystal.z > pedestal.position.z &&
    crystal.z < pedestal.position.z + 1 &&
    feet.y + 1.8 < crystal.y
  ) ? pedestal.position.clone() : null;
}

/** A crystal explosion has power six; its damage reaches twelve blocks. */
const CRYSTAL_BLAST_POWER = 6;
const PLAYER_WIDTH = 0.6, PLAYER_HEIGHT = 1.8;

export interface CrystalBlastEstimate {
  /** The whole body sits below the pedestal's top face; no ray reaches it. */
  readonly covered: boolean;
  /** Fraction of the native body-sample rays the blast reaches. */
  readonly exposure: number;
  /** Explosion damage before armor, as the server would compute it. */
  readonly rawDamage: number;
  /** Damage after worn armor points and toughness; enchantments are not credited. A live
   * top-stance swing lost 5.7 against an estimate of 5.3, so treat this as close, not safe. */
  readonly damage: number;
}

/**
 * What the crystal's explosion would do to a body standing at `feet`.
 *
 * Standing on top of the tower is not the same as standing in the blast: the
 * pedestal still blocks every ray to the part of the body below its top face,
 * so an armored bot on the rim takes a survivable hit while an unarmored one
 * may not. Reproduce the server's own arithmetic rather than guess: its body
 * sample grid, its distance falloff over twice the power, and its armor
 * formula. Enchantments are deliberately left out; the caller adds its own margin.
 */
export function crystalBlastEstimate(bot: Bot, crystal: Vec3, feet: Vec3): CrystalBlastEstimate {
  if (crystalBlastCovered(bot, crystal, feet)) return { covered: true, exposure: 0, rawDamage: 1, damage: 1 };
  const step = (size: number) => 1 / (size * 2 + 1);
  const horizontalStep = step(PLAYER_WIDTH), verticalStep = step(PLAYER_HEIGHT);
  const offset = (1 - Math.floor(1 / horizontalStep) * horizontalStep) / 2;
  let clear = 0, total = 0;
  for (let a = 0; a <= 1; a += horizontalStep)
    for (let b = 0; b <= 1; b += verticalStep)
      for (let c = 0; c <= 1; c += horizontalStep) {
        const from = feet.offset(-PLAYER_WIDTH / 2 + a * PLAYER_WIDTH + offset, b * PLAYER_HEIGHT, -PLAYER_WIDTH / 2 + c * PLAYER_WIDTH + offset);
        const delta = crystal.minus(from), distance = delta.norm();
        // The blast centre lies exactly on the pedestal's top face. Stop a hair
        // short of it so a ray that never enters the pedestal is not charged
        // for touching its surface, which is how the server treats it too.
        if (distance < 0.02 || !bot.world.raycast(from, delta.scaled(1 / distance), distance - 0.01)) clear++;
        total++;
      }
  const exposure = total === 0 ? 1 : clear / total;
  const distance = feet.distanceTo(crystal) / (CRYSTAL_BLAST_POWER * 2);
  const impact = Math.max(0, 1 - distance) * exposure;
  const rawDamage = Math.floor(((impact * impact + impact) / 2) * 7 * (CRYSTAL_BLAST_POWER * 2) + 1);
  return { covered: false, exposure, rawDamage, damage: afterArmor(bot, rawDamage) };
}

const ARMOR: Record<string, readonly [points: number, toughness: number]> = {
  leather_helmet: [1, 0], golden_helmet: [2, 0], chainmail_helmet: [2, 0], iron_helmet: [2, 0], turtle_helmet: [2, 0],
  diamond_helmet: [3, 2], netherite_helmet: [3, 3],
  leather_chestplate: [3, 0], golden_chestplate: [5, 0], chainmail_chestplate: [5, 0], iron_chestplate: [6, 0],
  diamond_chestplate: [8, 2], netherite_chestplate: [8, 3],
  leather_leggings: [2, 0], golden_leggings: [3, 0], chainmail_leggings: [4, 0], iron_leggings: [5, 0],
  diamond_leggings: [6, 2], netherite_leggings: [6, 3],
  leather_boots: [1, 0], golden_boots: [1, 0], chainmail_boots: [1, 0], iron_boots: [2, 0],
  diamond_boots: [3, 2], netherite_boots: [3, 3],
};
const ARMOR_SLOTS = [5, 6, 7, 8];

/** The server's armor formula over the worn pieces' base points and toughness. */
function afterArmor(bot: Bot, damage: number): number {
  let points = 0, toughness = 0;
  for (const slot of ARMOR_SLOTS) {
    const worn = ARMOR[bot.inventory.slots[slot]?.name ?? ""];
    if (!worn) continue;
    points += worn[0];
    toughness += worn[1];
  }
  const reduction = Math.min(20, Math.max(points / 5, points - damage / (2 + toughness / 4)));
  return damage * (1 - reduction / 25);
}

/** Aim at the near face within ordinary three-block reach after navigation
 * has cleared the standing space. A remaining obstruction is not a legal hit. */
export function crystalMeleeAim(bot: Bot, crystal: Vec3): Vec3 | null {
  return crystalMeleeAimFrom(bot, crystal, bot.entity.position.offset(0, observedEyeHeight(bot.entity), 0));
}

/** The same legal hit judged for a hypothetical eye, for choosing a stance before walking to it. */
export function crystalMeleeAimFrom(bot: Bot, crystal: Vec3, eye: Vec3): Vec3 | null {
  for (const aim of crystalMeleeAimPoints(crystal, eye)) {
    const delta = aim.minus(eye), distance = delta.norm();
    if (!bot.world.raycast(eye, delta.scaled(1 / distance), distance)) return aim;
  }
  return null;
}

/** Whether any aim point is within reach at all, before line of sight is known. */
export function crystalMeleeReach(crystal: Vec3, eye: Vec3): boolean {
  return crystalMeleeAimPoints(crystal, eye).length > 0;
}

function crystalMeleeAimPoints(crystal: Vec3, eye: Vec3): Vec3[] {
  const x = Math.max(crystal.x - 0.95, Math.min(eye.x, crystal.x + 0.95));
  const z = Math.max(crystal.z - 0.95, Math.min(eye.z, crystal.z + 0.95));
  return [0.2, 0.5, 0.9, 1.4, 1.9]
    .map((height) => new Vec3(x, crystal.y + height, z))
    .filter((aim) => aim.distanceTo(eye) <= 3);
}

/** How far from the start the melee return may settle; any supported cell this close is off the tower. */
export const CRYSTAL_RETURN_RANGE = 4;

/**
 * Back on the ground near where the climb began. The staircase's own lower
 * treads and the island around the tower base all count; the one cell the
 * bot happened to start from does not deserve a failed result when the ground
 * two blocks over is just as good.
 */
export function crystalReturnGoal(start: Vec3): Goal {
  const origin = start.floored();
  const horizontal = (feet: { x: number; z: number }) => Math.sqrt((feet.x - origin.x) ** 2 + (feet.z - origin.z) ** 2);
  return customGoal(
    `crystal-return:${origin.x},${origin.y},${origin.z}:${CRYSTAL_RETURN_RANGE}`,
    (node) => horizontal(node.feet) <= CRYSTAL_RETURN_RANGE && node.feet.y <= origin.y + 1 && node.feet.y >= origin.y - 3,
    (node) =>
      (Math.max(0, horizontal(node.feet) - CRYSTAL_RETURN_RANGE) + Math.max(0, node.feet.y - origin.y - 1)) *
      HORIZONTAL_TICKS_PER_BLOCK,
  );
}
