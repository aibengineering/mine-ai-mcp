/** Prove that a live item is pursued while it is still moving. */
import type { ClientCompletion } from "mine-labs/client";
import { createMovements } from "../../../src/navigation/index.ts";
import { pickupObservedItem } from "../../../src/world/item-pickup.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

/** Ten ticks admits normal search startup but not the removed thirty-tick rest gate. */
const IMMEDIATE_PURSUIT_TICKS = 10;
const OBSERVED_MOVEMENT = 0.05;
const PICKUP_TIMEOUT_MS = 30_000;

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  const deadline = Date.now() + 10_000;
  let item = Object.values(bot.entities).find((entity) => entity.name === "item");
  while (!item && Date.now() < deadline) {
    await bot.waitForTicks(1);
    item = Object.values(bot.entities).find((entity) => entity.name === "item");
  }
  if (!item) return { status: "failed", detail: "The moving item was never observed." };

  const before = bot.inventory.count(bot.registry.itemsByName.diamond!.id, null);
  const botStart = bot.entity.position.clone();
  const itemStart = item.position.clone();
  let pickupSettled = false;
  const pickup = pickupObservedItem(bot, {
    entityId: item.id,
    movements: createMovements(bot),
    navigate: context.navigation.navigate,
    hasArrived: () => bot.inventory.count(bot.registry.itemsByName.diamond!.id, null) > before,
    timeoutMs: PICKUP_TIMEOUT_MS,
    signal: context.signal,
  }).finally(() => {
    pickupSettled = true;
  });

  let pursuitTick: number | null = null;
  let itemMoved = false;
  let observedTicks = 0;
  while (!pickupSettled) {
    await bot.waitForTicks(1);
    observedTicks += 1;
    if (bot.entities[item.id]?.position.distanceTo(itemStart) > OBSERVED_MOVEMENT) itemMoved = true;
    if (
      observedTicks <= IMMEDIATE_PURSUIT_TICKS &&
      pursuitTick === null &&
      bot.entity.position.distanceTo(botStart) > OBSERVED_MOVEMENT
    ) {
      pursuitTick = observedTicks;
    }
  }

  const result = await pickup;
  const total = bot.inventory.count(bot.registry.itemsByName.diamond!.id, null);
  const detail = `itemMoved=${itemMoved}, pursuitTick=${pursuitTick ?? "none"}, pickup=${result.kind}, diamonds=${total}; ${context.pathfinder.summary()}`;
  if (!itemMoved) return { status: "failed", detail: `The fixture did not keep its item moving. ${detail}` };
  if (result.kind !== "collected" || total <= before)
    return { status: "failed", detail: `The moving item was not collected. ${detail}` };
  return { status: "succeeded", detail };
}
