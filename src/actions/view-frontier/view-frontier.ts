import {
  defineSqlQuery,
  nearestFrontierQuery,
  readSqlQuery,
  refreshNearestFrontier,
  type BotStatusSnapshot,
  type NearestFrontierTarget,
  type SqlBotData,
  type SqlBotDataRow,
} from "../../bot-data/index.js";
import { chunkPosition } from "../../world/chunks.js";
import { markdownCodeBlock } from "../markdown.js";
import { defineSqlAction, sqlActionSource, type SqlAction } from "../sql-action.js";
import {
  FRONTIER_MAP_SCALES,
  VIEW_FRONTIER,
  VIEW_FRONTIER_DESCRIPTION,
  parseViewFrontierRequest,
  viewFrontierResultSchema,
  viewFrontierAnnotations,
  viewFrontierInputSchema,
  type FrontierMapScale,
  type ViewFrontierResult,
  type ViewFrontierRequest,
  type FrontierView,
} from "./contract.js";

interface ChunkSummary {
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly surfaceWaterFraction: number;
  readonly dominantBiome: string | null;
  readonly isFrontier: boolean;
}

interface FrontierMapBounds {
  readonly minX: number | null;
  readonly maxX: number | null;
  readonly minZ: number | null;
  readonly maxZ: number | null;
}

interface MapCell {
  observedChunks: number;
  surfaceWaterTotal: number;
  readonly biomeCounts: Map<string, number>;
  frontier: boolean;
}

interface MapWindow {
  readonly minCellX: number;
  readonly maxCellX: number;
  readonly minCellZ: number;
  readonly maxCellZ: number;
  readonly minChunkX: number;
  readonly maxChunkX: number;
  readonly minChunkZ: number;
  readonly maxChunkZ: number;
}

const BIOME_SYMBOLS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const CARDINAL_OFFSETS = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
] as const;

export const frontierMapBoundsQuery = defineSqlQuery({
  id: "frontier-map-bounds",
  produces: "The outer chunk coordinates of all remembered territory in one dimension.",
  parameterNames: ["dimension"] as const,
  sql: `
    SELECT MIN(chunk_x) AS min_x, MAX(chunk_x) AS max_x, MIN(chunk_z) AS min_z, MAX(chunk_z) AS max_z
    FROM main.frontier_chunks
    WHERE dimension = ?
  `,
  parseRow: (row): FrontierMapBounds => ({
    minX: row.min_x === null ? null : numeric(row, "min_x"),
    maxX: row.max_x === null ? null : numeric(row, "max_x"),
    minZ: row.min_z === null ? null : numeric(row, "min_z"),
    maxZ: row.max_z === null ? null : numeric(row, "max_z"),
  }),
});

export const frontierMapWindowQuery = defineSqlQuery({
  id: "frontier-map-window",
  produces: "Observed chunk summaries used to render one bounded frontier map window.",
  parameterNames: ["dimension", "minChunkX", "maxChunkX", "minChunkZ", "maxChunkZ"] as const,
  sql: `
    SELECT chunk_x, chunk_z, surface_water_fraction, dominant_biome, is_frontier
    FROM main.frontier_map_chunks
    WHERE dimension = ?
      AND chunk_x BETWEEN ? AND ?
      AND chunk_z BETWEEN ? AND ?
    ORDER BY chunk_z, chunk_x
  `,
  parseRow: (row): ChunkSummary => ({
    chunkX: numeric(row, "chunk_x"),
    chunkZ: numeric(row, "chunk_z"),
    surfaceWaterFraction: numeric(row, "surface_water_fraction"),
    dominantBiome: row.dominant_biome === null ? null : String(row.dominant_biome),
    isFrontier: numeric(row, "is_frontier") === 1,
  }),
});

export const frontierChunkExistsQuery = defineSqlQuery({
  id: "frontier-chunk-exists",
  produces: "Whether one chunk coordinate has already been observed in a dimension.",
  parameterNames: ["dimension", "chunkX", "chunkZ"] as const,
  sql: "SELECT 1 AS is_observed FROM main.frontier_chunks WHERE dimension = ? AND chunk_x = ? AND chunk_z = ? LIMIT 1",
  parseRow: (row) => numeric(row, "is_observed") === 1,
});

const VIEW_FRONTIER_QUERIES = [
  frontierMapBoundsQuery,
  frontierMapWindowQuery,
  nearestFrontierQuery,
  frontierChunkExistsQuery,
] as const;

/** Determine the smallest scale in [1, 2, 4, 8, 16] that fits the remembered chunks in the viewport. */
export function determineAutoZoom(
  data: SqlBotData,
  dimension: string,
  centerChunkX: number,
  centerChunkZ: number,
  width: number,
  height: number,
): FrontierMapScale {
  try {
    const row = readSqlQuery(data, frontierMapBoundsQuery.bind({ dimension }))[0];

    if (!row || row.minX === null || row.maxX === null || row.minZ === null || row.maxZ === null) {
      return 1;
    }

    const { minX, maxX, minZ, maxZ } = row;

    const maxSpanX = Math.max(Math.abs(centerChunkX - minX), Math.abs(maxX - centerChunkX));
    const maxSpanZ = Math.max(Math.abs(centerChunkZ - minZ), Math.abs(maxZ - centerChunkZ));

    const halfWidth = Math.floor((width - 1) / 2);
    const halfHeight = Math.floor((height - 1) / 2);

    for (const scale of FRONTIER_MAP_SCALES) {
      if (scale * halfWidth >= maxSpanX && scale * halfHeight >= maxSpanZ) {
        return scale;
      }
    }
    return 16;
  } catch {
    return 1;
  }
}

/** Refresh the real bot status, read the canonical chunk views, then render one bounded text map. */
export function viewFrontier(
  data: SqlBotData,
  status: BotStatusSnapshot,
  request: ViewFrontierRequest,
): FrontierView {
  const { chunkX: centerChunkX, chunkZ: centerChunkZ } = chunkPosition(status);
  const chunksPerCell =
    request.chunksPerCell ??
    determineAutoZoom(data, status.dimension, centerChunkX, centerChunkZ, request.width, request.height);

  const window = mapWindow(centerChunkX, centerChunkZ, request.width, request.height, chunksPerCell);
  const chunks = readChunks(data, status.dimension, window);
  const cells = aggregateCells(chunks, window, chunksPerCell);
  const biomeSymbols = assignBiomeSymbols(cells);
  const closestFrontier = refreshNearestFrontier(data, status);
  const targetUnexplored = closestFrontier
    ? findUnexploredTarget(data, status.dimension, closestFrontier.chunkX, closestFrontier.chunkZ)
    : null;

  if (request.perspective === "all") {
    const biomeMap = renderMap(
      cells,
      "biome",
      request.width,
      chunksPerCell,
      window,
      centerChunkX,
      centerChunkZ,
      biomeSymbols,
      closestFrontier,
      targetUnexplored,
    );
    const waterMap = renderMap(
      cells,
      "surface_water",
      request.width,
      chunksPerCell,
      window,
      centerChunkX,
      centerChunkZ,
      biomeSymbols,
      closestFrontier,
      targetUnexplored,
    );
    const biomeLegend = legendFor("biome", biomeSymbols);
    const waterLegend = legendFor("surface_water", biomeSymbols);

    return {
      perspective: "all",
      dimension: status.dimension,
      center: {
        blockX: status.x,
        blockZ: status.z,
        chunkX: centerChunkX,
        chunkZ: centerChunkZ,
      },
      closestFrontier,
      window: {
        width: request.width,
        height: request.height,
        chunksPerCell,
        minChunkX: window.minChunkX,
        maxChunkX: window.maxChunkX,
        minChunkZ: window.minChunkZ,
        maxChunkZ: window.maxChunkZ,
      },
      map: `${biomeMap}\n\n${waterMap}`,
      maps: {
        biome: biomeMap,
        surface_water: waterMap,
      },
      legend: [...biomeLegend, "--- Surface Water ---", ...waterLegend],
      legends: {
        biome: biomeLegend,
        surface_water: waterLegend,
      },
    };
  }

  const legend = legendFor(request.perspective, biomeSymbols);
  const map = renderMap(
    cells,
    request.perspective,
    request.width,
    chunksPerCell,
    window,
    centerChunkX,
    centerChunkZ,
    biomeSymbols,
    closestFrontier,
    targetUnexplored,
  );

  return {
    perspective: request.perspective,
    dimension: status.dimension,
    center: {
      blockX: status.x,
      blockZ: status.z,
      chunkX: centerChunkX,
      chunkZ: centerChunkZ,
    },
    closestFrontier,
    window: {
      width: request.width,
      height: request.height,
      chunksPerCell,
      minChunkX: window.minChunkX,
      maxChunkX: window.maxChunkX,
      minChunkZ: window.minChunkZ,
      maxChunkZ: window.maxChunkZ,
    },
    map,
    legend,
  };
}

export function formatViewFrontierResult(result: ViewFrontierResult): string {
  const { view } = result;
  const maps = view.maps ?? { [view.perspective]: view.map };
  const sections = Object.entries(maps).map(
    ([perspective, map]) => `### ${perspective.replaceAll("_", " ")} map\n\n${markdownCodeBlock(map)}`,
  );
  const closest = view.closestFrontier
    ? `chunk ${view.closestFrontier.chunkX},${view.closestFrontier.chunkZ} (${view.closestFrontier.distanceBlocks} blocks, heading ${view.closestFrontier.heading}°)`
    : "None recorded";
  sections.push(
    `### Legend\n\n${view.legend.map((entry) => `- ${entry}`).join("\n")}`,
    [
      "### Map context",
      `- Dimension: \`${view.dimension}\``,
      `- Bot: block \`${view.center.blockX}, ${view.center.blockZ}\`; chunk \`${view.center.chunkX}, ${view.center.chunkZ}\``,
      `- Scale: ${view.window.chunksPerCell} chunk(s) per cell`,
      `- Closest frontier: ${closest}`,
    ].join("\n"),
  );
  if (result.status !== "succeeded") sections.push(`**Observed stop:** ${result.error}`);
  return sections.join("\n\n");
}

/** Bind stored map data and a live status reader into one generic action. */
export function createViewFrontierAction(
  data: SqlBotData,
  status: () => BotStatusSnapshot,
): SqlAction<typeof VIEW_FRONTIER, ViewFrontierRequest, ViewFrontierResult> {
  return defineSqlAction({
    name: VIEW_FRONTIER,
    description: VIEW_FRONTIER_DESCRIPTION,
    inputSchema: viewFrontierInputSchema,
    resultSchema: viewFrontierResultSchema,
    queries: VIEW_FRONTIER_QUERIES,
    formatResult: formatViewFrontierResult,
    execution: { kind: "information" },
    annotations: viewFrontierAnnotations,
    parse: parseViewFrontierRequest,
    execute: async (request) => ({
      status: "succeeded",
      view: viewFrontier(data, status(), request),
      source: sqlActionSource(VIEW_FRONTIER_QUERIES),
    }),
  });
}

function mapWindow(
  centerChunkX: number,
  centerChunkZ: number,
  width: number,
  height: number,
  chunksPerCell: FrontierMapScale,
): MapWindow {
  const centerCellX = floorDivide(centerChunkX, chunksPerCell);
  const centerCellZ = floorDivide(centerChunkZ, chunksPerCell);
  const minCellX = centerCellX - Math.floor(width / 2);
  const minCellZ = centerCellZ - Math.floor(height / 2);
  const maxCellX = minCellX + width - 1;
  const maxCellZ = minCellZ + height - 1;
  return {
    minCellX,
    maxCellX,
    minCellZ,
    maxCellZ,
    minChunkX: minCellX * chunksPerCell,
    maxChunkX: (maxCellX + 1) * chunksPerCell - 1,
    minChunkZ: minCellZ * chunksPerCell,
    maxChunkZ: (maxCellZ + 1) * chunksPerCell - 1,
  };
}

function readChunks(data: SqlBotData, dimension: string, window: MapWindow): ChunkSummary[] {
  return readSqlQuery(
    data,
    frontierMapWindowQuery.bind({
      dimension,
      minChunkX: window.minChunkX - 1,
      maxChunkX: window.maxChunkX + 1,
      minChunkZ: window.minChunkZ - 1,
      maxChunkZ: window.maxChunkZ + 1,
    }),
  );
}

function findUnexploredTarget(
  data: SqlBotData,
  dimension: string,
  chunkX: number,
  chunkZ: number,
): { chunkX: number; chunkZ: number } {
  for (const [deltaX, deltaZ] of CARDINAL_OFFSETS) {
    const unobsX = chunkX + deltaX;
    const unobsZ = chunkZ + deltaZ;
    const rows = readSqlQuery(data, frontierChunkExistsQuery.bind({ dimension, chunkX: unobsX, chunkZ: unobsZ }));
    if (rows.length === 0) {
      return { chunkX: unobsX, chunkZ: unobsZ };
    }
  }
  return { chunkX, chunkZ };
}

function aggregateCells(chunks: readonly ChunkSummary[], window: MapWindow, scale: number): Map<string, MapCell> {
  const cells = new Map<string, MapCell>();
  const cellFor = (chunkX: number, chunkZ: number) => {
    const cellX = floorDivide(chunkX, scale);
    const cellZ = floorDivide(chunkZ, scale);
    const key = cellKey(cellX, cellZ);
    let cell = cells.get(key);
    if (!cell) {
      cell = { observedChunks: 0, surfaceWaterTotal: 0, biomeCounts: new Map(), frontier: false };
      cells.set(key, cell);
    }
    return cell;
  };

  for (const chunk of chunks) {
    if (!insideWindow(chunk.chunkX, chunk.chunkZ, window)) continue;
    const cell = cellFor(chunk.chunkX, chunk.chunkZ);
    cell.observedChunks += 1;
    cell.surfaceWaterTotal += chunk.surfaceWaterFraction;
    if (chunk.dominantBiome) {
      cell.biomeCounts.set(chunk.dominantBiome, (cell.biomeCounts.get(chunk.dominantBiome) ?? 0) + 1);
    }
  }

  // Mark any unobserved cell bordering an observed cell as an unexplored frontier boundary
  const observedCells = [...cells.entries()].filter(([, cell]) => cell.observedChunks > 0);
  for (const [key] of observedCells) {
    const [cellXStr, cellZStr] = key.split("|");
    const cellX = Number(cellXStr);
    const cellZ = Number(cellZStr);
    for (const [deltaX, deltaZ] of CARDINAL_OFFSETS) {
      const neighborCellX = cellX + deltaX;
      const neighborCellZ = cellZ + deltaZ;
      if (
        neighborCellX >= window.minCellX &&
        neighborCellX <= window.maxCellX &&
        neighborCellZ >= window.minCellZ &&
        neighborCellZ <= window.maxCellZ
      ) {
        const neighbor = cellFor(neighborCellX * scale, neighborCellZ * scale);
        if (neighbor.observedChunks === 0) {
          neighbor.frontier = true;
        }
      }
    }
  }
  return cells;
}

function insideWindow(chunkX: number, chunkZ: number, window: MapWindow): boolean {
  return (
    chunkX >= window.minChunkX && chunkX <= window.maxChunkX && chunkZ >= window.minChunkZ && chunkZ <= window.maxChunkZ
  );
}

function assignBiomeSymbols(cells: ReadonlyMap<string, MapCell>): ReadonlyMap<string, string> {
  const biomes = new Set<string>();
  for (const cell of cells.values()) {
    const biome = dominantBiome(cell.biomeCounts);
    if (biome) biomes.add(biome);
  }
  return new Map([...biomes].sort().map((biome, index) => [biome, BIOME_SYMBOLS[index] ?? "*"]));
}

function renderMap(
  cells: ReadonlyMap<string, MapCell>,
  perspective: "biome" | "surface_water",
  width: number,
  chunksPerCell: FrontierMapScale,
  window: MapWindow,
  centerChunkX: number,
  centerChunkZ: number,
  biomeSymbols: ReadonlyMap<string, string>,
  closestFrontier: NearestFrontierTarget | null,
  targetUnexploredChunk: { chunkX: number; chunkZ: number } | null,
): string {
  const centerCellX = floorDivide(centerChunkX, chunksPerCell);
  const centerCellZ = floorDivide(centerChunkZ, chunksPerCell);

  let targetCellX = targetUnexploredChunk ? floorDivide(targetUnexploredChunk.chunkX, chunksPerCell) : null;
  let targetCellZ = targetUnexploredChunk ? floorDivide(targetUnexploredChunk.chunkZ, chunksPerCell) : null;

  // If at higher scales the target chunk falls in a cell with observed chunks,
  // find the adjacent unobserved frontier cell in that direction
  if (targetCellX !== null && targetCellZ !== null) {
    const cell = cells.get(cellKey(targetCellX, targetCellZ));
    if (cell && cell.observedChunks > 0 && targetUnexploredChunk && closestFrontier) {
      const deltaX = Math.sign(targetUnexploredChunk.chunkX - closestFrontier.chunkX);
      const deltaZ = Math.sign(targetUnexploredChunk.chunkZ - closestFrontier.chunkZ);
      const candidateCell = cells.get(cellKey(targetCellX + deltaX, targetCellZ + deltaZ));
      if (candidateCell && candidateCell.observedChunks === 0) {
        targetCellX += deltaX;
        targetCellZ += deltaZ;
      }
    }
  }

  const rows: string[] = [];
  for (let cellZ = window.minCellZ; cellZ <= window.maxCellZ; cellZ += 1) {
    let row = "";
    for (let cellX = window.minCellX; cellX <= window.maxCellX; cellX += 1) {
      if (cellX === centerCellX && cellZ === centerCellZ) {
        row += "@";
        continue;
      }
      const cell = cells.get(cellKey(cellX, cellZ));
      if (!cell || cell.observedChunks === 0) {
        if (targetCellX !== null && targetCellZ !== null && cellX === targetCellX && cellZ === targetCellZ) {
          row += "!";
        } else {
          row += cell?.frontier ? "?" : " ";
        }
      } else if (perspective === "surface_water") {
        row += waterSymbol(cell.surfaceWaterTotal / cell.observedChunks);
      } else {
        const biome = dominantBiome(cell.biomeCounts);
        row += biome ? (biomeSymbols.get(biome) ?? "*") : ".";
      }
    }
    rows.push(`|${row}|`);
  }
  const border = `+${"-".repeat(width)}+`;
  const frontierLine = closestFrontier
    ? `nearest frontier: chunk ${closestFrontier.chunkX},${closestFrontier.chunkZ} (${closestFrontier.distanceBlocks}m, heading ${closestFrontier.heading}°)`
    : "no unexplored frontier recorded";
  return [
    `${perspective} | bot chunk ${centerChunkX},${centerChunkZ} | ${chunksPerCell} chunk(s)/cell`,
    `chunks x ${window.minChunkX}..${window.maxChunkX}, z ${window.minChunkZ}..${window.maxChunkZ} (east right, south down)`,
    frontierLine,
    border,
    ...rows,
    border,
  ].join("\n");
}

function legendFor(perspective: "biome" | "surface_water", symbols: ReadonlyMap<string, string>): string[] {
  const shared = [
    "@ = bot",
    "! = nearest unexplored frontier",
    "? = unobserved frontier",
    "blank = outside remembered map",
  ];
  if (perspective === "surface_water") {
    return [...shared, ". = <10% water", ": = 10-34% water", "~ = 35-69% water", "W = 70%+ water"];
  }
  const biomeLegend = [...symbols].map(([biome, symbol]) => `${symbol} = ${biome}`);
  const biomeMeaning = "biome symbols = dominant sampled vertical biome";
  if (biomeLegend.some((entry) => entry.startsWith("* ="))) {
    return [
      ...shared,
      biomeMeaning,
      ". = observed chunk without a named biome",
      ...biomeLegend.filter((entry) => !entry.startsWith("* =")),
      "* = additional biome",
    ];
  }
  return [...shared, biomeMeaning, ". = observed chunk without a named biome", ...biomeLegend];
}

function dominantBiome(counts: ReadonlyMap<string, number>): string | null {
  let best: readonly [string, number] | null = null;
  for (const entry of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
    if (!best || entry[1] > best[1]) best = entry;
  }
  return best?.[0] ?? null;
}

function waterSymbol(fraction: number): string {
  if (fraction < 0.1) return ".";
  if (fraction < 0.35) return ":";
  if (fraction < 0.7) return "~";
  return "W";
}

function numeric(row: SqlBotDataRow, column: string): number {
  const value = row[column];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError(`Expected numeric ${column} in frontier map data.`);
  }
  return Number(value);
}

function floorDivide(value: number, divisor: number): number {
  return Math.floor(value / divisor);
}

function cellKey(x: number, z: number): string {
  return `${x}|${z}`;
}
