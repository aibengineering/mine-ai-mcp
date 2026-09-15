/**
 * May the mine process remove this target, and what must it do first?
 *
 * The movement policy answers "may the route break this block in passing?" and
 * its answer stays no wherever liquid would follow the route in — that is
 * Baritone's `avoidBreaking`, and a route opening a wall into lava while
 * walking is the failure it exists to prevent.
 *
 * A target break is a different question: "can the process make this break
 * safe, then make it?" Baritone never asks it — `MineProcess` prunes ore
 * locations with the same flood rule, so it cannot mine obsidian beside a lava
 * source either, and its users mine obsidian by hand. The departure is ours,
 * on purpose, and it lives here rather than in the policy:
 *
 * - Flowing water beside or above a target requires preparation too. The mine process
 *   removes reachable feeding sources or closes local water faces before the
 *   break. A route's lava avoidance cannot protect a stationary dig from drift.
 * - Lava is closed before the break. Each lava neighbour takes one carried
 *   block, which vanilla lets a placement put into a fluid cell, source
 *   included.
 * - A target with more lava faces than available building blocks is not
 *   mineable. The caller supplies that budget after reserving collection items.
 *
 * Collect-block's own lateral-lava refusal and its falling-column check are
 * folded in here, so there is one rule in one place.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { plausibleToBreak } from "../../../world/block-classification.js";
import { waterMiningStance } from "../../world/water.js";
import {
  observeMineflayerBlock,
  type BlockPosition,
  type MineflayerBlock,
  type MovementPolicy,
  type WorldView,
} from "../../index.js";

/** The six cells that can pour into a mined one, or drop into it. */
const NEIGHBOURS = [
  new Vec3(0, 1, 0),
  new Vec3(0, -1, 0),
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
] as const;

export type MineTargetDecision =
  | {
      readonly kind: "mineable";
      /**
       * Whether a route may break this target on its way into the cell. False
       * when liquid touches it: the route refuses such a break, so the process
       * walks into reach, closes the lava with `lavaFacesOf` read again from
       * the live world, and breaks it in place.
       */
      readonly routeMayBreak: boolean;
    }
  | { readonly kind: "prohibited"; readonly reason: string };

/** Every neighbouring cell of `position` that holds lava right now. */
export function lavaFacesOf(bot: Bot, position: BlockPosition): BlockPosition[] {
  const centre = new Vec3(position.x, position.y, position.z);
  return NEIGHBOURS.map((offset) => centre.plus(offset)).filter((cell) => bot.blockAt(cell, false)?.name === "lava");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * Whether a stack of sand or gravel above the target can come down safely.
 *
 * Baritone prices such a column into the mining cost and mines through it. The
 * one case worth refusing is a stack whose own break the policy prohibits,
 * because then the column stays where it is and the target is never exposed.
 */
function fallingColumnStop(
  bot: Bot,
  movements: MovementPolicy,
  position: BlockPosition,
  world: WorldView,
): string | null {
  for (let above = new Vec3(position.x, position.y + 1, position.z); ; above = above.offset(0, 1, 0)) {
    const block = bot.blockAt(above, false);
    if (!block) return "the column above the target is not loaded";
    const observation = observeMineflayerBlock(block);
    if (!observation.traits.falling) return null;
    const cell = { x: above.x, y: above.y, z: above.z };
    if (movements.evaluateBreak(observation, cell, world).decision.kind === "prohibited") {
      return `a ${block.name} resting on the target cannot be broken`;
    }
  }
}

/**
 * The mine process's one target rule. Callers hand it a loaded matching block;
 * it answers whether the block can come out with the available placement
 * budget, and what has to happen first.
 */
export function evaluateMineTarget(
  bot: Bot,
  movements: MovementPolicy,
  block: MineflayerBlock,
  world: WorldView,
  availableBlocks: number,
): MineTargetDecision {
  if (!plausibleToBreak(block)) return { kind: "prohibited", reason: `${block.name} cannot be broken at all` };
  const position = { x: block.position.x, y: block.position.y, z: block.position.z };
  const evaluation = movements.evaluateBreak(observeMineflayerBlock(block), position, world);
  const decision = evaluation.decision;
  const floodRule = decision.kind === "prohibited" && decision.cause === "opens_into_liquid";
  if (decision.kind === "prohibited" && !floodRule) return { kind: "prohibited", reason: decision.reason };
  const below = world.blockAt(position.x, position.y - 1, position.z);
  const needsIsolation = floodRule || (below.kind === "loaded" && below.traits.liquid === "water");

  const lavaFaces = lavaFacesOf(bot, position);
  if (lavaFaces.length > availableBlocks) {
    return {
      kind: "prohibited",
      reason: `${plural(lavaFaces.length, "lava face")}, ${plural(availableBlocks, "block")} available for placement`,
    };
  }
  // A swimmer may still need to settle, and a shore miner can approach a
  // submerged target through its open water column. Neither needs to flood
  // a dry stance; physical work still checks the actual stance and air.
  if (needsIsolation && availableBlocks === 0 && !bot.inventory.items().some((item) => item.name === "bucket") &&
    Reflect.get(bot.entity, "isInWater") !== true &&
    !waterMiningStance((x, y, z) => world.blockAt(x, y, z), { ...position, y: position.y + 1 }, true)) {
    return { kind: "prohibited", reason: "liquid isolation needs a permitted building block or an empty bucket" };
  }
  const falling = fallingColumnStop(bot, movements, position, world);
  if (falling !== null) return { kind: "prohibited", reason: falling };
  return { kind: "mineable", routeMayBreak: !needsIsolation && lavaFaces.length === 0 };
}
