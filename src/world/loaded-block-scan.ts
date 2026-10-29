import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

interface LocalBlockPosition {
  x: number;
  y: number;
  z: number;
}

/** The narrow 1.21.4 Prismarine chunk surface used by the scanner. */
interface LoadedChunkSection {
  readonly solidBlockCount: number;
  readonly palette?: readonly number[];
  readonly data: { readonly value?: number };
  get(position: LocalBlockPosition): number;
}

interface LoadedChunkColumn {
  readonly minY: number;
  readonly sections: readonly (LoadedChunkSection | undefined)[];
}

interface LoadedColumn {
  readonly chunkX: number | string;
  readonly chunkZ: number | string;
  readonly column: LoadedChunkColumn;
}

export interface LoadedBlockScan {
  readonly center: { readonly x: number; readonly y: number; readonly z: number };
  /** Horizontal radius from the centre; omitted, every loaded column is searched. */
  readonly radius?: number;
  readonly stateIds: ReadonlySet<number>;
  readonly limit: number;
}

interface SearchSection {
  readonly section: LoadedChunkSection;
  readonly origin: LocalBlockPosition;
  readonly distanceSquared: number;
  /** Original column/section order preserves the old stable sort's distance ties. */
  readonly order: number;
}

interface Candidate extends LocalBlockPosition {
  readonly distanceSquared: number;
  readonly order: number;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  return left.distanceSquared - right.distanceSquared || left.order - right.order;
}

/** Minimum distance along one axis to any integer block coordinate in a section. */
function sectionAxisDistance(center: number, origin: number): number {
  return Math.max(origin - center, center - (origin + 15), 0);
}

function matchingSections(
  columns: readonly LoadedColumn[],
  center: LocalBlockPosition,
  radiusSquared: number,
  stateIds: ReadonlySet<number>,
): SearchSection[] {
  const sections: SearchSection[] = [];
  let order = 0;
  for (const loaded of columns) {
    const x = Number(loaded.chunkX) * 16;
    const z = Number(loaded.chunkZ) * 16;
    const dx = sectionAxisDistance(center.x, x);
    const dz = sectionAxisDistance(center.z, z);
    const horizontalDistanceSquared = dx * dx + dz * dz;
    for (let index = 0; index < loaded.column.sections.length; index += 1) {
      const sectionOrder = order++;
      const section = loaded.column.sections[index];
      if (!section || section.solidBlockCount === 0 || horizontalDistanceSquared > radiusSquared) continue;
      // SingleValueContainer has a value, but no palette. Direct containers
      // have neither, so only packed reads can establish whether they match.
      if (section.data.value !== undefined && !stateIds.has(section.data.value)) continue;
      if (section.palette && !section.palette.some((stateId) => stateIds.has(stateId))) continue;
      const y = loaded.column.minY + index * 16;
      const dy = sectionAxisDistance(center.y, y);
      sections.push({
        section,
        origin: { x, y, z },
        distanceSquared: horizontalDistanceSquared + dy * dy,
        order: sectionOrder,
      });
    }
  }
  return sections.sort((left, right) => left.distanceSquared - right.distanceSquared || left.order - right.order);
}

/** Insert an admitted candidate into the small nearest-first set. */
function retainCandidate(candidates: Candidate[], candidate: Candidate, limit: number): void {
  // Unlimited callers need every match: append and sort once, avoiding
  // quadratic insertion work while preserving their exact-count contract.
  if (limit === Number.POSITIVE_INFINITY) {
    candidates.push(candidate);
    return;
  }
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareCandidates(candidates[middle]!, candidate) <= 0) low = middle + 1;
    else high = middle;
  }
  candidates.splice(low, 0, candidate);
  if (candidates.length > limit) candidates.pop();
}

/**
 * Find matching blocks through the full height of Mineflayer's loaded columns,
 * inside one horizontal radius or across everything loaded, nearest first.
 *
 * `bot.blockAt` reconstructs a rich Prismarine Block with biome, light, block
 * entity, and collision data. Mineflayer's `findBlocks` does that for every
 * coordinate in a section that might contain a match. Mining needs none of
 * those facts until it has found a matching state, so this scan reads the
 * section's packed state IDs and leaves rich block construction to its caller.
 */
export function findLoadedBlockPositions(bot: Bot, scan: LoadedBlockScan): readonly Vec3[] {
  if (scan.limit === 0 || scan.stateIds.size === 0) return [];
  // prismarine-world's public type omits the 1.18+ column `minY`, while its
  // runtime column and serialized form both carry it. Parse that library gap
  // once here instead of spreading assertions through mining.
  const columns = bot.world.getColumns() as unknown as readonly LoadedColumn[];
  const center = new Vec3(scan.center.x, scan.center.y, scan.center.z).floored();
  const radiusSquared = scan.radius === undefined ? Number.POSITIVE_INFINITY : scan.radius * scan.radius;
  const candidates: Candidate[] = [];
  const local = { x: 0, y: 0, z: 0 };
  const sections = matchingSections(columns, center, radiusSquared, scan.stateIds);
  for (const { section, origin, distanceSquared: sectionDistance, order: sectionOrder } of sections) {
    // Equal-distance sections can still win the original traversal-order tie.
    if (candidates.length === scan.limit && sectionDistance > candidates[candidates.length - 1]!.distanceSquared) break;
    const singleValue = section.data.value;
    for (local.y = 0; local.y < 16; local.y += 1) {
      const y = origin.y + local.y;
      const dy = y - center.y;
      for (local.z = 0; local.z < 16; local.z += 1) {
        const z = origin.z + local.z;
        const dz = z - center.z;
        for (local.x = 0; local.x < 16; local.x += 1) {
          const x = origin.x + local.x;
          const dx = x - center.x;
          const horizontalDistanceSquared = dx * dx + dz * dz;
          if (horizontalDistanceSquared > radiusSquared) continue;
          const distanceSquared = horizontalDistanceSquared + dy * dy;
          const order = sectionOrder * 4096 + local.y * 256 + local.z * 16 + local.x;
          const worst = candidates[candidates.length - 1];
          if (candidates.length === scan.limit && worst &&
            (distanceSquared > worst.distanceSquared || (distanceSquared === worst.distanceSquared && order >= worst.order))) continue;
          if (singleValue === undefined && !scan.stateIds.has(section.get(local))) continue;
          retainCandidate(candidates, { x, y, z, distanceSquared, order }, scan.limit);
        }
      }
    }
  }
  if (scan.limit === Number.POSITIVE_INFINITY) candidates.sort(compareCandidates);
  return candidates.map(({ x, y, z }) => new Vec3(x, y, z));
}

/** One kind in a cooperative multi-kind scan, with every state its name selects. */
export interface LoadedBlockNameScanEntry {
  readonly name: string;
  readonly stateIds: ReadonlySet<number>;
}

export interface LoadedBlockNameScan {
  readonly center: { readonly x: number; readonly y: number; readonly z: number };
  /** Horizontal radius from the centre; omitted, every loaded column is searched. */
  readonly radius?: number;
  /** The kinds to count at once; when two names select one state, its cells count into both. */
  readonly names: readonly LoadedBlockNameScanEntry[];
  /** How many nearest positions to keep per name; the found count always covers everything loaded. */
  readonly limit: number;
}

export interface LoadedBlockNameMatches {
  readonly name: string;
  /** Matching blocks loaded, whatever the limit. */
  readonly found: number;
  /** The nearest matches, nearest first; at most the limit. */
  readonly positions: readonly Vec3[];
}

/**
 * Count every requested kind through the loaded columns in one cooperative pass.
 *
 * A view naming eight kinds would otherwise run the single-name scan eight times
 * over the same cells, and one of those passes blocks the event loop for seconds:
 * a runtime that is only reading its world looks exactly like a wedged one from
 * the heartbeat's side, and the supervisor kills it mid-read. Here every cell is
 * read once and filed into each name that wants its state, lists stay bounded
 * while counts stay whole, and between loaded sections the pass hands the event
 * loop back, the same truce the crystal and frontier searches keep with it.
 */
export async function findLoadedBlocksByName(
  bot: Bot,
  scan: LoadedBlockNameScan,
): Promise<readonly LoadedBlockNameMatches[]> {
  const zero = (): LoadedBlockNameMatches[] => scan.names.map(({ name }) => ({ name, found: 0, positions: [] }));
  if (scan.limit === 0) return zero();
  // prismarine-world's public type omits the 1.18+ column `minY`, as in the
  // single-name scan above; parse the library gap once, here, too.
  const columns = bot.world.getColumns() as unknown as readonly LoadedColumn[];
  const center = new Vec3(scan.center.x, scan.center.y, scan.center.z).floored();
  const radiusSquared = scan.radius === undefined ? Number.POSITIVE_INFINITY : scan.radius * scan.radius;
  // One read of a cell's state can answer for every name that wants it, so
  // states map straight onto the buckets of names that share them.
  const wantedStateIds = new Set<number>();
  const stateBuckets = new Map<number, number[]>();
  scan.names.forEach(({ stateIds }, bucket) => {
    for (const stateId of stateIds) {
      const sharing = stateBuckets.get(stateId);
      if (sharing) sharing.push(bucket);
      else {
        stateBuckets.set(stateId, [bucket]);
        wantedStateIds.add(stateId);
      }
    }
  });
  if (wantedStateIds.size === 0) return zero();
  const buckets = scan.names.map(() => ({ found: 0, candidates: [] as Candidate[] }));
  const local = { x: 0, y: 0, z: 0 };
  let deadline = performance.now() + 8;
  const sections = matchingSections(columns, center, radiusSquared, wantedStateIds);
  for (const { section, origin, order: sectionOrder } of sections) {
    // The palette filter admits a single-value section only when that one
    // state is wanted, so its cells answer from the map without unpacking.
    const singleValue = section.data.value;
    const sharedWanted = singleValue === undefined ? undefined : stateBuckets.get(singleValue);
    for (local.y = 0; local.y < 16; local.y += 1) {
      const y = origin.y + local.y;
      const dy = y - center.y;
      for (local.z = 0; local.z < 16; local.z += 1) {
        const z = origin.z + local.z;
        const dz = z - center.z;
        for (local.x = 0; local.x < 16; local.x += 1) {
          const x = origin.x + local.x;
          const dx = x - center.x;
          const horizontalDistanceSquared = dx * dx + dz * dz;
          if (horizontalDistanceSquared > radiusSquared) continue;
          const distanceSquared = horizontalDistanceSquared + dy * dy;
          // Same traversal-order tiebreak as the single-name scan, so a name
          // reported by both scans lists the same nearest cells in one order.
          const order = sectionOrder * 4096 + local.y * 256 + local.z * 16 + local.x;
          const wanted = sharedWanted ?? stateBuckets.get(section.get(local));
          if (wanted === undefined) continue;
          for (const bucket of wanted) {
            const matching = buckets[bucket]!;
            matching.found += 1;
            const worst = matching.candidates[matching.candidates.length - 1];
            if (
              matching.candidates.length < scan.limit ||
              !worst ||
              distanceSquared < worst.distanceSquared ||
              (distanceSquared === worst.distanceSquared && order < worst.order)
            )
              retainCandidate(matching.candidates, { x, y, z, distanceSquared, order }, scan.limit);
          }
        }
      }
    }
    // A section is a bounded piece of work; between sections the loop may turn,
    // so heartbeats, Minecraft packets and cancellation run however wide a view.
    if (performance.now() >= deadline) {
      await yieldToEventLoop();
      deadline = performance.now() + 8;
    }
  }
  return scan.names.map(({ name }, bucket) => ({
    name,
    found: buckets[bucket]!.found,
    positions: buckets[bucket]!.candidates.map(({ x, y, z }) => new Vec3(x, y, z)),
  }));
}
