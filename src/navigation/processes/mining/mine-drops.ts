import type { Bot } from "mineflayer";
import { asVec3, cellKey } from "../../../utils/index.js";
import type { BlockPosition } from "../../index.js";
import { withinItemPickupReach } from "../../world/item-geometry.js";
import type { MineRequest, MineTarget } from "./mine-process.js";

/** Associate a just-broken source with its nearby observed item entity. */
const DROP_PROXIMITY_SQUARED = 9;

/**
 * How long a just-broken source remains a provisional drop target.
 *
 * Baritone bounds the same wait with `mineDropLoiterDurationMSThanksLouca` and
 * keeps its expected drops in a map with timestamps. Once an item entity is
 * observed, its live position owns the target instead.
 */
const DROP_LOITER_MS = 250;

/**
 * Mineflayer can apply an item's destroy-entity packet before its inventory
 * packet. This is not Baritone's anticipated-drop timer: it is a separate
 * window in which a vanished entity still represents a pending pickup.
 */
const OBSERVED_DROP_SETTLE_MS = 1_500;

/**
 * How long the bot may overlap a live item's pickup box without an inventory
 * gain before the item is judged one the inventory cannot take.
 *
 * Vanilla holds a block drop back for ten ticks and a tossed item for forty,
 * so an item still lying under the bot well past that is not being delivered.
 * Baritone has no such bound because it has no notion of a full inventory;
 * without one, a drop that never enters held the run at that cell until the
 * server despawned it five minutes later, then mined the next block and did
 * the same again.
 */
export const DROP_PICKUP_TIMEOUT_MS = 3_000;

/** Bridge block removal, item spawn, and inventory packets without aging live drops out. */
export class MineDropTracker {
  readonly #observedDrops = new Map<
    number,
    {
      readonly position: BlockPosition;
      readonly inventoryGainWhenSeen: number;
      readonly disappearedAt?: number;
    }
  >();
  readonly #anticipatedDrops = new Map<string, { readonly position: BlockPosition; readonly expiresAt: number }>();
  /** When the bot began overlapping each live item, and the gain it had then. */
  readonly #touching = new Map<number, { readonly since: number; readonly inventoryGain: number }>();

  constructor(
    private readonly bot: Bot,
    private readonly request: Pick<MineRequest, "observedInventoryGain" | "ignoredDropIds">,
    private readonly droppedBlacklist: ReadonlySet<number>,
    private readonly anticipatedBlacklist: ReadonlySet<string>,
  ) {}

  get anticipating(): boolean {
    return this.#anticipatedDrops.size > 0;
  }

  /** A native tossed/falling item has not reached the cell a pickup route can judge yet. */
  inFlight(entityId: number): boolean {
    const entity = this.bot.entities[entityId];
    if (!entity || !entity.velocity || entity.velocity.y === 0) return false;
    const air = (position: typeof entity.position): boolean => {
      const block = this.bot.blockAt(position.floored());
      return block !== null && ["air", "cave_air", "void_air"].includes(block.name);
    };
    return air(entity.position) && air(entity.position.offset(0, -0.01, 0));
  }

  noteBreak(position: BlockPosition, now: number): void {
    this.#anticipatedDrops.set(cellKey(position), { position, expiresAt: now + DROP_LOITER_MS });
  }

  /** A live item the bot has overlapped for the whole pickup timeout without gaining anything. */
  pickupStalled(entityId: number, now: number): boolean {
    const touching = this.#touching.get(entityId);
    return touching !== undefined && now - touching.since >= DROP_PICKUP_TIMEOUT_MS;
  }

  update(targets: readonly MineTarget[]): MineTarget[] {
    const found = [...targets];
    const observedAt = Date.now();
    // Baritone keeps a just-broken location in `anticipatedDrops` while the
    // server is between its block-change and item-spawn packets. Without that
    // bridge, removing the final requested block briefly invalidates the goal
    // and ends collection before its drop can exist.
    for (const [key, anticipated] of this.#anticipatedDrops) {
      if (anticipated.expiresAt <= observedAt || this.anticipatedBlacklist.has(key)) {
        this.#anticipatedDrops.delete(key);
        continue;
      }

      // Mineflayer publishes the entity before its item-stack metadata on some
      // runs. Baritone's EntityItem is identifiable immediately, so follow the
      // new item entity near this known source while Mineflayer catches up.
      const spawnedItem = Object.values(this.bot.entities ?? {})
        .filter((entity) => entity.name === "item")
        .filter((entity) => !this.droppedBlacklist.has(entity.id) && !this.request.ignoredDropIds?.has(entity.id))
        .filter((entity) => entity.position.distanceSquared(asVec3(anticipated.position)) <= DROP_PROXIMITY_SQUARED)
        .sort(
          (left, right) =>
            left.position.distanceSquared(asVec3(anticipated.position)) -
            right.position.distanceSquared(asVec3(anticipated.position)),
        )[0];
      if (spawnedItem) {
        if (!found.some((target) => target.kind === "drop" && target.entityId === spawnedItem.id)) {
          found.push({ position: spawnedItem.position.floored(), kind: "drop", entityId: spawnedItem.id });
        }
      } else if (!found.some((target) => cellKey(target.position) === key)) {
        found.push({ position: anticipated.position, kind: "anticipated_drop" });
      }
    }

    // Baritone re-derives every live EntityItem on each scan and never ages one
    // into its blacklist. Keep the same entity alive here regardless of age. A
    // drop that vanishes gets a separate settlement state because Mineflayer
    // can apply the destroy-entity packet one tick before its inventory packet.
    for (const target of found) {
      if (target.kind !== "drop") continue;
      this.#observedDrops.set(target.entityId, {
        position: target.position,
        inventoryGainWhenSeen: this.request.observedInventoryGain(),
      });
    }

    // A drop the bot overlaps is either entering the inventory or unable to.
    // The overlap is timed from the last inventory change, so a stack that is
    // still filling from a pile of items is not judged by its first arrival.
    const feet = this.bot.entity?.position;
    const gain = this.request.observedInventoryGain();
    const overlapped = new Set<number>();
    for (const target of found) {
      if (target.kind !== "drop") continue;
      const entity = this.bot.entities[target.entityId];
      if (!feet || !entity || !withinItemPickupReach(feet, entity)) continue;
      overlapped.add(target.entityId);
      const touching = this.#touching.get(target.entityId);
      if (touching === undefined || touching.inventoryGain !== gain) {
        this.#touching.set(target.entityId, { since: observedAt, inventoryGain: gain });
      }
    }
    for (const entityId of this.#touching.keys()) {
      if (!overlapped.has(entityId)) this.#touching.delete(entityId);
    }

    for (const [entityId, observed] of this.#observedDrops) {
      if (this.droppedBlacklist.has(entityId)) {
        this.#observedDrops.delete(entityId);
        continue;
      }
      if (this.bot.entities[entityId]) continue;
      if (this.request.observedInventoryGain() > observed.inventoryGainWhenSeen) {
        this.#observedDrops.delete(entityId);
        continue;
      }

      const disappearedAt = observed.disappearedAt ?? observedAt;
      if (observedAt - disappearedAt >= OBSERVED_DROP_SETTLE_MS) {
        this.#observedDrops.delete(entityId);
        continue;
      }
      this.#observedDrops.set(entityId, { ...observed, disappearedAt });
      found.push({ kind: "settling_drop", position: observed.position, entityId });
    }

    return found;
  }
}
