import type { Bot } from "mineflayer";
import { createRequire } from "node:module";

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
