import type { Bot } from "mineflayer";
import { ATTACK_DRAGON_PERCH } from "../actions/attack-dragon-perch/contract.js";
import { PREPARE_DRAGON_PERCH } from "../actions/prepare-dragon-perch/contract.js";
import { DESTROY_END_CRYSTAL } from "../actions/destroy-end-crystal/contract.js";
import { COLLECT_MOB_DROP } from "../actions/hunt-mob/contract.js";
import type { ActionRunner } from "../session/action-runner.js";
import { onCombatResourceReceipt } from "./combat-resource-receipts.js";

const COMBAT_ACTIONS = new Set<string>([COLLECT_MOB_DROP, DESTROY_END_CRYSTAL, ATTACK_DRAGON_PERCH, PREPARE_DRAGON_PERCH]);
type PendingShot = { readonly scope: string; readonly arrows: number; readonly at: number };
function count(bot: Bot, name: string): number {
  return bot.inventory.items().filter((item) => item.name === name).reduce((sum, item) => sum + item.count, 0);
}

/** One connection observer correlates owned effects with native receipts. */
export function observeCombatResourceEvents(bot: Bot, runner: ActionRunner): () => void {
  let pendingShot: PendingShot | null = null;
  let lastWeapon = bot.heldItem?.name ?? null;
  let damageReceiptAt = 0;
  let damageReceipt = 0;
  let damageScope: string | null = null;
  const durabilitySeen = new Set<string>();
  const armDurability = () => {
    damageScope = runner.combatResourceScope();
    if (!damageScope) return;
    damageReceiptAt = Date.now(); damageReceipt++; durabilitySeen.clear();
  };
  const combatActive = () => {
    const ownership = runner.ownership();
    const active = runner.status().activeAction;
    return ownership.current === "hostile_reflex" || ownership.current === "dragon_reflex" ||
      (active !== null && COMBAT_ACTIONS.has(active.action));
  };
  const receipt = onCombatResourceReceipt(bot, (event) => {
    const scope = runner.combatResourceScope();
    if (!scope || !combatActive()) return;
    if (event.kind === "arrow_release_command") pendingShot = { scope, arrows: count(bot, "arrow"), at: Date.now() };
    else runner.recordScopedCombatResource(scope, { kind: event.kind });
  });
  const updateSlot = (slot: number, oldItem: Bot["heldItem"], newItem: Bot["heldItem"]) => {
    const nextArrows = count(bot, "arrow");
    const currentScope = runner.combatResourceScope();
    if (pendingShot && (pendingShot.scope !== currentScope || Date.now() - pendingShot.at > 1_500)) pendingShot = null;
    if (pendingShot && nextArrows < pendingShot.arrows) {
      runner.recordScopedCombatResource(pendingShot.scope, { kind: "arrow_fired" });
      pendingShot = null;
      armDurability();
    }
    if (!combatActive() || damageScope !== currentScope || Date.now() - damageReceiptAt > 500 || !oldItem || !newItem ||
      oldItem.name !== newItem.name || !Number.isInteger(oldItem.durabilityUsed) || !Number.isInteger(newItem.durabilityUsed) ||
      newItem.durabilityUsed <= oldItem.durabilityUsed) return;
    const receiptKey = `${damageReceipt}:${slot}:${newItem.name}`;
    if (durabilitySeen.has(receiptKey)) return;
    durabilitySeen.add(receiptKey);
    runner.recordCombatResource({ kind: "durability_used", slot, item: newItem.name,
      before: oldItem.durabilityUsed, now: newItem.durabilityUsed });
  };
  const damage = (packet: { entityId?: number; sourceCauseId?: number }) => {
    if (combatActive() && (packet.entityId === bot.entity.id || packet.sourceCauseId === bot.entity.id + 1)) armDurability();
  };
  const status = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId !== bot.entity.id || packet.entityStatus !== 29 || !combatActive()) return;
    armDurability();
    runner.recordCombatResource({ kind: "shield_block" });
  };
  const playerCollect = (collector: Bot["entity"], collected: Bot["entity"]) => {
    if (collector.id !== bot.entity.id || !combatActive()) return;
    try {
      const stack = collected.name === "item" ? collected.getDroppedItem() : null;
      const amountCollected = collected.name === "arrow" || collected.name === "spectral_arrow" ? 1
        : stack?.name === "arrow" ? stack.count : 0;
      for (let amount = 0; amount < amountCollected; amount++)
        runner.recordCombatResource({ kind: "arrow_recovered" });
    } catch { /* A despawned entity is not recovery evidence. */ }
  };
  const heldChanged = () => {
    const next = bot.heldItem?.name ?? null;
    if (combatActive() && next !== lastWeapon) runner.recordCombatResource({
      kind: "weapon_changed", from: lastWeapon, to: next, reason: "observed during combat",
    });
    lastWeapon = next;
  };
  bot.inventory.on("updateSlot", updateSlot);
  bot.on("heldItemChanged", heldChanged);
  bot.on("playerCollect", playerCollect);
  bot._client.on("damage_event", damage);
  bot._client.on("entity_status", status);
  return () => {
    receipt(); pendingShot = null;
    bot.inventory.off("updateSlot", updateSlot);
    bot.off("heldItemChanged", heldChanged);
    bot.off("playerCollect", playerCollect);
    bot._client.off("damage_event", damage);
    bot._client.off("entity_status", status);
  };
}
