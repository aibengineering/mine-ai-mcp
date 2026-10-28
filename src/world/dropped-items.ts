import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { asVec3, type Position3 } from "../utils/index.js";

/** Events that can first make a newly spawned dropped item identifiable. */
export const DROPPED_ITEM_OBSERVATION_EVENTS = ["entitySpawn", "entityUpdate", "itemDrop"] as const;

export interface ObservedItemEntity {
  readonly id: number;
  readonly position: Vec3;
}

export interface NewItemEntitySearch {
  readonly baseline: ReadonlySet<number>;
  /** The item wanted; omitted, any readable dropped item counts. */
  readonly itemName?: string;
  readonly source: Position3;
  readonly maxDistance: number;
  /**
   * Items the bot threw away on purpose, which no sweep should undo. Kept apart
   * from `baseline` because that says "already there before this act" while this
   * says "never wanted", and the two are decided by different callers.
   */
  readonly ignoreIds?: ReadonlySet<number>;
}

/** Record entity identity before a physical act so only newly created items are attributed to it. */
export function snapshotEntityIds(bot: Bot): ReadonlySet<number> {
  return new Set(Object.values(bot.entities).map((entity) => entity.id));
}

/** How many items a dropped stack holds; an entity whose stack is not yet known counts as one. */
export function droppedItemCount(entity: Bot["entity"]): number {
  try {
    return entity.getDroppedItem()?.count ?? 1;
  } catch {
    return 1;
  }
}

/** Item metadata can arrive after the entity, so unreadable metadata is not evidence yet. */
export function droppedItemName(entity: Bot["entity"]): string | null {
  try {
    return entity.getDroppedItem()?.name ?? null;
  } catch {
    return null;
  }
}

/** Find the nearest newly observed matching item attributable to one source position. */
export function findNewItemEntity(bot: Bot, search: NewItemEntitySearch): ObservedItemEntity | null {
  const origin = asVec3(search.source);
  return (
    Object.values(bot.entities)
      .filter((entity) => !search.baseline.has(entity.id))
      .filter((entity) => !search.ignoreIds?.has(entity.id))
      .filter((entity) => {
        const name = droppedItemName(entity);
        if (name === null || (search.itemName !== undefined && name !== search.itemName)) return false;
        return entity.position.distanceTo(origin) <= search.maxDistance;
      })
      .sort((a, b) => a.position.distanceTo(origin) - b.position.distanceTo(origin))
      .map((entity) => ({ id: entity.id, position: entity.position.clone() }))[0] ?? null
  );
}
