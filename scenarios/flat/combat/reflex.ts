/** Shared observation helpers for the scenarios that exercise the hostile reflex. */
import {
  READ_RECENT_EVENTS,
  readRecentEventsResultSchema,
} from "@aibengineering/mine-ai-mcp";
import { z } from "zod";
import type { Runtime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const encounterSchema = z.object({
  response: z.enum(["fight", "evade", "hide"]),
  outcome: z.string(),
  reason: z.string(),
  interrupted: z.object({ action: z.string(), startedAt: z.string() }).nullable(),
  healthBefore: z.number(),
  healthAfter: z.number(),
  attacks: z.number(),
  combatStyles: z.array(z.enum(["bow", "shielded_melee", "melee"])),
  weaponsUsed: z.array(z.string().min(1)),
  shieldRaisedSwings: z.number().int().nonnegative(),
  projectileGuards: z.number().int().nonnegative(),
  explosions: z.number().int().nonnegative(),
  finalPosition: z.object({ x: z.number(), y: z.number(), z: z.number() }),
  finalDistances: z.array(z.object({ id: z.number(), distance: z.number() })),
  hide: z
    .object({
      dug: z.number(),
      walled: z.number(),
      capped: z.boolean(),
      /** The bot was already sealed in, so nothing dug and nothing placed is the box working. */
      enclosed: z.boolean(),
      ate: z.string().nullable(),
      swings: z.number(),
      hungerAfter: z.number(),
    })
    .nullish(),
});
export type Encounter = z.output<typeof encounterSchema>;

/**
 * Count the explosions the server announces to this client.
 *
 * Health and encounter records are both poor witnesses to a creeper's fuse. A
 * creeper that explodes is discarded rather than killed, so the reflex sees it
 * go and reports `target_lost`; when its blast kills the other creeper, the
 * reflex sees that one die and reports a kill it did not make; and a blast a
 * few blocks off can leave an armored bot's bar untouched. The explosion packet
 * is the fact stated outright, and it reaches every player within sixty-four
 * blocks.
 */
// @function-metrics size=4 branches=0 fan-out=2 depth=2 interface=1 fan-in=3
export function watchExplosions(context: MineAiScenarioContext): { count(): number; close(): void } {
  let count = 0;
  const onExplosion = () => {
    count += 1;
  };
  context.bot._client.on("explosion", onExplosion);
  return {
    count: () => count,
    close: () => context.bot._client.removeListener("explosion", onExplosion),
  };
}

/**
 * Sample, every physics tick, whether the server says this bot is using its
 * off-hand item: the living-entity flags it broadcasts to everyone, and the
 * same fact a spectator reads as the blocking pose. The controller's own
 * counters record what it asked for; this records what the server did.
 */
// @function-metrics size=6 branches=1 fan-out=3 depth=2 interface=1 fan-in=3
export function watchShield(context: MineAiScenarioContext): { summary(): string; close(): void } {
  const LIVING_ENTITY_FLAGS_INDEX = 8;
  // The entity status the server sends for the bot's own entity on a block;
  // damage arrives as its own event, which Mineflayer surfaces as entityHurt.
  const SHIELD_BLOCK_STATUS = 29;
  let sampled = 0;
  let raised = 0;
  let hurt = 0;
  let blocked = 0;
  let loosed = 0;
  const onTick = () => {
    sampled += 1;
    const flags = context.bot.entity.metadata?.[LIVING_ENTITY_FLAGS_INDEX];
    if (typeof flags === "number" && (flags & 3) === 3) raised += 1;
  };
  const onStatus = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId === context.bot.entity.id && packet.entityStatus === SHIELD_BLOCK_STATUS) blocked += 1;
  };
  const onHurt = (entity: { id: number }) => {
    if (entity.id === context.bot.entity.id) hurt += 1;
  };
  /**
   * An arrow appearing at the bot's eyes is one it loosed, full draw or not.
   * A skeleton in melee reach looses its own from a block and a half away,
   * so the match is tight.
   */
  const onSpawn = (entity: { name?: string; position: { distanceTo(other: unknown): number } }) => {
    const eyes = context.bot.entity.position.offset(0, context.bot.entity.height * 0.85, 0);
    if (entity.name === "arrow" && entity.position.distanceTo(eyes) <= 1) loosed += 1;
  };
  context.bot.on("physicsTick", onTick);
  context.bot.on("entityHurt", onHurt);
  context.bot.on("entitySpawn", onSpawn);
  context.bot._client.on("entity_status", onStatus);
  return {
    summary: () => `shield up ${raised}/${sampled} ticks; blocked ${blocked}; hurt ${hurt}; arrows loosed ${loosed}`,
    close: () => {
      context.bot.off("physicsTick", onTick);
      context.bot.off("entityHurt", onHurt);
      context.bot.off("entitySpawn", onSpawn);
      context.bot._client.removeListener("entity_status", onStatus);
    },
  };
}

/** Why the observed explosions exceed what the fixture permits; null when they do not. */
// @function-metrics size=2 branches=1 fan-out=0 depth=1 interface=2 fan-in=3
export function excessExplosions(observed: number, permitted: number | undefined): string | null {
  if (permitted === undefined || observed <= permitted) return null;
  return `Observed ${observed} explosion(s); the fixture permits ${permitted}.`;
}

/** Block until the reflex has released the body it claimed. */
// @function-metrics size=3 branches=1 fan-out=3 depth=2 interface=2 fan-in=1
export async function waitForIdle(context: MineAiScenarioContext, runtime: Runtime): Promise<void> {
  while (runtime.status().busy) {
    context.signal.throwIfAborted();
    await context.bot.waitForTicks(1);
  }
}

/**
 * The encounters recorded since this scenario last read.
 *
 * The recent-events action advances a durable read cursor, so each call
 * returns only what is new: an already-reported encounter never comes back,
 * which is what makes "and nothing further was recorded" a question a
 * scenario can ask at all.
 */
// @function-metrics size=6 branches=3 fan-out=7 depth=4 interface=3 fan-in=3
export async function readEncounters(
  context: MineAiScenarioContext,
  runtime: Runtime,
  ignoreOutcomes: readonly string[] = [],
): Promise<readonly Encounter[]> {
  const readEvents = runtime.actions.find((action) => action.name === READ_RECENT_EVENTS);
  if (!readEvents) throw new Error("The reflex scenarios require the recent-events action.");
  const seen: Encounter[] = [];
  for (;;) {
    const output = await runtime.run(readEvents, { limit: 100 }, context.signal);
    const result = readRecentEventsResultSchema.parse(output.result);
    for (const event of result.events) {
      if (event.type !== "survival_outcome" || event.payload.source !== "hostile_reflex") continue;
      const encounter = parseEncounterEvidence(event.payload.evidence);
      if (!encounter) continue;
      if (!ignoreOutcomes.includes(encounter.outcome)) seen.push(encounter);
    }
    if (result.remainingEventCount === 0) break;
  }
  return seen;
}

/** Equipment preparation shares the reflex, but is not a completed fight. */
export function parseEncounterEvidence(value: unknown): Encounter | null {
  if (z.object({ response: z.literal("prepare_shield") }).safeParse(value).success) return null;
  const evidence = z.object({
    outcome: encounterSchema.omit({ interrupted: true }),
    interrupted: encounterSchema.shape.interrupted,
  }).parse(value);
  return { ...evidence.outcome, interrupted: evidence.interrupted };
}

/**
 * Wait for the reflex to record `count` encounters and then release the body.
 *
 * A reflex has no return value to await, so the persisted events are how a
 * scenario observes that it ran at all. Nothing here drives the bot: if the
 * reflex is broken, this waits and the scenario fails on a short event log
 * rather than on a timeout with no explanation. Waiting for the body as well as
 * the events matters for a crowd, where the bot goes briefly idle between one
 * kill and naming the next target.
 */
// @function-metrics size=9 branches=3 fan-out=5 depth=5 interface=4 fan-in=2
export async function awaitEncounters(
  context: MineAiScenarioContext,
  runtime: Runtime,
  count: number,
  ticks: number,
  ignoreOutcomes: readonly string[] = [],
): Promise<readonly Encounter[]> {
  // Events arrive oldest-first, so this stays in the order they happened.
  const seen: Encounter[] = [];
  for (let waited = 0; waited < ticks; waited += 5) {
    context.signal.throwIfAborted();
    if (!runtime.status().busy) {
      seen.push(...(await readEncounters(context, runtime, ignoreOutcomes)));
      if (seen.length >= count) return seen;
    }
    await context.bot.waitForTicks(5);
  }
  // A kill can finish during that final sleep. Read its settled evidence before
  // reporting an empty log and closing a physically successful runtime.
  if (!runtime.status().busy) seen.push(...(await readEncounters(context, runtime, ignoreOutcomes)));
  return seen;
}

/**
 * Spend health before the trial proper, and prove it stuck.
 *
 * Done from the client rather than a `tick` command so the scenario can wait
 * for the bar to actually settle. A datapack command that quietly fails to
 * match leaves a healthy bot that fights instead, and the fixture then fails
 * somewhere a long way from the cause - which is exactly how the first attempt
 * at the hide fixture behaved.
 */
// @function-metrics size=8 branches=2 fan-out=5 depth=2 interface=3 fan-in=2
export async function hurt(context: MineAiScenarioContext, target: number): Promise<boolean> {
  const { bot } = context;
  bot.chat(`/damage @s ${Math.max(1, Math.round(bot.health - target))} minecraft:magic`);
  for (let waited = 0; waited < 100; waited += 1) {
    context.signal.throwIfAborted();
    if (bot.health <= target) return true;
    await bot.waitForTicks(1);
  }
  return false;
}

// @function-metrics size=2 branches=0 fan-out=1 depth=2 interface=3 fan-in=1
export async function awaitEncounter(
  context: MineAiScenarioContext,
  runtime: Runtime,
  ticks: number,
): Promise<Encounter | null> {
  const [encounter] = await awaitEncounters(context, runtime, 1, ticks);
  return encounter ?? null;
}

/** The one-line evidence every combat scenario reports back to Mine Labs. */
// @function-metrics size=3 branches=0 fan-out=7 depth=2 interface=1 fan-in=3
export function describe(encounter: Encounter): string {
  const distances = encounter.finalDistances.map((entry) => `${entry.id}:${entry.distance.toFixed(1)}`).join(", ");
  return (
    `${encounter.response} -> ${encounter.outcome} (${encounter.reason}); ` +
    `styles ${encounter.combatStyles.join(" -> ") || "none"}; weapons ${encounter.weaponsUsed.join(" -> ") || "none"}; ` +
    `target swings while shield raised ${encounter.shieldRaisedSwings}; bow draws guarded ${encounter.projectileGuards}; ` +
    `interrupted ${encounter.interrupted?.action ?? "nothing"}; ` +
    `health ${encounter.healthBefore} -> ${encounter.healthAfter}; attacks ${encounter.attacks}; ` +
    `explosions during the response ${encounter.explosions}; ` +
    `bot at ${encounter.finalPosition.x.toFixed(1)},${encounter.finalPosition.y.toFixed(1)},${encounter.finalPosition.z.toFixed(1)}; ` +
    `final distances ${distances}` +
    (encounter.hide
      ? `; hide dug ${encounter.hide.dug}, walled ${encounter.hide.walled}, ${encounter.hide.capped ? "capped" : "open"}, ${encounter.hide.enclosed ? "already enclosed" : "built here"}, ate ${encounter.hide.ate ?? "nothing"}, swings ${encounter.hide.swings}, hunger ${encounter.hide.hungerAfter}`
      : "")
  );
}
