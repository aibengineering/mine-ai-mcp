import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { findFlatPlacementCandidates, placeBlock, supportsFlatPlacement, type WorldBlock } from "../../world/index.js";

interface BedCandidate {
  readonly foot: Vec3;
  readonly head: Vec3;
  readonly direction: Vec3;
}

type BedPlacementResult =
  | { kind: "placed"; block: WorldBlock; foot: Vec3 }
  | { kind: "failed"; reason: "missing_bed" | "no_footprint" | "placement_failed"; error: string };

const UP = new Vec3(0, 1, 0);
const ORIGIN = new Vec3(0, 0, 0);
const CARDINALS = [new Vec3(0, 0, -1), new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0)];

export function isBedBlock(name?: string | null): boolean {
  return typeof name === "string" && name.endsWith("_bed");
}

/** Describe bed meaning around the generic supported footprint search. */
function findBedPlacementCandidates(bot: Bot, maxRadius = 4): BedCandidate[] {
  const candidates = CARDINALS.flatMap((direction) =>
    findFlatPlacementCandidates(bot, [ORIGIN, direction], maxRadius).map((foot) => ({
      foot,
      head: foot.plus(direction),
      direction,
    })),
  );

  return candidates.sort(
    (left, right) => bot.entity.position.distanceTo(left.foot) - bot.entity.position.distanceTo(right.foot),
  );
}

/** Select a carried bed and try the nearest valid bed footprints. */
export async function placeCarriedBed(bot: Bot, signal?: AbortSignal): Promise<BedPlacementResult> {
  const bedItem = bot.inventory.items().find((item) => isBedBlock(item.name));
  if (!bedItem) return { kind: "failed", reason: "missing_bed", error: "No bed found in inventory to place." };

  const candidates = findBedPlacementCandidates(bot);
  if (candidates.length === 0) {
    return {
      kind: "failed",
      reason: "no_footprint",
      error: "No nearby supported 2-block flat ground found to place a bed.",
    };
  }

  let lastError = "The expected bed did not appear after placement.";
  for (const candidate of candidates.slice(0, 8)) {
    signal?.throwIfAborted();
    const support = bot.blockAt(candidate.foot.offset(0, -1, 0));
    if (!support || !supportsFlatPlacement(support)) continue;

    const result = await placeBlock(bot, {
      item: bedItem,
      support,
      face: UP,
      // Mineflayer can use either half, but the head avoids re-deriving the
      // other half from version-specific bed-state metadata.
      expectedCells: [candidate.head, candidate.foot],
      matches: (block) => isBedBlock(block.name),
      lookDirection: candidate.direction,
      signal,
    });
    if (result.kind === "placed") return { kind: "placed", block: result.block, foot: candidate.foot };
    lastError = result.error;
  }

  return {
    kind: "failed",
    reason: "placement_failed",
    error: `Failed to place bed in nearby candidate locations: ${lastError}`,
  };
}
