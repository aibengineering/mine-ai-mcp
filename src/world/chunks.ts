import type { Position3 } from "../utils/index.js";

export const CHUNK_WIDTH = 16;

export interface ChunkPosition {
  readonly chunkX: number;
  readonly chunkZ: number;
}

/** Return the chunk coordinate containing one block coordinate, including west and north of zero. */
export function chunkCoordinate(blockCoordinate: number): number {
  return Math.floor(blockCoordinate / CHUNK_WIDTH);
}

/** Return the chunk containing one horizontal world position. */
export function chunkPosition(position: Pick<Position3, "x" | "z">): ChunkPosition {
  return {
    chunkX: chunkCoordinate(position.x),
    chunkZ: chunkCoordinate(position.z),
  };
}
