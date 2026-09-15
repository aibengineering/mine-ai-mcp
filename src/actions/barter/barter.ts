import { barterCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { createMovements, nearEntityGoal, type NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { armSignal, waitForSignal } from "../../utils/signals.js";
import { hasInventorySpaceFor } from "../../world/inventory-capacity.js";
import { carriedCount } from "../../world/inventory-count.js";
import { DROPPED_ITEM_OBSERVATION_EVENTS, droppedItemName, pickupObservedItem } from "../../world/item-pickup.js";
import { observeMobAge } from "../../world/mob-age.js";
import { defineAction, type RequestExecution } from "../action.js";
import {
  BARTER,
  BARTER_DESCRIPTION,
  barterInputSchema,
  barterResultSchema,
  type BarterRequest,
  type BarterResult,
} from "./contract.js";

// The existing item/slot acknowledgement budget also bounds an offer the server
// did not acknowledge. Admiration itself waits for equipment, not elapsed time.
const ACKNOWLEDGEMENT_MS = 1_500;
type Exchange = {
  phase: "offered" | "accepted";
  goldBefore: number;
  spent: boolean;
  knownDrops: Set<number>;
  outputObserved: boolean;
};

function piglin(bot: Bot, id: number) {
  const entity = bot.entities[id];
  if (!entity?.isValid || entity.name !== "piglin") throw new Error(`Piglin #${id} is not loaded and valid.`);
  if (observeMobAge(bot, entity) !== "adult") throw new Error(`Piglin #${id} is not observed to be an adult.`);
  return entity;
}

/** One admitted request retains its inventory target and every reserved gold offer. */
export function beginBarter(
  bot: Bot,
  navigation: NavigationRuntime,
  request: BarterRequest,
  lifetime: AbortSignal,
): RequestExecution<BarterResult> {
  lifetime.throwIfAborted();
  const inventoryBefore = carriedCount(bot, request.item_name);
  const desiredItems = new Set([request.item_name]);
  const capacityStop = (offeredGoldCount: number) =>
    hasInventorySpaceFor(bot.inventory, desiredItems) || offeredGoldCount === 1
      ? null
      : `Inventory has no free slot or compatible partial stack for ${request.item_name}; no further gold was offered.`;
  let goldOffers = 0;
  let goldSpent = 0;
  let exchange: Exchange | null = null;
  const observeGold = () => {
    if (exchange && !exchange.spent && carriedCount(bot, "gold_ingot") === exchange.goldBefore - 1) {
      exchange.spent = true;
      goldSpent += 1;
    }
  };
  const observeOutput = () => {
    const recipient = bot.entities[request.piglin_id];
    const pending = exchange;
    if (!pending || !recipient?.isValid) return;
    pending.outputObserved ||= Object.values(bot.entities).some((entity) => {
      const name = droppedItemName(entity);
      return (
        entity.isValid &&
        !pending.knownDrops.has(entity.id) &&
        name !== null &&
        name !== "gold_ingot" &&
        entity.position.distanceTo(recipient.position) <= 4
      );
    });
  };
  const result = (error?: string): BarterResult => {
    observeGold();
    const inventoryAfter = carriedCount(bot, request.item_name);
    const gained = Math.max(0, inventoryAfter - inventoryBefore);
    const barter = {
      piglinId: request.piglin_id,
      item: request.item_name,
      requested: request.count,
      inventoryBefore,
      inventoryAfter,
      gained,
      goldBudget: request.gold_budget,
      goldOffers,
      goldSpent,
    };
    return gained >= request.count
      ? { status: "succeeded", barter }
      : {
          status: gained > 0 || goldOffers > 0 ? "partial" : "failed",
          error: error ?? "Requested item quantity was not observed.",
          barter,
        };
  };
  const satisfied = () => carriedCount(bot, request.item_name) - inventoryBefore >= request.count;

  // The piglin keeps exchanging while a reflex owns the body. These passive
  // observations belong to the admitted request, not its physical attempts.
  bot.inventory.on("updateSlot", observeGold);
  for (const event of DROPPED_ITEM_OBSERVATION_EVENTS) bot.on(event, observeOutput);
  lifetime.addEventListener(
    "abort",
    () => {
      observeGold();
      bot.inventory.off("updateSlot", observeGold);
      for (const event of DROPPED_ITEM_OBSERVATION_EVENTS) bot.off(event, observeOutput);
    },
    { once: true },
  );

  return async (context) => {
    context.observeProgress?.(() => ({ baseline: { inventory: inventoryBefore },
      checkpoint: { phase: exchange?.phase ?? "collecting_or_approaching", gained: carriedCount(bot, request.item_name) - inventoryBefore,
        requested: request.count, goldOffers, goldSpent, goldBudget: request.gold_budget },
      completion: { kind: "current", observed: satisfied(), owes: "Requested net inventory gain remains carried after exchange and pickup." },
    }));
    try {
      if (!bot.registry.itemsByName[request.item_name]) return result(`Unknown item ${request.item_name}.`);
      const desiredDrop = () =>
        Object.values(bot.entities)
          .filter((entity) => entity.isValid && droppedItemName(entity) === request.item_name)
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0];
      const collect = async () => {
        while (!satisfied()) {
          context.signal?.throwIfAborted();
          const item = desiredDrop();
          if (!item) return;
          const before = carriedCount(bot, request.item_name);
          const pickup = await pickupObservedItem(bot, {
            entityId: item.id,
            navigate: navigation.navigate,
            movements: createMovements(bot),
            hasArrived: () => carriedCount(bot, request.item_name) > before,
            signal: context.signal,
          });
          if (pickup.kind === "inventory_full") throw new Error(pickup.reason);
          if (pickup.kind === "not_collected")
            throw new Error(
              `Could not collect observed ${request.item_name} #${item.id}: ${pickup.route.status === "stopped" ? pickup.route.reason : "inventory gain was not observed"}.`,
            );
        }
      };
      while (!satisfied()) {
        await collect();
        if (satisfied()) return result();
        context.signal?.throwIfAborted();
        let target = piglin(bot, request.piglin_id);
        if (!exchange) {
          if (goldOffers >= request.gold_budget)
            return result("Gold offer budget exhausted before the requested items were carried.");
          if (target.equipment[1]?.name === "gold_ingot")
            return result("The selected piglin is already holding gold; no offer was made.");
          const gold = bot.inventory.items().find((item) => item.name === "gold_ingot");
          if (!gold) return result("No gold ingot is carried.");
          const full = capacityStop(gold.count);
          if (full) return result(full);
          if (target.position.distanceTo(bot.entity.position) > 2) {
            const route = await navigation.navigate({
              movements: createMovements(bot),
              goal: nearEntityGoal({ id: target.id }, 2),
              signal: context.signal,
            });
            target = piglin(bot, request.piglin_id);
            if (target.position.distanceTo(bot.entity.position) > 2)
              return result(
                `Could not reach the selected piglin: ${route.status === "stopped" ? route.reason : "still outside interaction reach"}.`,
              );
          }
          await bot.equip(gold, "hand");
          context.signal?.throwIfAborted();
          // A pickup can leave part of its stack behind, and another desired
          // drop can become readable while approaching or equipping.
          if (satisfied() || desiredDrop()) continue;
          target = piglin(bot, request.piglin_id);
          if (target.equipment[1]?.name === "gold_ingot" || target.position.distanceTo(bot.entity.position) > 2)
            return result("The piglin moved or started another exchange before the offer.");
          // Consuming the last ingot in the actual hand also makes one pickup slot.
          const nowFull = capacityStop(bot.heldItem?.name === "gold_ingot" ? bot.heldItem.count : 0);
          if (nowFull) return result(nowFull);
          exchange = {
            phase: "offered",
            goldBefore: carriedCount(bot, "gold_ingot"),
            spent: false,
            knownDrops: new Set(
              Object.values(bot.entities)
                .filter((entity) => droppedItemName(entity) !== null)
                .map((entity) => entity.id),
            ),
            outputObserved: false,
          };
          goldOffers += 1; // Reserve before the native operation: an interrupted offer is never repeated.
          await bot.activateEntity(target);
        }
        observeGold();
        const current = exchange;
        if (current.phase === "offered") {
          const accepted = await waitForSignal(
            () => {
              const recipient = bot.entities[request.piglin_id];
              observeGold();
              return !recipient?.isValid
                ? "gone"
                : current.spent && recipient.equipment[1]?.name === "gold_ingot"
                  ? "accepted"
                  : null;
            },
            [bot, bot.inventory],
            ["entityEquip", "entityGone", "updateSlot"],
            { timeoutMs: ACKNOWLEDGEMENT_MS, context },
          );
          context.signal?.throwIfAborted();
          if (accepted !== "accepted")
            return result("Gold offer acceptance was not observed; the reserved offer will not be repeated.");
          current.phase = "accepted";
        }
        // A held ingot is the observed exchange lifecycle. There is no timeout
        // that pretends a barter completed; cancellation and target loss end the wait.
        const completed = armSignal(
          bot,
          ["entityEquip", "entityGone"],
          () => {
            const recipient = bot.entities[request.piglin_id];
            return !recipient?.isValid ? "gone" : recipient.equipment[1]?.name !== "gold_ingot" ? "completed" : null;
          },
          { context },
        );
        try {
          const outcome = await completed.promise;
          context.signal?.throwIfAborted();
          if (outcome.kind !== "signalled" || outcome.value === "gone")
            return result("The selected piglin disappeared before exchange completion was observed.");
        } finally {
          completed.cancel();
        }
        observeOutput();
        await collect();
        if (satisfied()) return result();
        const output = await waitForSignal(
          () => {
            observeOutput();
            return current.outputObserved ? true : null;
          },
          bot,
          [...DROPPED_ITEM_OBSERVATION_EVENTS],
          { timeoutMs: ACKNOWLEDGEMENT_MS, context },
        );
        context.signal?.throwIfAborted();
        if (!output)
          return result(
            "The piglin released its gold, but no new nearby item output was observed; no further offer was made.",
          );
        exchange = null;
        await collect();
      }
      return result();
    } catch (cause) {
      return result(cause instanceof Error ? cause.message : String(cause));
    } finally {
      observeGold();
    }
  };
}

export function createBarterAction(bot: Bot, navigation: NavigationRuntime) {
  return defineAction({
    checkpointSchema: barterCheckpointSchema,
    name: BARTER,
    description: BARTER_DESCRIPTION,
    inputSchema: barterInputSchema,
    resultSchema: barterResultSchema,
    parse: (input: unknown) => barterInputSchema.parse(input),
    execution: { kind: "resumable_task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: { destructiveHint: true, idempotentHint: false, openWorldHint: false },
    begin: (request, lifetime) => beginBarter(bot, navigation, request, lifetime),
    formatResult: (result) =>
      `Carried ${result.barter.item} +${result.barter.gained}/${result.barter.requested} (inventory ${result.barter.inventoryBefore} → ${result.barter.inventoryAfter}). Gold spent ${result.barter.goldSpent}; offers ${result.barter.goldOffers}/${result.barter.goldBudget}; piglin #${result.barter.piglinId}.${result.status === "succeeded" ? "" : `\nObserved stop: ${result.error}`}`,
  });
}
