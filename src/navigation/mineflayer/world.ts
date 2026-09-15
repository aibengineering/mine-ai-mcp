/**
 * The live world as navigation sees it: block state ids read from a typed
 * array per chunk section, described by one shared observation per state.
 *
 * Search reads tens of thousands of cells per second, so a lookup must not
 * build a Prismarine `Block`. Instead the view keeps a `Uint16Array` per
 * 16×16×16 section, filled cell by cell as cells are first asked for (a
 * search touches a fraction of the sections it crosses), kept current from
 * `blockUpdate`, and dropped when its column loads or unloads.
 * `observeMineflayerBlock` reduces a state to its collision boxes and the
 * handful of traits planning cares about, once per state id, and is the only
 * place those traits are derived from block names.
 */
import type { Bot } from "mineflayer";
import prismarineBlock from "prismarine-block";
import { Vec3 } from "vec3";
import {
  type BlockObservation,
  type BlockTraits,
  type LoadedBlock,
  type WorldChange,
  type WorldView,
  UNLOADED,
  loadedObservation,
  packKey,
} from "../world/world.js";

export type MineflayerBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

/** Blocks a player climbs rather than walks through. */
export const CLIMBABLES = new Set([
  "ladder",
  "vine",
  "weeping_vines",
  "weeping_vines_plant",
  "twisting_vines",
  "twisting_vines_plant",
]);
// Blocks that damage on contact. Upstream's `blocksToAvoid` covers only fire,
// cobweb, and lava, and only for the cell entered — never the floor — so a
// magma walkway read as perfectly safe and the bot burned its way across.
// Blocks whose face answers a right-click. Placing against one operates it
// instead: the block never lands, the ledger sees no mutation, and the route
// replans straight back onto the same support.
const INTERACTIVE = new Set([
  "chest",
  "trapped_chest",
  "ender_chest",
  "barrel",
  "furnace",
  "blast_furnace",
  "smoker",
  "crafting_table",
  "enchanting_table",
  "anvil",
  "brewing_stand",
  "beacon",
  "hopper",
  "dropper",
  "dispenser",
  "lectern",
  "loom",
  "grindstone",
  "smithing_table",
  "cartography_table",
  "stonecutter",
  "note_note",
  "jukebox",
  "respawn_anchor",
  "bell",
]);
const DAMAGING = new Set([
  "magma_block",
  "fire",
  "soul_fire",
  "campfire",
  "soul_campfire",
  "cactus",
  "sweet_berry_bush",
  "wither_rose",
  "powder_snow",
]);

function traits(block: MineflayerBlock): BlockTraits {
  const empty = block.boundingBox === "empty";
  const liquid = block.name === "water" ? "water" : block.name === "lava" ? "lava" : null;
  const properties = block.getProperties() as Readonly<Record<string, unknown>>;
  const bottomSlab = block.name.endsWith("_slab") && properties.type === "bottom";
  const parkourTakeoff =
    liquid !== null || CLIMBABLES.has(block.name) || block.name.endsWith("_stairs") || bottomSlab
      ? "prohibited"
      : block.name === "soul_sand"
        ? "short"
        : "normal";
  // Iron doors and iron trapdoors have no hand interaction: only redstone
  // opens them. Matching them as openable offers an activate operation that
  // can never succeed, so execution burns the confirmation deadline and the
  // route fails where it should simply have planned around the door.
  const openable =
    !block.name.startsWith("iron_") && (block.name.endsWith("_door") || block.name.endsWith("_fence_gate"));
  return {
    empty,
    liquid,
    // Prismarine models water's integer-looking `level` property as the
    // registry enum string "0". Accept a numeric zero as well for older
    // registries and test doubles.
    liquidSource: liquid !== null && (properties.level === "0" || properties.level === 0),
    waterlogged:
      properties.waterlogged === true ||
      properties.waterlogged === "true" ||
      ["seagrass", "tall_seagrass", "kelp", "kelp_plant", "bubble_column"].includes(block.name),
    // The registry gives a waterloggable block the property whatever its
    // current value, so the key alone answers whether water would sink in.
    waterloggable: "waterlogged" in properties,
    climbable: CLIMBABLES.has(block.name),
    openable,
    open: openable && properties.open === true,
    activationGroup: openable ? block.name : null,
    upperHalf: properties.half === "upper",
    falling: block.name === "sand" || block.name === "gravel" || block.name.endsWith("concrete_powder"),
    yielding: block.name === "big_dripleaf",
    damaging: DAMAGING.has(block.name) || liquid === "lava",
    interactive:
      INTERACTIVE.has(block.name) ||
      openable ||
      block.name.endsWith("_bed") ||
      block.name.endsWith("_sign") ||
      block.name.endsWith("_button") ||
      block.name.endsWith("shulker_box"),
    parkourTakeoff,
    safeToBreak: block.diggable && liquid === null,
  };
}

/** Describe one block state as the compact observation planning and policy read. Position-free. */
export function observeMineflayerBlock(block: MineflayerBlock): LoadedBlock {
  return loadedObservation(
    block.stateId,
    Object.freeze(
      block.shapes.map(([minX, minY, minZ, maxX, maxY, maxZ]) => Object.freeze({ minX, minY, minZ, maxX, maxY, maxZ })),
    ),
    Object.freeze(traits(block)),
  );
}

/** Prismarine's `Block` class bound to this bot's registry, for describing a state without a world position. */
export function blockClass(bot: Pick<Bot, "registry">): {
  fromStateId(stateId: number, biomeId: number): MineflayerBlock;
  fromProperties(
    typeId: number,
    properties: Readonly<Record<string, string | number>>,
    biomeId: number,
  ): MineflayerBlock;
} {
  return prismarineBlock(bot.registry);
}

/** The Prismarine chunk column surface the section store copies from. */
interface PrismarineColumn {
  readonly minY: number;
  readonly worldHeight: number;
  /** Reads with x and z local to the column and y absolute, as Prismarine's column does. */
  getBlockStateId(position: Vec3): number;
}

interface CachedColumn {
  readonly source: PrismarineColumn;
  readonly minY: number;
  /** One typed array per 16-block section, made on first use and filled as its cells are read. */
  readonly sections: (Uint16Array | null)[];
}

const SECTION_CELLS = 16 * 16 * 16;
/** A cell the store has not read from Prismarine yet; no block state has this id. */
const UNREAD = 0xffff;
/** The one position handed to Prismarine, reused so a lookup allocates nothing. */
const CURSOR = new Vec3(0, 0, 0);

function columnKey(chunkX: number, chunkZ: number): number {
  return packKey(chunkX, 0, chunkZ);
}

/** Prismarine's section layout: y, then z, then x. */
function cellIndex(x: number, y: number, z: number): number {
  return ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
}

export class MineflayerWorldView implements WorldView {
  readonly #listeners = new Set<(change: WorldChange) => void>();
  readonly #columns = new Map<number, CachedColumn>();
  /** The column of the last lookup: search reads the same one hundreds of times in a row. */
  #lastColumnKey = -1;
  #lastColumn: CachedColumn | null = null;
  /** One shared observation per block state id, built on first sight. */
  readonly #observations: BlockObservation[] = [];
  readonly #Block: ReturnType<typeof blockClass>;
  #revision = 0;

  constructor(readonly bot: Bot) {
    this.#Block = blockClass(bot);
    bot.on("blockUpdate", this.#onBlockUpdate);
    bot.on("chunkColumnLoad", this.#onColumnChange);
    bot.on("chunkColumnUnload", this.#onColumnChange);
  }

  get revision(): number {
    return this.#revision;
  }

  blockAt(x: number, y: number, z: number): BlockObservation {
    const column = this.#column(x >> 4, z >> 4);
    if (!column) return UNLOADED;
    const sectionIndex = (y - column.minY) >> 4;
    // Prismarine reads above and below the world as air.
    if (sectionIndex < 0 || sectionIndex >= column.sections.length) return this.#observation(0);
    const section = (column.sections[sectionIndex] ??= new Uint16Array(SECTION_CELLS).fill(UNREAD));
    const index = cellIndex(x, y, z);
    let stateId = section[index]!;
    if (stateId === UNREAD) {
      CURSOR.x = x & 15;
      CURSOR.y = y;
      CURSOR.z = z & 15;
      stateId = column.source.getBlockStateId(CURSOR);
      section[index] = stateId;
    }
    return this.#observation(stateId);
  }

  subscribe(listener: (change: WorldChange) => void): () => void {
    this.#listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    this.bot.off("blockUpdate", this.#onBlockUpdate);
    this.bot.off("chunkColumnLoad", this.#onColumnChange);
    this.bot.off("chunkColumnUnload", this.#onColumnChange);
    this.#listeners.clear();
    this.#columns.clear();
    this.#lastColumnKey = -1;
    this.#lastColumn = null;
  }

  #observation(stateId: number): BlockObservation {
    return (this.#observations[stateId] ??= observeMineflayerBlock(this.#Block.fromStateId(stateId, 0)));
  }

  #column(chunkX: number, chunkZ: number): CachedColumn | null {
    const key = columnKey(chunkX, chunkZ);
    if (key === this.#lastColumnKey) return this.#lastColumn;
    const cached = this.#columns.get(key) ?? this.#loadColumn(chunkX, chunkZ, key);
    this.#lastColumnKey = key;
    this.#lastColumn = cached;
    return cached;
  }

  #loadColumn(chunkX: number, chunkZ: number, key: number): CachedColumn | null {
    // `WorldSync.getColumn` is synchronous at runtime; Prismarine's typings only declare the async world's.
    const world = this.bot.world as unknown as { getColumn(chunkX: number, chunkZ: number): PrismarineColumn | null };
    const source = world.getColumn(chunkX, chunkZ);
    if (!source) return null;
    const column: CachedColumn = {
      source,
      minY: source.minY,
      sections: new Array<Uint16Array | null>(source.worldHeight >> 4).fill(null),
    };
    this.#columns.set(key, column);
    return column;
  }

  #onBlockUpdate = (oldBlock: MineflayerBlock | null, newBlock: MineflayerBlock): void => {
    this.#revision += 1;
    const position = { x: newBlock.position.x, y: newBlock.position.y, z: newBlock.position.z };
    const column = this.#columns.get(columnKey(position.x >> 4, position.z >> 4));
    const section = column?.sections[(position.y - column.minY) >> 4];
    if (section) section[cellIndex(position.x, position.y, position.z)] = newBlock.stateId;
    const change = {
      position,
      before: oldBlock ? this.#observation(oldBlock.stateId) : UNLOADED,
      after: this.#observation(newBlock.stateId),
      worldRevision: this.#revision,
    };
    for (const listener of this.#listeners) listener(change);
  };

  #onColumnChange = (point: Vec3): void => {
    this.#columns.delete(columnKey(point.x >> 4, point.z >> 4));
    this.#lastColumnKey = -1;
    this.#lastColumn = null;
  };
}
