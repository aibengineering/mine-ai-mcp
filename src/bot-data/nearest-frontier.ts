import { updateBotStatus, type BotStatusSnapshot } from "./bot-status.js";
import { defineSqlQuery, readSqlQuery } from "./sql-query.js";
import type { SqlBotData, SqlBotDataRow } from "./sql-bot-data.js";

export const FRONTIER_NAVIGATION_VIEW = "main.frontier_navigation" as const;

export interface NearestFrontierTarget {
  readonly chunkX: number;
  readonly chunkZ: number;
  readonly distanceBlocks: number;
  readonly heading: number;
}

export const nearestFrontierQuery = defineSqlQuery({
  id: "frontier-nearest",
  produces: "The nearest observed frontier chunk for one bot in one dimension, with distance and heading.",
  parameterNames: ["botId", "dimension"] as const,
  sql: `
    SELECT chunk_x, chunk_z, distance_blocks, heading_degrees
    FROM ${FRONTIER_NAVIGATION_VIEW}
    WHERE bot_id = ? AND dimension = ? AND is_frontier = 1
    ORDER BY distance_blocks ASC
    LIMIT 1
  `,
  parseRow: (row): NearestFrontierTarget => ({
    chunkX: finiteNumber(row, "chunk_x"),
    chunkZ: finiteNumber(row, "chunk_z"),
    distanceBlocks: finiteNumber(row, "distance_blocks"),
    heading: finiteNumber(row, "heading_degrees"),
  }),
});

/** Refresh the real bot status, then read its nearest boundary from the canonical navigation view. */
export function refreshNearestFrontier(data: SqlBotData, status: BotStatusSnapshot): NearestFrontierTarget | null {
  updateBotStatus(data, status);
  const row = readSqlQuery(
    data,
    nearestFrontierQuery.bind({ botId: status.botId, dimension: status.dimension }),
  )[0];

  return row ?? null;
}

function finiteNumber(row: SqlBotDataRow, column: string): number {
  const value = Number(row[column]);
  if (!Number.isFinite(value)) {
    throw new TypeError(`${FRONTIER_NAVIGATION_VIEW}.${column} must be a finite number.`);
  }
  return value;
}
