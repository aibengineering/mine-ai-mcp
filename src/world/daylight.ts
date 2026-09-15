/**
 * The Minecraft day, as the bot experiences it.
 *
 * `bot.time.timeOfDay` counts ticks from 0 at sunrise to 24000. A bed accepts
 * the bot from tick 12542 until 23458, which is the window this module calls
 * night; everything else is day. Sleep and the live status view both read the
 * clock through here so that they cannot disagree about when night begins.
 */

export const DAY_LENGTH_TICKS = 24_000;
export const BEDTIME_START_TICK = 12_542;
export const BEDTIME_END_TICK = 23_458;
const TICKS_PER_SECOND = 20;

export type DayPhase = "day" | "night";

export function isBedSleepTime(timeOfDay: number): boolean {
  return timeOfDay >= BEDTIME_START_TICK && timeOfDay <= BEDTIME_END_TICK;
}

export function dayPhase(timeOfDay: number): DayPhase {
  return isBedSleepTime(timeOfDay) ? "night" : "day";
}

/** Ticks until a bed next accepts the bot; zero while it already does. */
export function ticksUntilNight(timeOfDay: number): number {
  if (isBedSleepTime(timeOfDay)) return 0;
  return timeOfDay < BEDTIME_START_TICK
    ? BEDTIME_START_TICK - timeOfDay
    : DAY_LENGTH_TICKS - timeOfDay + BEDTIME_START_TICK;
}

/** Ticks until beds stop accepting the bot; zero while it is already day. */
export function ticksUntilDay(timeOfDay: number): number {
  return isBedSleepTime(timeOfDay) ? BEDTIME_END_TICK + 1 - timeOfDay : 0;
}

export function ticksToMinutes(ticks: number): number {
  return ticks / TICKS_PER_SECOND / 60;
}
