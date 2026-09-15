import type { Bot } from "mineflayer";

export interface PersonalRespawnObservation {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
  readonly dimension: "overworld";
  readonly observedAt: number;
}

const observations = new WeakMap<Bot, PersonalRespawnObservation>();
const watched = new WeakSet<Bot>();

function watchReset(bot: Bot): void {
  if (watched.has(bot)) return;
  watched.add(bot);
  bot.on("spawnReset", () => { observations.delete(bot); });
}

/** Record only a server-accepted bed use, never Mineflayer's world-spawn coordinate. */
export function recordPersonalRespawn(bot: Bot, position: { x: number; y: number; z: number }): void {
  watchReset(bot);
  observations.set(bot, { position: { ...position }, dimension: "overworld", observedAt: Date.now() });
}

/** Session-local knowledge. Missing means unknown, not world spawn. */
export function personalRespawnObservation(bot: Bot): PersonalRespawnObservation | null {
  watchReset(bot);
  return observations.get(bot) ?? null;
}
