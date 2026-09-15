import type { Vec3 } from "vec3";
import { activationGroupAt } from "../../navigation/world/world.js";
import { observeMineflayerBlock } from "../../navigation/mineflayer/world.js";
import type { Bot } from "mineflayer";
import { createMovements, type MovementPolicy } from "../../navigation/index.js";

export interface CollectionMovementOptions {
  readonly protectedBlockNames: readonly string[];
  readonly protectedScaffoldNames: readonly string[];
  readonly scaffolding: boolean;
  readonly exactTarget: Vec3 | null;
  readonly matchingStateIds: ReadonlySet<number>;
}

/** Apply Collect's action-specific constraints to the production movement policy. */
export function createCollectionMovements(bot: Bot, options: CollectionMovementOptions): MovementPolicy {
  const exact = options.exactTarget?.floored() ?? null;
  const targetBlock = exact ? bot.blockAt(exact) : null;
  const targetGroup = exact && targetBlock ? activationGroupAt(observeMineflayerBlock(targetBlock), exact) : null;
  return createMovements(bot, {
    ...options,
    // A requested interactive block is material to collect; routing preserves the others.
    isRequestedBreak: (block, position) => {
      if (!options.matchingStateIds.has(block.stateId)) return false;
      if (!exact || (position.x === exact.x && position.y === exact.y && position.z === exact.z)) return true;
      // A requested door owns both halves of the same existing activation group.
      return targetGroup !== null && activationGroupAt(block, position) === targetGroup;
    },
    // Baritone's `maxFallHeightNoWater`, which is three because three blocks is
    // the longest fall that costs no health. Two left the planner refusing
    // descents it could take for free, so a drop three below a bot standing in
    // a mined-out trunk read as unreachable and the log stayed on the ground.
    maximumDrop: 3,
    requireHarvestTool: true,
    // Collection exists to remove blocks, so the terrain-preserving penalty a
    // walking route carries would price its own purpose out of every route.
    // Baritone's mining default is the right one here.
    breakPenalty: 2,
  });
}
