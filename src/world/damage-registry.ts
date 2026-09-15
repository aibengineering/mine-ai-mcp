import type { Bot } from "mineflayer";
import { z } from "zod";

const registryPacket = z.object({
  id: z.literal("minecraft:damage_type"),
  entries: z.array(z.object({ key: z.string() })),
});
const names = new WeakMap<Bot, readonly string[]>();

/** Install before login: registry IDs belong to the connected server, including its data packs. */
export function observeDamageRegistry(bot: Bot): void {
  if (names.has(bot)) return;
  names.set(bot, []);
  const receive = (packet: unknown) => {
    const parsed = registryPacket.safeParse(packet);
    if (parsed.success)
      names.set(
        bot,
        parsed.data.entries.map((entry) => entry.key),
      );
  };
  bot._client.on("registry_data", receive);
  bot.once("end", () => {
    bot._client.off("registry_data", receive);
    names.delete(bot);
  });
}

export function damageSourceName(bot: Bot, id: number): string | null {
  return names.get(bot)?.[id] ?? null;
}
