import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { cellIntersectsPlayerBody } from "../utils/index.js";
import { isDryPlacementSite, supportsFlatPlacement } from "./block-classification.js";
import { placeBlock, findPlacementSupport, type WorldBlock } from "./placement.js";
import { chestOpeningObstruction } from "./chest-clearance.js";

/** Vanilla block-interaction reach, measured from the bot's feet cell like every other placement here. */
const NEARBY_PLACEMENT_REACH = 4;
/** Feet level first, then the step down and the step up; a cell two up is over the bot's head. */
const SEARCH_HEIGHTS = [0, -1, 1] as const;

export type NearbyPlacement =
  | { readonly kind: "placed"; readonly position: Vec3; readonly block: WorldBlock }
  | { readonly kind: "no_item" }
  | { readonly kind: "no_cell" }
  | { readonly kind: "failed"; readonly position: Vec3; readonly error: string };

interface PlacementCell {
  readonly position: Vec3;
  readonly support: NonNullable<ReturnType<Bot["blockAt"]>>;
  /** The face of the support the block is placed against: from the support toward the cell. */
  readonly face: Vec3;
}

/**
 * The nearest clear cell around the bot with a solid neighbour to place
 * against, floor-supported cells before wall-supported ones at the same
 * distance.
 *
 * The seventh playthrough carried a crafting table it could not put down
 * for three calls running while a floor cell was demanded: a tunnel face
 * has walls on every side and no free floor, and the model walked off to
 * find open ground instead of crafting where it stood.
 */
function chooseCell(bot: Bot, itemName: string, maxRadius: number): PlacementCell | null {
  const feet = bot.entity.position.floored();
  let chosen: { readonly cell: PlacementCell; readonly distance: number; readonly onFloor: boolean } | null = null;
  for (let dx = -maxRadius; dx <= maxRadius; dx += 1) {
    for (let dz = -maxRadius; dz <= maxRadius; dz += 1) {
      for (const dy of SEARCH_HEIGHTS) {
        const position = feet.offset(dx, dy, dz);
        const distance = position.distanceTo(feet);
        if (distance > NEARBY_PLACEMENT_REACH || cellIntersectsPlayerBody(position, bot.entity.position)) continue;
        if (!isDryPlacementSite(bot.blockAt(position))) continue;
        if (chestOpeningObstruction(bot, itemName, position)) continue;
        const placement = findPlacementSupport(bot, position, supportsFlatPlacement);
        if (placement) {
          const { support, face } = placement;
          const onFloor = face.y === 1;
          const better =
            chosen === null ||
            distance < chosen.distance - 1e-9 ||
            (Math.abs(distance - chosen.distance) < 1e-9 && onFloor && !chosen.onFloor);
          if (better) chosen = { cell: { position, support, face }, distance, onFloor };
        }
      }
    }
  }
  return chosen?.cell ?? null;
}

/**
 * Place one carried block on the nearest clear cell around the bot, without
 * moving.
 *
 * A model underground cannot see which cells are free, and the first
 * playthrough spent a third of its calls guessing coordinates for a crafting
 * table. The cell is chosen here: clear, outside the bot's body, within
 * reach, with something solid to place against, nearest first.
 */
export async function placeCarriedBlockNearby(
  bot: Bot,
  itemName: string,
  options: { readonly maxRadius?: number; readonly signal?: AbortSignal } = {},
): Promise<NearbyPlacement> {
  const item = bot.inventory.items().find((candidate) => candidate.name === itemName);
  if (!item) return { kind: "no_item" };
  const cell = chooseCell(bot, itemName, options.maxRadius ?? 3);
  if (!cell) return { kind: "no_cell" };
  const result = await placeBlock(bot, {
    item,
    support: cell.support,
    face: cell.face,
    expectedCells: [cell.position],
    matches: (block) => block.name === itemName,
    signal: options.signal,
  });
  if (result.kind === "placed") return { kind: "placed", position: cell.position, block: result.block };
  return { kind: "failed", position: cell.position, error: result.error };
}
