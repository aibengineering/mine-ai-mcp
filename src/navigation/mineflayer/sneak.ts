import type { Bot } from "mineflayer";

/**
 * Set the sneak control and tell the server so.
 *
 * Mineflayer 4.37.1 selects the player-input packet for 1.21.4, but on that
 * protocol the server reads it for minecart steering and nothing else: its
 * sneaking flag moves on the client-command packet, and on the sneaking bit
 * Mineflayer stamps on every attack from the control at that instant. So a
 * control set through Mineflayer alone leaves the server ignorant until an
 * attack lands mid-crouch, which latches the server crouched until the next
 * attack says otherwise. Every writer that crouches the body sends the
 * client-command packet here, on every call, so the release always arrives
 * whatever the server believed before. This compatibility write belongs in
 * Mineflayer's setControlState; remove it once the pinned Mineflayer sends the
 * 1.21.4 sneaking action itself.
 */
export function setSneaking(bot: Bot, sneaking: boolean): void {
  bot.setControlState("sneak", sneaking);
  if (bot.version !== "1.21.4") return;
  bot._client.write("entity_action", {
    entityId: bot.entity.id,
    actionId: sneaking ? 0 : 1,
    jumpBoost: 0,
  });
}
