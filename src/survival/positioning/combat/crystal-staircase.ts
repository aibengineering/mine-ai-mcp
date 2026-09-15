import { crystalBlastCovered, crystalMeleeAimFrom, crystalMeleeReach } from "./crystal-melee.js";
import { STANDING_EYE_HEIGHT } from "../../../world/block-visibility.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { type BuildCell, build } from "../../../navigation/processes/building/build-process.js";
import { createMovements, type NavigationRuntime } from "../../../navigation/index.js";
import { observeMineflayerBlock } from "../../../navigation/mineflayer/world.js";
import { DIG_REACH } from "../../../navigation/movements/excavation.js";
import { visibleBlockAim } from "../../../world/block-visibility.js";
import { placeBlock } from "../../../world/index.js";
import type { SurvivalPolicy } from "../../policy/contract.js";

export interface CrystalStaircase {
  readonly cells: readonly BuildCell[];
  /** Feet cell of the swing: on the covered rim below the pedestal when reach allows, else on top of the tower. */
  readonly stance: Vec3;
  /** Whether the stance keeps the whole body under the pedestal's top face. */
  readonly covered: boolean;
  readonly pedestal: Vec3;
  /** The tower's top layers; routes to and from the stance must not mine them. */
  readonly tower: readonly Vec3[];
  /** Scaffold blocks a straight pillar from the island to the stance needs, for the alternative approach. */
  readonly pillarBlocks: number;
}

/** Fixed clockwise square spiral ending at the north-east attack corner.
 * Treads attach directly to obsidian; only gaps around the tower's round
 * corners need a lower support beside the preceding tread.
 *
 * The tower itself is never excavated. Narrow towers offer a covered stance on
 * the rim, one block below the pedestal's top face, within melee reach. Wider
 * ones put that rim out of reach, and the answer is to step onto the top layer
 * and swing from the disc cell farthest from the crystal that still reaches
 * it: the pedestal shields the lower body there, so the hit is survivable in
 * armor, and mining minutes of obsidian for full cover is not worth it. */
export function planCrystalStaircase(bot: Bot, crystal: Vec3): CrystalStaircase {
  const center = crystal.floored(), top = center.y - 2;
  if (!crystalBlastCovered(bot, crystal, center.offset(2, -2, -2)))
    throw new Error("[CRYSTAL_BLAST_COVER_UNAVAILABLE] The crystal needs an intact native pedestal before building an approach.");
  let radius = 0;
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) {
    const block = bot.blockAt(center.offset(x, -4, z));
    if (!block) throw new Error("[CRYSTAL_TOWER_UNLOADED] Load the tower before planning its staircase.");
    if (block.name === "obsidian") radius = Math.max(radius, Math.abs(x), Math.abs(z));
  }
  if (radius < 1 || radius > 5) throw new Error("[CRYSTAL_TOWER_UNSUPPORTED] Expected an observed native obsidian tower.");
  const edge = radius + 1;
  // Survey outside the staircase footprint; completed treads cannot raise the
  // next request's ground estimate and change the spiral's orientation.
  let ground: number | undefined;
  for (let y = top; y >= 1; y--) {
    const block = bot.blockAt(new Vec3(center.x, y, center.z - edge - 3));
    if (!block) throw new Error("[CRYSTAL_TOWER_UNLOADED] Load the island below the tower.");
    if (block.boundingBox === "block") { ground = y; break; }
  }
  if (ground === undefined || ground + 1 >= top) throw new Error("[CRYSTAL_TOWER_UNSUPPORTED] No lower island surface was observed for the staircase.");
  const ring: Vec3[] = [];
  for (let x = -edge; x < edge; x++) ring.push(new Vec3(x, 0, -edge));
  for (let z = -edge; z < edge; z++) ring.push(new Vec3(edge, 0, z));
  for (let x = edge; x > -edge; x--) ring.push(new Vec3(x, 0, edge));
  for (let z = edge; z > -edge; z--) ring.push(new Vec3(-edge, 0, z));
  const rise = top - ground - 1, end = edge + 2;
  const path: Vec3[] = [];
  for (let i = 0; i <= rise; i++) {
    const point = ring[((end - rise + i) % ring.length + ring.length) % ring.length]!;
    path.push(new Vec3(center.x + point.x, ground + 1 + i, center.z + point.z));
  }
  // Walk the attack column inward only while the top layer leaves it open.
  for (let z = -edge + 1; z <= -2; z++) {
    const cell = new Vec3(center.x + 2, top, center.z + z);
    const block = bot.blockAt(cell);
    if (!block) throw new Error("[CRYSTAL_TOWER_UNLOADED] Load the tower before planning its staircase.");
    if (block.name === "obsidian" && block.boundingBox === "block") break;
    path.push(cell);
  }
  const rim = path.at(-1)!;
  const eyeAt = (feet: Vec3) => feet.offset(0.5, STANDING_EYE_HEIGHT, 0.5);
  const covered = crystalBlastCovered(bot, crystal, rim.offset(0.5, 0, 0.5)) && crystalMeleeReach(crystal, eyeAt(rim));
  const stance = covered ? rim : topStance(bot, crystal, center, radius, rim, eyeAt);
  if (!stance) throw new Error("[CRYSTAL_STANCE_UNAVAILABLE] Neither the covered rim nor the tower top offers a clear melee hit within reach without mining the tower.");
  const tower: Vec3[] = [];
  for (let x = -6; x <= 6; x++) for (let z = -6; z <= 6; z++) for (const y of [-3, -2]) {
    const position = center.offset(x, y, z);
    if (bot.blockAt(position)?.name === "obsidian") tower.push(position);
  }
  const floors = new Map<string, Vec3>();
  for (let i = 0; i < path.length; i++) {
    const feet = path[i]!;
    const floor = feet.offset(0, -1, 0);
    floors.set(floor.toString(), floor);
    // Use the native wall, not previously built treads, so retrying produces
    // the same support layout even after partial construction.
    const wallFace = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([x, z]) => {
      const block = bot.blockAt(floor.offset(x!, 0, z!));
      return block?.name === "obsidian" && block.boundingBox === "block";
    });
    if (i > 0 && feet.y > path[i - 1]!.y && !wallFace) {
      const support = feet.offset(0, -2, 0);
      floors.set(support.toString(), support);
    }
  }
  // Anchor the first tread to observed terrain if this side is lower than the survey.
  const first = path[0]!;
  for (let depth = 1; depth <= 32; depth++) {
    const position = first.offset(0, -depth, 0), block = bot.blockAt(position);
    if (!block) throw new Error("[CRYSTAL_TOWER_UNLOADED] Staircase footing is not loaded.");
    if (block.boundingBox === "block") break;
    if (depth === 32) throw new Error("[CRYSTAL_TOWER_UNSUPPORTED] Staircase has no nearby island footing.");
    floors.set(position.toString(), position);
  }
  const cells = new Map<string, BuildCell>();
  for (const position of floors.values()) {
    const existing = bot.blockAt(position);
    cells.set(position.toString(), { position, blockName: existing?.boundingBox === "block" ? existing.name : "end_stone" });
  }
  for (const feet of path) for (const position of [feet, feet.offset(0, 1, 0)]) {
    if (floors.has(position.toString())) throw new Error("Staircase clearance overlaps a tread");
    cells.set(position.toString(), { position, blockName: "air" });
  }
  // The feet/head clearance above opens the attack corner. Keep the rest of
  // the cage intact; the attack checks actual reach and line of sight.
  const pedestal = center.offset(0, -1, 0);
  cells.set(pedestal.toString(), { position: pedestal, blockName: bot.blockAt(pedestal)!.name });
  return { cells: [...cells.values()], stance, covered, pedestal, tower, pillarBlocks: rise };
}

/** Carried blocks from the policy's scaffold list against what a pillar to the stance needs. */
export function pillarShortfall(bot: Bot, policy: Readonly<SurvivalPolicy>, plan: CrystalStaircase): string | null {
  if (!policy.combat.terrain.place)
    return "[CRYSTAL_PILLAR_CONSTRAINED] The pillar approach places scaffold blocks, which the survival policy's combat.terrain.place prohibits.";
  const names = policy.navigation.scaffold_blocks;
  const carried = bot.inventory.items().filter(item => names.includes(item.name)).reduce((sum, item) => sum + item.count, 0);
  return carried >= plan.pillarBlocks
    ? null
    : `[CRYSTAL_PILLAR_SHORTFALL] Tower at ${plan.pedestal}: about ${plan.pillarBlocks} scaffold blocks (${names.join(", ")}) are needed to pillar to the stance; carrying ${carried}. Gather at least ${plan.pillarBlocks - carried} more, or use approach "staircase".`;
}

/** The top-layer cell farthest from the crystal with a clear hit in reach, nearest the rim path on ties. */
function topStance(bot: Bot, crystal: Vec3, center: Vec3, radius: number, rim: Vec3, eyeAt: (feet: Vec3) => Vec3): Vec3 | null {
  let best: { cell: Vec3; distance: number; walk: number } | null = null;
  for (let x = -radius; x <= radius; x++) for (let z = -radius; z <= radius; z++) {
    // Guarded towers wrap their crystal in bars two cells out; a stance inside
    // that ring could only be reached through them.
    if (Math.max(Math.abs(x), Math.abs(z)) < 3) continue;
    const cell = center.offset(x, -1, z);
    if (bot.blockAt(cell.offset(0, -1, 0))?.name !== "obsidian") continue;
    if ([cell, cell.offset(0, 1, 0)].some(space => bot.blockAt(space)?.boundingBox !== "empty")) continue;
    if (!crystalMeleeAimFrom(bot, crystal, eyeAt(cell))) continue;
    const distance = Math.hypot(x, z), walk = cell.distanceTo(rim);
    if (!best || distance > best.distance || (distance === best.distance && walk < best.walk)) best = { cell, distance, walk };
  }
  return best?.cell ?? null;
}

export function staircaseShortfall(bot: Bot, plan: CrystalStaircase): string | null {
  const needed = new Map<string, number>();
  for (const cell of plan.cells) {
    if (cell.blockName !== "air" && bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name !== cell.blockName)
      needed.set(cell.blockName, (needed.get(cell.blockName) ?? 0) + 1);
  }
  for (const [name, count] of needed) {
    const carried = bot.inventory.items().filter(item => item.name === name).reduce((sum, item) => sum + item.count, 0);
    if (carried < count) return `[CRYSTAL_STAIRCASE_SHORTFALL] Tower at ${plan.pedestal}: ${count} ${name} blocks still needed; carrying ${carried}. Gather at least ${count - carried} more ${name} and retry this crystal. Existing staircase blocks will be reused. Alternatively, approach "pillar" scaffolds straight up beside the tower with about ${plan.pillarBlocks} carried scaffold blocks.`;
  }
  return null;
}

/** Same re-auditing builder as build_structure, under the combat body's owner. */
export async function buildCrystalStaircase(bot: Bot, navigation: NavigationRuntime,
  policy: Readonly<SurvivalPolicy>, plan: CrystalStaircase, signal: AbortSignal): Promise<string | null> {
  const needsBlocks = plan.cells.some(cell => cell.blockName !== "air" &&
    bot.blockAt(new Vec3(cell.position.x, cell.position.y, cell.position.z))?.name !== cell.blockName);
  if (needsBlocks && (!policy.combat.terrain.place || !policy.navigation.scaffold_blocks.includes("end_stone")))
    return "[CRYSTAL_STAIRCASE_CONSTRAINED] Building this reusable staircase requires end_stone placement permitted by the survival policy.";
  const shortfall = staircaseShortfall(bot, plan);
  if (shortfall) return shortfall;
  const result = await build(bot, {
    cells: plan.cells, removeWrongBlocks: policy.combat.terrain.dig,
    movements: protectedCells => createMovements(bot, {
      allowDigging: policy.combat.terrain.dig, scaffolding: false,
      // Keep the builder's live set: copying it would let later routes mine newly placed treads.
      protectedCells,
    }),
    route: navigation.navigate, breakInPlace: navigation.breakBlockInPlace,
    canSeeDig: (target, standing) => {
      const block = bot.blockAt(new Vec3(target.x, target.y, target.z));
      return block !== null && visibleBlockAim(bot.world, { x: standing.x, y: standing.y + 1.62, z: standing.z },
        target, DIG_REACH, observeMineflayerBlock(block).collisionShapes) !== null;
    },
    place: placement => placeBlock(bot, placement), signal,
  });
  if (result.status === "complete") return null;
  const left = result.cells.filter(cell => cell.state.kind !== "correct");
  const first = left[0];
  // Name the first wrong cell's own reason: "refused" alone sent a live run's
  // caller back to retry blind.
  const why = first
    ? `${first.state.kind} at ${JSON.stringify(first.cell.position)}${"reason" in first.state && first.state.reason ? `: ${first.state.reason}` : ""}`
    : "build stopped";
  return staircaseShortfall(bot, plan) ?? `[CRYSTAL_STAIRCASE_INCOMPLETE] ${left.length} cells remain; ${result.reason ?? why}. Retry this crystal to repair and reuse the same staircase.`;
}
