import type { Bot } from "mineflayer";
import { createMovements, type NavigationRuntime } from "../../navigation/index.js";
import { armSignal, asVec3, type Position3 } from "../../utils/index.js";
import { carriedCount } from "../../world/watchers/inventory-count.js";
import {
  pickupObservedItem,
  type ObservedItemPickupOptions,
} from "../../navigation/processes/item-pickup.js";
import { DROPPED_ITEM_OBSERVATION_EVENTS, droppedItemName } from "../../world/dropped-items.js";

/** How long a vanished eye's drop gets to become identifiable before recovery gives up on it. */
const EYE_DROP_SETTLE_MS = 1_500;

/**
 * Recovery's settle windows: `drop` for the eye's item to appear, the rest for
 * the pickup that follows. Production omits them; a test shortens them so a
 * missing drop or an unreachable one lapses for real without a long wait.
 */
export type EyeRecoverySettleMs = { readonly drop?: number } & NonNullable<ObservedItemPickupOptions["settleMs"]>;

/** Recover a nearby surviving eye without turning a saved bearing into a long detour. */
export async function recoverEyeDrop(
  bot: Bot,
  navigation: NavigationRuntime,
  endpoint: Position3,
  signal?: AbortSignal,
  { drop: dropSettleMs = EYE_DROP_SETTLE_MS, ...pickupSettleMs }: EyeRecoverySettleMs = {},
) {
  signal?.throwIfAborted();
  if (bot.entity.position.distanceTo(asVec3(endpoint)) > 32) return;
  // The flying eye disappears before its item metadata may arrive. A missing
  // drop is normal (eyes can shatter); never require recovery for a bearing.
  const drop = armSignal(bot, [...DROPPED_ITEM_OBSERVATION_EVENTS], () =>
    Object.values(bot.entities).find((entity) =>
      droppedItemName(entity) === "ender_eye" &&
      Math.hypot(entity.position.x - endpoint.x, entity.position.z - endpoint.z) <= 4 &&
      entity.position.y <= endpoint.y + 2 && entity.position.y >= endpoint.y - 16,
    ), { context: { signal } });
  try {
    const observed = await drop.settle(dropSettleMs);
    signal?.throwIfAborted();
    if (observed.kind !== "signalled") return;
    const before = carriedCount(bot, "ender_eye");
    return await pickupObservedItem(bot, {
      entityId: observed.value.id,
      navigate: navigation.navigate,
      movements: createMovements(bot, { scaffolding: false }),
      hasArrived: () => carriedCount(bot, "ender_eye") > before,
      signal,
      timeoutMs: 15_000,
      settleMs: pickupSettleMs,
    });
  } finally {
    drop.cancel();
  }
}
