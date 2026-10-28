import type { Bot } from "mineflayer";
import { armSignal } from "../../utils/index.js";
import { itemPickupGoal } from "../goals/index.js";
import type { MovementPolicy } from "../movements/policy.js";
import type { Navigate, NavigationResult } from "../navigate.js";
import { stepIntoPickupReach } from "../steering/pickup-approach.js";
import { withinItemPickupReach } from "../world/item-geometry.js";
import { hasInventorySpaceFor } from "../../world/inventory-capacity.js";
import { droppedItemName } from "../../world/dropped-items.js";

/** How long inventory settlement gets when an observed item entity is already gone. */
const ITEM_GONE_SETTLE_MS = 1_500;
/** How long to keep waiting after Pathfinder reaches a pickup stance. */
const PICKUP_SETTLE_MS = 900;

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
        await stepIntoPickupReach(bot, options.entityId, signal);
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
