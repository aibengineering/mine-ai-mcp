import type { Bot } from "mineflayer";

const attached = new WeakSet<Bot>();

/**
 * Vanilla 1.21.4 sends WIN_GAME value 0 on first exit. The pinned Mineflayer
 * game plugin acknowledges only value 1, leaving a living player waiting in
 * the End. Handle the missing value before login; leave value 1 to Mineflayer.
 */
export function acknowledgeEndCredits(bot: Bot): void {
  if (attached.has(bot)) return;
  attached.add(bot);
  const receive = (packet: { reason: number | string; gameMode: number }) => {
    if ((packet.reason === 4 || packet.reason === "win_game") && packet.gameMode === 0)
      bot._client.write("client_command", bot.supportFeature("respawnIsPayload") ? { payload: 0 } : { actionId: 0 });
  };
  bot._client.on("game_state_change", receive);
  bot.once("end", () => {
    bot._client.off("game_state_change", receive);
    attached.delete(bot);
  });
}
