import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { armSignal, asVec3, type Position3 } from "../utils/index.js";
import { itemPickupGoal, type MovementPolicy, type Navigate, type NavigationResult } from "../navigation/index.js";
import { withinItemPickupReach } from "../navigation/world/item-geometry.js";
import { hasInventorySpaceFor } from "./inventory-capacity.js";

/** How long inventory settlement gets when an observed item entity is already gone. */
const ITEM_GONE_SETTLE_MS = 1_500;
/** How long to keep waiting after Pathfinder reaches a pickup stance. */
const PICKUP_SETTLE_MS = 900;

/** Events that can first make a newly spawned dropped item identifiable. */
export const DROPPED_ITEM_OBSERVATION_EVENTS = ["entitySpawn", "entityUpdate", "itemDrop"] as const;

export interface ObservedItemPickupOptions {
  readonly entityId: number;
  /** Bound navigation for the bot being driven. */
  readonly navigate: Navigate;
  readonly movements: MovementPolicy;
  readonly hasArrived: () => boolean;
  readonly signal?: AbortSignal;
  /** Optional caller-owned patience for a route with a concrete local bound. */
  readonly timeoutMs?: number;
  /** How long inventory settlement gets once the item is gone, and after reaching a pickup stance. */
  readonly settleMs?: { readonly itemGone?: number; readonly pickup?: number };
}

export type ObservedItemPickupResult =
  | { readonly kind: "collected" }
  | { readonly kind: "inventory_full"; readonly reason: string }
  | { readonly kind: "item_gone" }
  | { readonly kind: "not_collected"; readonly route: NavigationResult };

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

/** Follow one observed item until inventory proves pickup or the attempt settles. */
export async function pickupObservedItem(
  bot: Bot,
  options: ObservedItemPickupOptions,
): Promise<ObservedItemPickupResult> {
  const pickup = armSignal(bot.inventory, "updateSlot", () => options.hasArrived() || null, {
    context: { signal: options.signal },
  });
  const itemGoneMs = options.settleMs?.itemGone ?? ITEM_GONE_SETTLE_MS;
  const pickupMs = options.settleMs?.pickup ?? PICKUP_SETTLE_MS;

  try {
    if (options.hasArrived()) return { kind: "collected" };

    const entity = bot.entities[options.entityId];
    if (!entity?.position) {
      const settlement = await pickup.settle(itemGoneMs);
      options.signal?.throwIfAborted();
      return settlement.kind === "signalled" ? { kind: "collected" } : { kind: "item_gone" };
    }

    const capacityFailure = (): Extract<ObservedItemPickupResult, { kind: "inventory_full" }> | null => {
      const current = bot.entities[options.entityId];
      const name = current ? droppedItemName(current) : null;
      return name && !hasInventorySpaceFor(bot.inventory, new Set([name]))
        ? { kind: "inventory_full", reason: `[INVENTORY_FULL] No free slot or matching stack space for observed ${name} #${options.entityId}.` }
        : null;
    };
    const beforeWalk = capacityFailure();
    if (beforeWalk) return beforeWalk;

    const routeAbort = new AbortController();
    const walk = options.navigate({
      movements: options.movements,
      goal: itemPickupGoal({ id: entity.id }),
      onArrival: async ({ signal }) => {
        const settlement = await pickup.settle(pickupMs);
        if (signal.aborted || settlement.kind === "signalled" || options.hasArrived()) return { kind: "completed" };
        const current = bot.entities[options.entityId];
        // A newly dropped item can roll out of reach before its pickup delay
        // expires. Keep the terrain-aware route alive to follow that movement.
        if (current && !withinItemPickupReach(bot.entity.position, current)) return { kind: "continue" };
        return { kind: "completed" };
      },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      stopSignal: routeAbort.signal,
      // A dropped item can move or despawn while search is running. Keep route
      // planning responsive while the live goal follows it.
      searchLimits: { primaryTimeoutMs: 100 },
    });
    const finished = await Promise.race([
      pickup.promise.then((outcome) => ({ kind: "pickup" as const, outcome })),
      walk.then((route) => ({ kind: "walk" as const, route })),
    ]);

    let route: NavigationResult;
    if (finished.kind === "pickup") {
      routeAbort.abort("pickup_observed");
      route = await walk;
    } else {
      route = finished.route;
    }
    options.signal?.throwIfAborted();

    if ((finished.kind === "pickup" && finished.outcome.kind === "signalled") || options.hasArrived()) {
      return { kind: "collected" };
    }
    if (!bot.entities[options.entityId]) {
      const settlement = await pickup.settle(itemGoneMs);
      options.signal?.throwIfAborted();
      return settlement.kind === "signalled" ? { kind: "collected" } : { kind: "item_gone" };
    }

    const afterWalk = capacityFailure();
    if (afterWalk) return afterWalk;
    if (route.status === "stopped") {
      const settlement = await pickup.settle(pickupMs);
      options.signal?.throwIfAborted();
      if (settlement.kind === "signalled") return { kind: "collected" };
      return bot.entities[options.entityId] ? { kind: "not_collected", route } : { kind: "item_gone" };
    }

    return { kind: "not_collected", route };
  } finally {
    pickup.cancel();
  }
}
