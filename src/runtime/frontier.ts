import type { Bot } from "mineflayer";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { Vec3 } from "vec3";
import { SqlBotData } from "../bot-data/index.js";
import { ExecutionScope } from "../execution/execution-scope.js";
import { CHUNK_WIDTH, chunkPosition } from "../world/chunks.js";

export interface SessionFrontierStatus {
  observedChunks: number;
  pendingChunks: number;
  error: string | null;
}

export interface FrontierChunk {
  readonly dimension: string;
  readonly chunkX: number;
  readonly chunkZ: number;
}

export interface SessionFrontier extends Disposable {
  status(): SessionFrontierStatus;
  idle(): Promise<void>;
  boundary(dimension: string, direction: { readonly x: number; readonly z: number }): number | null;
  onRecorded(listener: (chunk: FrontierChunk) => void): () => void;
  close(): void;
}

interface PaletteContainer {
  palette?: number[];
  value?: number;
  get(index: number): number;
}

interface LoadedColumn {
  sections: Array<{ data: PaletteContainer }>;
  biomes: Array<{ data: PaletteContainer }>;
}

interface PendingChunk extends FrontierChunk {
  firstObservedAt: string;
  column: LoadedColumn;
}

type SurfaceKind = "air" | "water" | "other";

const SECTION_HEIGHT = 16;
const CHUNK_SURFACE_CELLS = CHUNK_WIDTH * CHUNK_WIDTH;
const AIR_BLOCKS = new Set(["air", "cave_air", "void_air"]);
const SURFACE_WATER_BLOCKS = new Set(["water", "bubble_column"]);

const ROUTINE_MATERIALS = new Set([
  "air",
  "cave_air",
  "void_air",
  "stone",
  "granite",
  "diorite",
  "andesite",
  "tuff",
  "deepslate",
  "cobbled_deepslate",
  "dirt",
  "grass_block",
  "bedrock",
  "water",
  "cobblestone",
  "coal_ore",
  "deepslate_coal_ore",
  "iron_ore",
  "deepslate_iron_ore",
  "gravel",
  "copper_ore",
  "deepslate_copper_ore",
  "gold_ore",
  "deepslate_gold_ore",
  "redstone_ore",
  "deepslate_redstone_ore",
  "lapis_ore",
  "deepslate_lapis_ore",
  "deepslate_diamond_ore",
]);

/**
 * Records loaded chunks, useful material sets, and counted biome samples.
 * Work is queued so packet delivery never performs a scan.
 */
export function attachSessionFrontier(bot: Bot, data: SqlBotData): SessionFrontier {
  let closed = false;
  let processingPromise: Promise<void> | undefined;
  let storageError: string | null = null;
  let observedChunks = Number(data.read("SELECT COUNT(*) AS count FROM frontier_chunks")[0]?.count ?? 0);
  const pending = new Map<string, PendingChunk>();
  const scanErrors = new Map<string, string>();
  const recordedListeners = new Set<(chunk: FrontierChunk) => void>();

  const remember = (chunk: FrontierChunk, column: LoadedColumn | undefined) => {
    if (closed || !column) return;
    try {
      const alreadyRecorded =
        data.read("SELECT 1 FROM frontier_chunks WHERE chunk_key = ?", chunkKey(chunk)).length > 0;
      if (!alreadyRecorded) queueChunk({ ...chunk, firstObservedAt: new Date().toISOString(), column });
      storageError = null;
    } catch (cause) {
      storageError = message(cause);
    }
  };

  const processPendingChunks = async () => {
    await yieldToEventLoop();
    while (!closed && pending.size > 0) {
      const [key, chunk] = pending.entries().next().value!;
      pending.delete(key);
      using execution = new ExecutionScope({ bot: bot.username, operation: "frontier", targetId: null });
      try {
        if (execution.runSync(`scan_and_record:${key}`, () => scanAndRecord(bot, data, chunk))) {
          observedChunks += 1;
          // The transaction has committed. Consumers can therefore treat this
          // notification as persisted evidence from this bot, rather than a
          // chunk-load packet or a write made by another process.
          const recorded = { dimension: chunk.dimension, chunkX: chunk.chunkX, chunkZ: chunk.chunkZ };
          for (const listener of recordedListeners) {
            try {
              listener(recorded);
            } catch {
              // A consumer cannot turn an already committed chunk into a scan
              // failure or prevent the remaining consumers from seeing it.
            }
          }
        }
        scanErrors.delete(key);
      } catch (cause) {
        scanErrors.set(key, `Chunk ${key}: ${message(cause)}`);
      }
      await yieldToEventLoop();
    }
    processingPromise = undefined;
  };

  function queueChunk(chunk: PendingChunk) {
    const key = chunkKey(chunk);
    if (!pending.has(key)) pending.set(key, chunk);
    processingPromise ??= processPendingChunks();
  }

  const loaded = (corner: Vec3) => {
    const { chunkX, chunkZ } = chunkPosition(corner);
    remember(
      {
        dimension: bot.game.dimension,
        chunkX,
        chunkZ,
      },
      bot.world.getColumn(chunkX, chunkZ) as unknown as LoadedColumn | undefined,
    );
  };
  bot.on("chunkColumnLoad", loaded);

  // The bot is already spawned when the session is built, so its spawn ring may
  // have arrived before this listener existed.
  for (const { chunkX, chunkZ, column } of bot.world.getColumns()) {
    remember({ dimension: bot.game.dimension, chunkX, chunkZ }, column as unknown as LoadedColumn);
  }

  const close = (): void => {
    if (closed) return;
    closed = true;
    pending.clear();
    recordedListeners.clear();
    bot.off("chunkColumnLoad", loaded);
  };

  return {
    status: (): SessionFrontierStatus => ({
      observedChunks,
      pendingChunks: pending.size,
      error: storageError ?? scanErrors.values().next().value ?? null,
    }),
    idle: () => processingPromise ?? Promise.resolve(),
    boundary: (dimension, direction): number | null => {
      const row = data.read(
        `
        SELECT MAX(chunk_x * ? + chunk_z * ?) AS boundary
        FROM frontier_chunks
        WHERE dimension = ?
      `,
        direction.x,
        direction.z,
        dimension,
      )[0];
      return row?.boundary === null || row?.boundary === undefined ? null : Number(row.boundary);
    },
    onRecorded: (listener) => {
      recordedListeners.add(listener);
      return () => recordedListeners.delete(listener);
    },
    close,
    [Symbol.dispose]: close,
  };
}

function scanAndRecord(bot: Bot, data: SqlBotData, chunk: PendingChunk): boolean {
  const key = chunkKey(chunk);
  const blockNameFor = (stateId: number) => bot.registry.blocksByStateId[stateId]?.name;
  const materials = namesFromPalettes(chunk.column.sections, 4096, blockNameFor, ROUTINE_MATERIALS);
  const biomes = countNamesFromPalettes(chunk.column.biomes, 64, (biomeId) => bot.registry.biomes[biomeId]?.name);
  const surfaceWaterFraction = measureSurfaceWaterFraction(chunk.column.sections, blockNameFor);
  const scannedAt = new Date().toISOString();

  return data.transaction((database) => {
    const inserted = database
      .prepare(
        `
        INSERT INTO frontier_chunks (
          chunk_key, dimension, chunk_x, chunk_z,
          first_observed_at, scanned_at, surface_water_fraction
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (chunk_key) DO NOTHING
      `,
      )
      .run(
        key,
        chunk.dimension,
        chunk.chunkX,
        chunk.chunkZ,
        chunk.firstObservedAt,
        scannedAt,
        surfaceWaterFraction,
      ).changes;
    if (!inserted) return false;

    updateFrontierFlags(database, chunk);

    const insertMaterial = database.prepare(`
      INSERT INTO frontier_chunk_materials (chunk_key, material)
      VALUES (?, ?)
    `);
    for (const material of materials) insertMaterial.run(key, material);
    const insertBiome = database.prepare(`
      INSERT INTO frontier_chunk_biomes (chunk_key, biome, sample_count)
      VALUES (?, ?, ?)
    `);
    for (const [biome, sampleCount] of biomes) insertBiome.run(key, biome, sampleCount);
    return true;
  }, { name: "scanAndRecord" });
}

/** Recheck only the new chunk and the four chunks whose frontier state it can change. */
function updateFrontierFlags(database: DatabaseSync, chunk: FrontierChunk): void {
  database
    .prepare(
      `
      WITH direction (delta_x, delta_z) AS (
        VALUES (0, -1), (1, 0), (0, 1), (-1, 0)
      )
      UPDATE frontier_chunks AS candidate
      SET is_frontier = EXISTS (
        SELECT 1 FROM direction
        WHERE NOT EXISTS (
          SELECT 1
          FROM frontier_chunks AS neighbour
          WHERE neighbour.dimension = candidate.dimension
            AND neighbour.chunk_x = candidate.chunk_x + direction.delta_x
            AND neighbour.chunk_z = candidate.chunk_z + direction.delta_z
        )
      )
      WHERE chunk_key IN (?, ?, ?, ?, ?)
    `,
    )
    // Seek the five primary keys. A correlated WHERE EXISTS scans every
    // historical chunk, making each newly streamed column cost more forever.
    .run(
      chunkKey(chunk),
      chunkKey({ ...chunk, chunkZ: chunk.chunkZ - 1 }),
      chunkKey({ ...chunk, chunkX: chunk.chunkX + 1 }),
      chunkKey({ ...chunk, chunkZ: chunk.chunkZ + 1 }),
      chunkKey({ ...chunk, chunkX: chunk.chunkX - 1 }),
    );
}

function chunkKey(chunk: FrontierChunk): string {
  return `${chunk.dimension}|${chunk.chunkX}|${chunk.chunkZ}`;
}

function measureSurfaceWaterFraction(
  sections: Array<{ data: PaletteContainer }>,
  nameFor: (stateId: number) => string | undefined,
): number {
  const resolved = new Uint8Array(CHUNK_SURFACE_CELLS);
  const kinds = new Map<number, SurfaceKind>();
  let unresolvedCells = CHUNK_SURFACE_CELLS;
  let waterCells = 0;

  const kindFor = (stateId: number): SurfaceKind => {
    const known = kinds.get(stateId);
    if (known !== undefined) return known;
    const name = nameFor(stateId);
    let kind: SurfaceKind = "other";
    if (name !== undefined && AIR_BLOCKS.has(name)) kind = "air";
    else if (name !== undefined && SURFACE_WATER_BLOCKS.has(name)) kind = "water";
    kinds.set(stateId, kind);
    return kind;
  };

  for (let sectionIndex = sections.length - 1; sectionIndex >= 0 && unresolvedCells > 0; sectionIndex -= 1) {
    const { data } = sections[sectionIndex]!;
    if (typeof data.value === "number") {
      const kind = kindFor(data.value);
      if (kind === "air") continue;
      if (kind === "water") waterCells += unresolvedCells;
      break;
    }
    if (data.palette?.every((stateId) => kindFor(stateId) === "air")) continue;

    for (let y = SECTION_HEIGHT - 1; y >= 0 && unresolvedCells > 0; y -= 1) {
      for (let horizontalIndex = 0; horizontalIndex < CHUNK_SURFACE_CELLS; horizontalIndex += 1) {
        if (resolved[horizontalIndex]) continue;
        const kind = kindFor(data.get((y << 8) | horizontalIndex));
        if (kind === "air") continue;
        resolved[horizontalIndex] = 1;
        unresolvedCells -= 1;
        if (kind === "water") waterCells += 1;
      }
    }
  }

  return waterCells / CHUNK_SURFACE_CELLS;
}

function namesFromPalettes(
  sections: Array<{ data: PaletteContainer }>,
  capacity: number,
  nameFor: (id: number) => string | undefined,
  excluded: ReadonlySet<string> = new Set(),
): string[] {
  const ids = new Set<number>();
  for (const { data } of sections) {
    if (typeof data.value === "number") {
      ids.add(data.value);
    } else if (data.palette) {
      for (const id of data.palette) ids.add(id);
    } else {
      for (let index = 0; index < capacity; index += 1) ids.add(data.get(index));
    }
  }
  const names = new Set<string>();
  for (const id of ids) {
    const name = nameFor(id);
    if (name !== undefined && !excluded.has(name)) names.add(name);
  }
  return [...names].sort();
}

function countNamesFromPalettes(
  sections: Array<{ data: PaletteContainer }>,
  capacity: number,
  nameFor: (id: number) => string | undefined,
): Array<readonly [name: string, count: number]> {
  const counts = new Map<string, number>();
  for (const { data } of sections) {
    if (typeof data.value === "number") {
      const name = nameFor(data.value);
      if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + capacity);
      continue;
    }

    for (let index = 0; index < capacity; index += 1) {
      const name = nameFor(data.get(index));
      if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right));
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
