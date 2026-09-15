import type { SqlBotData } from "./sql-bot-data.js";

export interface ContainerLocation {
  readonly dimension: string;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ContainerContent {
  readonly slot: number;
  readonly item: string;
  readonly count: number;
}

export interface ContainerObservation extends ContainerLocation {
  readonly blockName: string;
  readonly slotCount: number;
  readonly contents: readonly ContainerContent[];
  readonly observedByBotId: string;
  readonly observedAt: string;
}

export function containerKey(location: ContainerLocation): string {
  return `${location.dimension}|${location.x}|${location.y}|${location.z}`;
}

/** Replace one location's memory with one complete, atomic observation. */
export function recordContainerObservation(data: SqlBotData, observation: ContainerObservation): void {
  data.transaction((database) => {
    database
      .prepare(`
        INSERT INTO observed_containers (
          container_key, dimension, block_x, block_y, block_z, block_name,
          slot_count, contents_json, observed_by_bot_id, observed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (container_key) DO UPDATE SET
          block_name = excluded.block_name,
          slot_count = excluded.slot_count,
          contents_json = excluded.contents_json,
          observed_by_bot_id = excluded.observed_by_bot_id,
          observed_at = excluded.observed_at
      `)
      .run(
        containerKey(observation),
        observation.dimension,
        observation.x,
        observation.y,
        observation.z,
        observation.blockName,
        observation.slotCount,
        JSON.stringify(observation.contents),
        observation.observedByBotId,
        observation.observedAt,
      );
  }, { name: "recordContainerObservation" });
}

/** Forget a location only after the loaded world directly shows it is no longer a supported container. */
export function forgetContainerObservation(data: SqlBotData, location: ContainerLocation): void {
  data.transaction((database) => {
    database.prepare("DELETE FROM observed_containers WHERE container_key = ?").run(containerKey(location));
  }, { name: "forgetContainerObservation" });
}
