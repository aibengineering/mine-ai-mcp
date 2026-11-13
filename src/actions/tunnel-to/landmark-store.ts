import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SqlBotData } from "../../bot-data/index.js";
import type { Position3 } from "../../utils/index.js";
import { pointSchema } from "./contract.js";

const landmarkKindSchema = z.enum(["mouth", "portal_exit"]);
export type LandmarkKind = z.output<typeof landmarkKindSchema>;

const landmarkSchema = z.object({
  landmark_id: z.string(),
  kind: landmarkKindSchema,
  position: z
    .string()
    .transform((text) => pointSchema.parse(JSON.parse(text)))
    .nullable(),
  created_at: z.string(),
});
export type SavedLandmark = z.output<typeof landmarkSchema>;

/**
 * The walkable landmarks of one dug stronghold approach, keyed like the throws
 * beside them: one world database, one bot, one dimension, one named search.
 * There is at most one landmark per kind; re-digging the tunnel overwrites it.
 */
export class StrongholdLandmarks {
  constructor(
    readonly data: SqlBotData,
    readonly botId: string,
    readonly dimension: string,
    readonly searchId: string,
  ) {}

  read(): SavedLandmark[] {
    return this.data
      .read(
        "SELECT landmark_id, kind, position_json AS position, created_at FROM stronghold_landmarks WHERE bot_id = ? AND dimension = ? AND search_id = ? ORDER BY kind",
        this.botId,
        this.dimension,
        this.searchId,
      )
      .map((row) => landmarkSchema.parse(row));
  }

  get(kind: LandmarkKind): SavedLandmark | null {
    return this.read().find((row) => row.kind === kind) ?? null;
  }

  /** Record where a kind of landmark sits, replacing any earlier record of the same kind. */
  set(kind: LandmarkKind, position: Position3): void {
    this.data.transaction(
      (db) =>
        db
          .prepare(
            `INSERT INTO stronghold_landmarks (landmark_id, bot_id, dimension, search_id, kind, position_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (bot_id, dimension, search_id, kind)
       DO UPDATE SET position_json = excluded.position_json, created_at = excluded.created_at`,
          )
          .run(
            randomUUID(),
            this.botId,
            this.dimension,
            this.searchId,
            kind,
            JSON.stringify({ x: position.x, y: position.y, z: position.z }),
            new Date().toISOString(),
          ),
      { name: "set" },
    );
  }
}
