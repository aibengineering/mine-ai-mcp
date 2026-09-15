import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { SqlBotData } from "../../bot-data/index.js";
import type { Position3 } from "../../utils/index.js";
import { pointSchema } from "./contract.js";

const throwSchema = z.object({
  throw_id: z.string(),
  entity_uuid: z.string().nullable(),
  start_json: z
    .string()
    .transform((text) => pointSchema.parse(JSON.parse(text)))
    .nullable(),
  end_json: z
    .string()
    .transform((text) => pointSchema.parse(JSON.parse(text)))
    .nullable(),
  state: z.enum(["pending", "tracking", "observed", "incomplete"]),
});
export type SavedThrow = z.output<typeof throwSchema>;

/** The database identity supplies the world; every search additionally belongs to one bot and dimension. */
export class StrongholdThrows {
  constructor(
    readonly data: SqlBotData,
    readonly botId: string,
    readonly dimension: string,
    readonly searchId: string,
  ) {}

  read(): SavedThrow[] {
    return this.data
      .read(
        "SELECT * FROM stronghold_throws WHERE bot_id = ? AND dimension = ? AND search_id = ? ORDER BY rowid",
        this.botId,
        this.dimension,
        this.searchId,
      )
      .map((row) => throwSchema.parse(row));
  }

  begin(position: Position3): string {
    const id = randomUUID();
    this.data.transaction((db) =>
      db
        .prepare(
          `INSERT INTO stronghold_throws (throw_id, bot_id, dimension, search_id, thrown_at, throw_position_json, state)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
        )
        .run(id, this.botId, this.dimension, this.searchId, new Date().toISOString(), JSON.stringify(position)), { name: "begin" },
    );
    return id;
  }

  observe(id: string, uuid: string, start: Position3, end: Position3): void {
    const dx = end.x - start.x;
    const dz = end.z - start.z;
    const heading = Math.hypot(dx, dz) >= 1 ? ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360 : null;
    this.data.transaction((db) =>
      db
        .prepare(
          `UPDATE stronghold_throws SET entity_uuid = ?, start_json = ?, end_json = ?, bearing_degrees = ?,
       observed_at = ?, state = 'tracking' WHERE throw_id = ?`,
        )
        .run(uuid, JSON.stringify(start), JSON.stringify(end), heading, new Date().toISOString(), id), { name: "observe" },
    );
  }

  finish(id: string, state: "observed" | "incomplete"): void {
    this.data.transaction((db) =>
      db.prepare("UPDATE stronghold_throws SET state = ? WHERE throw_id = ?").run(state, id), { name: "finish" },
    );
  }
}
