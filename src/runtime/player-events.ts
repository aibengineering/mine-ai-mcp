import type { Bot, BotEvents } from "mineflayer";
import { createRequire } from "node:module";
import { recordEvent, type SqlBotData } from "../bot-data/index.js";

type PlayerMessageListener = BotEvents["chat"];
type DeathListener = BotEvents["death"];
type ChatMessageLoader = (registry: unknown) => { fromNotch(message: unknown): { toString(): string } };

// prismarine-chat is the CommonJS loader Mineflayer itself renders chat with;
// its typings declare a default export the module does not actually make.
const loadChatMessage = createRequire(import.meta.url)("prismarine-chat") as ChatMessageLoader;

/**
 * The server names what killed the player in the combat-death packet, which
 * arrives a moment before the death itself. Rendered through the client's
 * own language table so it reads as the chat line does: "drowned", "was
 * slain by Zombie", "tried to swim in lava".
 */
export function deathMessage(bot: Bot, message: unknown): string | null {
  try {
    const text = loadChatMessage(bot.registry).fromNotch(message).toString().trim();
    return text.length > 0 ? text : null;
  } catch {
    return null;
  }
}
type CancelForegroundAction = (reason: string) => unknown;

/** Persist queryable player events for the lifetime of one connected runtime. */
export function observePlayerEvents(
  bot: Bot,
  data: SqlBotData,
  cancelForegroundAction: CancelForegroundAction,
): () => void {
  const observeMessage =
    (channel: "chat" | "whisper"): PlayerMessageListener =>
    (username, message) => {
      const direction = username.toLowerCase() === bot.username.toLowerCase() ? "outgoing" : "incoming";
      recordEvent(data, bot.username, {
        type: "player_message",
        observedAt: new Date().toISOString(),
        summary: `${username}: ${message}`,
        payload: {
          username,
          channel,
          direction,
          message,
          addressed: direction === "incoming" && addressesUsername(message, bot.username),
        },
      });
    };

  const onChat = observeMessage("chat");
  const onWhisper = observeMessage("whisper");
  let lastDeathMessage: string | null = null;
  const onCombatDeath = (packet: { playerId?: number; message?: unknown }) => {
    if (packet.playerId !== undefined && packet.playerId !== bot.entity?.id) return;
    lastDeathMessage = deathMessage(bot, packet.message);
  };
  const onDeath: DeathListener = () => {
    const position = {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z,
    };
    const dimension = bot.game.dimension;
    const observedAt = new Date().toISOString();
    const cause = lastDeathMessage;
    lastDeathMessage = null;
    const summary = `${bot.username} died at ${position.x}, ${position.y}, ${position.z} in ${dimension}${cause ? `: ${cause}` : ""}.`;

    cancelForegroundAction(`${bot.username} died${cause ? `: ${cause}` : ""}.`);
    recordEvent(data, bot.username, {
      type: "player_death",
      observedAt,
      summary,
      payload: { dimension, position, cause },
    });
  };

  // Respawn updates the dimension before the destination position packet.
  // Record arrival only when forcedMove observes that new position.
  let dimension = bot.game.dimension;
  let crossing: { from: string; to: string } | null = null;
  const onRespawn = () => {
    if (bot.game.dimension === dimension) return;
    crossing = { from: dimension, to: bot.game.dimension };
    dimension = bot.game.dimension;
  };
  const onForcedMove = () => {
    if (crossing === null) return;
    const { from, to } = crossing;
    crossing = null;
    const position = {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z,
    };
    recordEvent(data, bot.username, {
      type: "player_dimension_change",
      observedAt: new Date().toISOString(),
      summary: `${bot.username} arrived in ${to} from ${from}.`,
      payload: { from, to, position },
    });
  };

  bot.on("chat", onChat);
  bot.on("whisper", onWhisper);
  bot.on("death", onDeath);
  bot.on("respawn", onRespawn);
  bot.on("forcedMove", onForcedMove);
  bot._client?.on("death_combat_event", onCombatDeath);

  return () => {
    bot._client?.removeListener("death_combat_event", onCombatDeath);
    bot.off("respawn", onRespawn);
    bot.off("forcedMove", onForcedMove);
    bot.off("death", onDeath);
    bot.off("whisper", onWhisper);
    bot.off("chat", onChat);
  };
}

function addressesUsername(message: string, username: string): boolean {
  const words = message.toLowerCase().split(/[^a-z0-9_]+/u);
  return words.includes(username.toLowerCase());
}
