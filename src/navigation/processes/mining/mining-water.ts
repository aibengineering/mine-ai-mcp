import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { waitForPhysicsTicks } from "../../../utils/physics-ticks.js";
import type { useItemAt } from "../../../world/item-use.js";
import { HORIZONTAL, sourceFeeding, sourceInSight } from "../../../world/liquid.js";
import type { PlaceIntoCell } from "../../../world/placement.js";
import { holdWaterPosition } from "../../steering/hold-water-position.js";
import { UNLOADED, type BlockPosition } from "../../world/world.js";
import { observeMineflayerBlock } from "../../mineflayer/world.js";
import { waterMiningStance } from "../../world/water.js";

const touching = (cell: Vec3) => [
  cell.offset(0, 1, 0),
  cell.offset(0, -1, 0),
  ...HORIZONTAL.map((offset) => cell.plus(offset)),
];

/** Remove feeding sources first; otherwise isolate the target's local water faces. */
export async function clearMiningWater(
  bot: Bot,
  position: BlockPosition,
  place: PlaceIntoCell,
  use: typeof useItemAt | null,
  signal?: AbortSignal,
): Promise<string | null> {
  const target = new Vec3(position.x, position.y, position.z);
  const read = (x: number, y: number, z: number) => {
    const block = bot.blockAt(new Vec3(x, y, z));
    return block ? observeMineflayerBlock(block) : UNLOADED;
  };
  if (waterMiningStance(read, bot.entity.position.floored(), bot.entity.onGround)) return null;
  const wetFaces = () => {
    const above = bot.blockAt(target.offset(0, 1, 0));
    const connected = above && observeMineflayerBlock(above).traits.empty
      ? HORIZONTAL.map((offset) => target.plus(offset).offset(0, 1, 0)) : [];
    return [...touching(target), ...connected].filter((cell) => bot.blockAt(cell)?.name === "water");
  };
  const seeds = [...wetFaces(), bot.entity.position.floored()];
  if (!seeds.some((cell) => bot.blockAt(cell)?.name === "water")) return null;
  const release = holdWaterPosition(bot, signal);
  const lifetime = signal ?? new AbortController().signal;
  try {
    const sources = new Map<string, Vec3>();
    for (const cell of seeds) {
      const source = sourceFeeding(bot, cell, "water");
      if (source) sources.set(source.toString(), source);
    }
    let removedSource = false;
    for (const source of sources.values()) {
      signal?.throwIfAborted();
      if (!sourceInSight(bot, bot.entity.position.offset(0, 1.62, 0), source)) continue;
      const bucket = bot.inventory.items().find((item) => item.name === "bucket");
      if (bucket && use) {
        const scooped = await use(bot, {
          item: bucket,
          lookAt: source.offset(0.5, 0.9, 0.5),
          expectedHeldItem: "water_bucket",
          ...(signal && { signal }),
        });
        if (scooped.kind !== "failed") {
          removedSource = true;
          continue;
        }
      }
      const plugged = await place(bot, source, { ...(signal && { signal }) });
      if (plugged.kind !== "failed") removedSource = true;
    }
    // A removed source takes successive scheduled water updates to drain its
    // seven-cell horizontal spread. Observe those updates before sealing what
    // is still being fed; never infer drained water from bucket inventory alone.
    for (let ticks = 0; removedSource && ticks < 40 &&
      (wetFaces().length > 0 || bot.blockAt(bot.entity.position.floored())?.name === "water"); ticks++)
      await waitForPhysicsTicks(bot, 1, lifetime);
    for (const cell of wetFaces()) {
      const placed = await place(bot, cell, { ...(signal && { signal }) });
      if (placed.kind === "failed") return `water at ${cell} could not be isolated: ${placed.error}`;
    }
    if (Reflect.get(bot.entity, "isInWater") === true)
      return "the mining stance is still in water after isolating the target";
    return wetFaces().length === 0 ? null : "water returned to the target before mining";
  } finally {
    release();
  }
}
