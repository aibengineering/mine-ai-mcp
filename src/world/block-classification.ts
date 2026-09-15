/** The least a block has to say about itself to be classified at all. */
export interface NamedBlock {
  readonly name: string;
}

/** The block facts needed by placement policy, without depending on a concrete registry version. */
export interface ClassifiedBlock extends NamedBlock {
  readonly boundingBox: "block" | "empty";
}

const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);
const LIQUID_BLOCKS = new Set(["water", "lava", "bubble_column"]);
const REPLACEABLE_PLANTS = new Set([
  "short_grass",
  "tall_grass",
  "fern",
  "large_fern",
  "dead_bush",
  "warped_roots",
  "crimson_roots",
  "nether_sprouts",
  "dandelion",
  "poppy",
  "blue_orchid",
  "allium",
  "azure_bluet",
  "oxeye_daisy",
  "cornflower",
  "lily_of_the_valley",
  "wither_rose",
  "vine",
  "glow_lichen",
  "leaf_litter",
  "snow",
]);

export function isAir(block: NamedBlock | null): boolean {
  return block !== null && AIR_BLOCKS.has(block.name);
}

export function isLiquid(block: NamedBlock | null): boolean {
  return block !== null && LIQUID_BLOCKS.has(block.name);
}

/**
 * A cell the server overwrites when an ordinary block is placed into it.
 *
 * Fluids belong here: vanilla replaces a water or lava cell with the placed
 * block, source included. That is how a lava face is closed before a target
 * break and how a pour cell is made in solid rock, and refusing it was the
 * last link in the chain that left run 10 unable to recover its own water.
 */
export function isReplaceableForPlacement(block: ClassifiedBlock | null): boolean {
  if (!block) return false;
  return (
    isAir(block) ||
    isLiquid(block) ||
    REPLACEABLE_PLANTS.has(block.name) ||
    block.name.endsWith("_flower") ||
    block.name.endsWith("_tulip")
  );
}

/**
 * A cell worth choosing for something the bot has to stand beside and use: a
 * workstation, a bed, a block put down for convenience. Replaceable and dry.
 *
 * Separate from `isReplaceableForPlacement` because the questions differ. A
 * seal or a pour cell is aimed at a cell the caller named for a reason and a
 * fluid there is the point; a site *chosen* for the bot is never better for
 * being under water or in lava.
 */
export function isDryPlacementSite(block: ClassifiedBlock | null): boolean {
  return isReplaceableForPlacement(block) && !isLiquid(block);
}

/** The conservative support accepted for flat structures such as beds and workstations. */
export function supportsFlatPlacement(block: ClassifiedBlock | null): boolean {
  return block?.boundingBox === "block";
}

/** The block facts that decide whether mining a cell is worth attempting. */
export interface MineableBlock extends NamedBlock {
  /** False for bedrock, barriers, and anything else the server will not yield. */
  readonly diggable?: boolean;
}

/**
 * Whether this block is worth targeting at all.
 *
 * Baritone's `MineProcess.plausibleToBreak` refuses only what costs infinity —
 * liquid, no usable tool, an unbreakable block — and lets the search decide the
 * rest. Notably it does *not* refuse a block with sand or gravel resting on it:
 * that stack is priced into the mining cost and mined through. Where the drop
 * lands afterwards is not asked, because no answer would change the decision.
 */
export function plausibleToBreak(block: MineableBlock | null): boolean {
  return block !== null && block.diggable !== false && !isLiquid(block);
}
