import { equipCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { isDeepStrictEqual } from "node:util";
import { defineAction, type ActionContext } from "../action.js";
import {
  equipAnnotations,
  equipOutcomes,
  parseEquipRequest,
  EQUIP,
  EQUIP_DESCRIPTION,
  equipInputSchema,
  equipResultSchema,
  type EquipEvidence,
  type EquipmentDestination,
  type EquipmentSlots,
  type EquipRequest,
  type EquipResult,
} from "./contract.js";

function equippedItem(bot: Bot, destination: EquipmentDestination) {
  return destination === "hand" ? bot.heldItem : bot.inventory.slots[bot.getEquipmentDestSlot(destination)];
}

function slot(bot: Bot, destination: EquipmentDestination): string | null {
  return equippedItem(bot, destination)?.name ?? null;
}

/** Inventory slots and counts can change during equip; the selected item's properties must match. */
function itemProperties(item: NonNullable<ReturnType<typeof equippedItem>>) {
  return structuredClone({
    name: item.name, type: item.type, metadata: item.metadata,
    durabilityUsed: item.durabilityUsed ?? null, nbt: item.nbt,
    // Prismarine exposes 1.20.5+ components at runtime but omits them from Item's declarations.
    components: Reflect.get(item, "components") as unknown,
  });
}

/**
 * Number-key swaps address slots without item merging. Prismarine Item.equal
 * currently ignores modern components, so its ordinary pickup clicks mistake
 * a fresh shield for the worn destination shield and leave the latter in place.
 * Remove this workaround when component-aware pickup clicks pass the native fixture.
 */
async function equipFromSlot(bot: Bot, sourceSlot: number, destination: EquipmentDestination): Promise<void> {
  if (bot.currentWindow) throw new Error("Close the container before selecting a player inventory slot.");
  if (bot.inventory.selectedItem) throw new Error("The inventory cursor must be empty before equipping.");
  const destinationSlot = bot.getEquipmentDestSlot(destination);
  if (sourceSlot === destinationSlot) return;
  if (sourceSlot >= 36 && sourceSlot <= 44) {
    if (destination === "hand") bot.setQuickBarSlot(sourceSlot - 36);
    else await bot.clickWindow(destinationSlot, sourceSlot - 36, 2);
    return;
  }
  const hotbarButton = bot.quickBarSlot;
  await bot.clickWindow(sourceSlot, hotbarButton, 2);
  if (destination === "hand") return;
  // Restore the temporary hand slot and preserve both failures if cleanup also fails.
  await using restoreHand = new AsyncDisposableStack();
  restoreHand.defer(() => bot.clickWindow(sourceSlot, hotbarButton, 2));
  await bot.clickWindow(destinationSlot, hotbarButton, 2);
}

/** What every equipment slot holds right now, by item name. */
export function equipmentSlots(bot: Bot): EquipmentSlots {
  return {
    hand: bot.heldItem?.name ?? null,
    offHand: slot(bot, "off-hand"),
    head: slot(bot, "head"),
    torso: slot(bot, "torso"),
    legs: slot(bot, "legs"),
    feet: slot(bot, "feet"),
  };
}

/** Equip each requested item in turn and report what every slot holds afterwards. */
export async function equip(
  bot: Bot,
  request: EquipRequest,
  context: ActionContext,
): Promise<EquipResult> {
  const equipped: EquipEvidence["equipped"] = [];
  context.observeProgress?.(() => ({
    baseline: null,
    checkpoint: { phase: "equipping", completed: equipped.filter((entry) => entry.equipped).length,
      requested: request.items.length, equipment: { ...equipmentSlots(bot) } },
    completion: { kind: "current", observed: equipped.length === request.items.length && equipped.every((entry) => entry.equipped),
      owes: "Every requested equipment operation confirmed in its destination slot." },
  }));
  for (const { itemName, destination, sourceSlot } of request.items) {
    context.signal?.throwIfAborted();
    if (sourceSlot === undefined && slot(bot, destination) === itemName) {
      equipped.push({ item: itemName, destination, equipped: true });
      continue;
    }
    const item = sourceSlot === undefined
      ? bot.inventory.items().find((candidate) => candidate.name === itemName)
      : bot.inventory.slots[sourceSlot];
    if (sourceSlot !== undefined && item?.name !== itemName) {
      equipped.push({ item: itemName, destination, sourceSlot, equipped: false,
        error: equipOutcomes.sourceMismatch(itemName, sourceSlot, item?.name ?? null) });
      continue;
    }
    if (!item) {
      equipped.push({ item: itemName, destination, equipped: false, error: equipOutcomes.notCarried(itemName) });
      continue;
    }
    const selectedProperties = itemProperties(item);
    const selection = sourceSlot === undefined ? {} : { sourceSlot, durabilityUsed: item.durabilityUsed ?? null };
    try {
      if (sourceSlot === undefined) await bot.equip(item, destination);
      else await equipFromSlot(bot, sourceSlot, destination);
    } catch (cause) {
      context.signal?.throwIfAborted();
      equipped.push({ item: itemName, destination, ...selection, equipped: false, error: equipOutcomes.rejected(itemName, cause) });
      continue;
    }
    const held = equippedItem(bot, destination);
    if (!held || held.name !== itemName || (sourceSlot !== undefined && !isDeepStrictEqual(itemProperties(held), selectedProperties))) {
      equipped.push({
        item: itemName,
        destination,
        ...selection,
        equipped: false,
        error: equipOutcomes.notObserved(itemName, destination),
      });
      continue;
    }
    equipped.push({ item: itemName, destination, ...selection, equipped: true });
  }

  const evidence: EquipEvidence = { equipped, equipment: equipmentSlots(bot) };
  const failed = equipped.filter((entry) => !entry.equipped).length;
  if (failed === 0) return { status: "succeeded", equip: evidence };
  return {
    status: failed === equipped.length ? "failed" : "partial",
    error: equipOutcomes.incomplete(failed, equipped.length),
    equip: evidence,
  };
}

export function formatEquipResult(result: EquipResult): string {
  const { equip } = result;
  const lines = equip.equipped.map((entry) =>
    entry.equipped
      ? `- Equipped **${entry.item}** in ${entry.destination}${entry.sourceSlot === undefined ? "" : ` from slot ${entry.sourceSlot}${entry.durabilityUsed == null ? "" : ` (${entry.durabilityUsed} durability used)`}`}.`
      : `- Could not equip **${entry.item}** in ${entry.destination}: ${entry.error ?? "unknown"}`,
  );
  const slots = equip.equipment;
  lines.push(
    "",
    `Now holding \`${slots.hand ?? "nothing"}\`; off-hand \`${slots.offHand ?? "nothing"}\`; wearing head \`${slots.head ?? "-"}\`, torso \`${slots.torso ?? "-"}\`, legs \`${slots.legs ?? "-"}\`, feet \`${slots.feet ?? "-"}\`.`,
  );
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createEquipAction(bot: Bot) {
  return defineAction({
    checkpointSchema: equipCheckpointSchema,
    name: EQUIP,
    description: EQUIP_DESCRIPTION,
    inputSchema: equipInputSchema,
    resultSchema: equipResultSchema,
    formatResult: formatEquipResult,
    execution: { kind: "task" },
    annotations: equipAnnotations,
    parse: parseEquipRequest,
    execute: (request, context) => equip(bot, request, context),
  });
}
