import type {SqlBotData} from './sql-bot-data.js';

export interface LastDeath {
  readonly botId: string;
  readonly dimension: string;
  readonly position: {readonly x: number; readonly y: number; readonly z: number};
  readonly observedAt: string;
  readonly cause: string|null;
}

export function recordLastDeath(data: SqlBotData, death: LastDeath): void {
  data.transaction(
      (database) => database
                        .prepare(
                            `INSERT OR REPLACE INTO bot_last_death (bot_id, dimension, x, y, z, observed_at, cause)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                            )
                        .run(
                            death.botId, death.dimension, death.position.x, death.position.y, death.position.z,
                            death.observedAt, death.cause),
      {name: 'record-last-death'});
}

export function readLastDeath(data: SqlBotData, botId: string): LastDeath|null {
  const row = data.read(
      'SELECT bot_id, dimension, x, y, z, observed_at, cause FROM bot_last_death WHERE bot_id = ?',
      botId,
      )[0];
  return row ? {
    botId: String(row.bot_id),
    dimension: String(row.dimension),
    position: {x: Number(row.x), y: Number(row.y), z: Number(row.z)},
    observedAt: String(row.observed_at),
    cause: row.cause === null ? null : String(row.cause),
  } :
               null;
}
