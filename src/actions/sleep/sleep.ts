import { sleepCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { createMovements, nearGoal, type NavigationRuntime } from "../../navigation/index.js";
import { waitForSignal } from "../../utils/index.js";
import {
  findLoadedBlockPositions,
  isBedSleepTime,
  ticksToMinutes,
  ticksUntilNight,
  type WorldBlock,
} from "../../world/index.js";
import { defineAction } from "../action.js";
import { describeNavigation } from "../navigation-result.js";
import { recordPersonalRespawn } from "../portal-entry/respawn-knowledge.js";
import { isBedBlock, placeCarriedBed } from "./bed-placement.js";
import {
  SLEEP,
  SLEEP_DESCRIPTION,
  parseSleepRequest,
  sleepResultSchema,
  sleepAnnotations,
  sleepInputSchema,
  sleepOutcomes,
  type SleepResult,
  type SleepEvidence,
  type SleepRequest,
} from "./contract.js";

const BED_SEARCH_DISTANCE = 32;
const BED_USE_DISTANCE = 3.2;
const BED_ROUTE_TIMEOUT_MS = 30_000;
const MORNING_WAIT_MS = 30_000;
const HOSTILE_SLEEP_HORIZONTAL_RANGE = 8;
const HOSTILE_SLEEP_VERTICAL_RANGE = 5;

interface AvailableBed {
  readonly block: WorldBlock;
  readonly placed: boolean;
}

interface NearbySleepHostile {
  readonly name: string;
  readonly distance: number;
  readonly position: { x: number; y: number; z: number };
}

type BedAvailability = { kind: "available"; bed: AvailableBed } | { kind: "failed"; error: string };

function timeUntilNight(timeOfDay: number): Pick<SleepEvidence, "ticksUntilNight" | "minutesUntilNight"> {
  const ticks = ticksUntilNight(timeOfDay);
  return { ticksUntilNight: ticks, minutesUntilNight: ticksToMinutes(ticks) };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function isBedOccupied(block: WorldBlock): boolean {
  const occupied = block.getProperties().occupied;
  return occupied === "true" || occupied === true;
}

function findUnoccupiedBed(bot: Bot): WorldBlock | null {
  const stateIds = new Set<number>();
  for (const block of Object.values(bot.registry.blocksByName)) {
    if (!isBedBlock(block.name)) continue;
    for (let state = block.minStateId; state <= block.maxStateId; state += 1) stateIds.add(state);
  }
  // Mineflayer's nearest-section search missed a diagonal section containing
  // the camp bed. Scan loaded columns, then enforce the spherical reach below.
  const positions = findLoadedBlockPositions(bot, {
    center: bot.entity.position,
    radius: BED_SEARCH_DISTANCE,
    stateIds,
    limit: Number.POSITIVE_INFINITY,
  });

  for (const position of positions) {
    if (position.distanceTo(bot.entity.position) > BED_SEARCH_DISTANCE) continue;
    const block = bot.blockAt(position);
    if (block && isBedBlock(block.name) && !isBedOccupied(block)) return block;
  }
  return null;
}

async function findOrPlaceBed(bot: Bot, signal?: AbortSignal): Promise<BedAvailability> {
  const existing = findUnoccupiedBed(bot);
  if (existing) return { kind: "available", bed: { block: existing, placed: false } };

  const placement = await placeCarriedBed(bot, signal);
  if (placement.kind === "placed") {
    return { kind: "available", bed: { block: placement.block, placed: true } };
  }
  return {
    kind: "failed",
    error:
      placement.reason === "missing_bed" ? sleepOutcomes.noBedFound : sleepOutcomes.placementFailed(placement.error),
  };
}

async function approachBed(
  bot: Bot,
  navigation: NavigationRuntime,
  bed: WorldBlock,
  signal?: AbortSignal,
): Promise<string | null> {
  if (bot.entity.position.distanceTo(bed.position) <= BED_USE_DISTANCE) return null;

  try {
    const route = await navigation.navigate({
      movements: createMovements(bot),
      goal: nearGoal({ x: bed.position.x, y: bed.position.y, z: bed.position.z }, 2),
      timeoutMs: BED_ROUTE_TIMEOUT_MS,
      signal,
    });
    return bot.entity.position.distanceTo(bed.position) <= BED_USE_DISTANCE ? null : describeNavigation(route);
  } catch (cause) {
    signal?.throwIfAborted();
    return message(cause);
  }
}

function bedPosition(bed: AvailableBed) {
  return {
    x: bed.block.position.x,
    y: bed.block.position.y,
    z: bed.block.position.z,
  };
}

function bedUseEvidence(bot: Bot, bed: AvailableBed): Pick<SleepEvidence, "placedBed" | "bedPosition" | "warning"> {
  const position = bedPosition(bed);
  const hasCarriedBed = bot.inventory.items().some((item) => isBedBlock(item.name));
  return {
    placedBed: bed.placed,
    bedPosition: position,
    ...(!hasCarriedBed && { warning: sleepOutcomes.noBedInInventory(bed.block.name, position) }),
  };
}

/** Observe the vanilla-sized hostile exclusion area around the selected bed. */
function nearbySleepHostiles(bot: Bot, bed: WorldBlock): NearbySleepHostile[] {
  return Object.values(bot.entities)
    .filter((entity) => {
      if (entity.type !== "hostile") return false;
      const offset = entity.position.minus(bed.position);
      return (
        Math.abs(offset.x) <= HOSTILE_SLEEP_HORIZONTAL_RANGE &&
        Math.abs(offset.y) <= HOSTILE_SLEEP_VERTICAL_RANGE &&
        Math.abs(offset.z) <= HOSTILE_SLEEP_HORIZONTAL_RANGE
      );
    })
    .map((entity) => ({
      name: entity.name ?? entity.displayName ?? "hostile mob",
      distance: entity.position.distanceTo(bed.position),
      position: {
        x: Math.floor(entity.position.x),
        y: Math.floor(entity.position.y),
        z: Math.floor(entity.position.z),
      },
    }))
    .sort((left, right) => left.distance - right.distance);
}

function hostileSleepFailure(bot: Bot, bed: AvailableBed, timeOfDay: number): SleepResult | null {
  const nearbyHostiles = nearbySleepHostiles(bot, bed.block);
  if (nearbyHostiles.length === 0) return null;
  const error = sleepOutcomes.hostilesNearby(nearbyHostiles);
  return {
    status: "failed",
    error,
    sleep: {
      asleep: false,
      morning: false,
      respawnSet: false,
      timeOfDay,
      ...bedUseEvidence(bot, bed),
      nearbyHostiles,
      observation: error,
    },
  };
}

function otherPlayerSleepStates(bot: Bot): NonNullable<SleepEvidence["otherPlayers"]> {
  const metadataKeys = bot.registry?.entitiesByName.player?.metadataKeys;
  const poseIndex = metadataKeys?.indexOf("pose") ?? -1;
  const sleepingPositionIndex = metadataKeys?.indexOf("sleeping_pos") ?? -1;

  return Object.entries(bot.players)
    .filter(([username]) => username && username !== bot.username)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([username, player]) => {
      const entity = player.entity as typeof player.entity | null | undefined;
      if (!entity || poseIndex < 0 || sleepingPositionIndex < 0) {
        return { username, sleepState: "unknown" as const };
      }

      const metadata = entity.metadata as unknown[];
      const pose = metadata[poseIndex];
      const sleepingPosition = metadata[sleepingPositionIndex];
      return {
        username,
        sleepState: pose === 2 || sleepingPosition != null ? ("sleeping" as const) : ("awake" as const),
      };
    });
}

async function setRespawnAtBed(
  bot: Bot,
  bed: AvailableBed,
  timeOfDay: number,
  signal?: AbortSignal,
): Promise<SleepResult> {
  try {
    await bot.activateBlock(bed.block);
  } catch (cause) {
    signal?.throwIfAborted();
    const error = sleepOutcomes.respawnRejected(message(cause));
    return {
      status: "failed",
      error,
      sleep: {
        asleep: false,
        morning: false,
        respawnSet: false,
        timeOfDay,
        ...bedUseEvidence(bot, bed),
        observation: error,
      },
    };
  }

  return {
    status: "succeeded",
    sleep: {
      asleep: false,
      morning: false,
      respawnSet: true,
      timeOfDay,
      ...timeUntilNight(timeOfDay),
      ...bedUseEvidence(bot, bed),
      observation: sleepOutcomes.daytimeRespawnSet(timeOfDay),
    },
  };
}

async function sleepInBed(
  bot: Bot,
  bed: AvailableBed,
  timeBefore: number,
  signal?: AbortSignal,
): Promise<SleepResult> {
  const observedHostiles = hostileSleepFailure(bot, bed, timeBefore);
  if (observedHostiles) return observedHostiles;

  try {
    await bot.sleep(bed.block);
    // Mineflayer resolves only after the native entitySleep event. Daytime
    // activateBlock has no equivalent acknowledgement and is not recorded.
    recordPersonalRespawn(bot, bedPosition(bed));
  } catch (cause) {
    signal?.throwIfAborted();
    const hostilesAfterRejection = hostileSleepFailure(bot, bed, timeBefore);
    if (hostilesAfterRejection) return hostilesAfterRejection;
    const reason = message(cause);
    return {
      status: "failed",
      error: sleepOutcomes.sleepRejected(reason),
      sleep: {
        asleep: false,
        morning: false,
        respawnSet: false,
        timeOfDay: timeBefore,
        ...bedUseEvidence(bot, bed),
        observation: sleepOutcomes.sleepRejectedObservation(reason),
      },
    };
  }

  await waitForSignal(() => (!isBedSleepTime(bot.time.timeOfDay) ? true : null), bot, ["wake", "time"], {
    timeoutMs: MORNING_WAIT_MS,
    context: { signal },
  });
  signal?.throwIfAborted();

  const timeAfter = bot.time.timeOfDay;
  const morning = !isBedSleepTime(timeAfter);
  const otherPlayers = otherPlayerSleepStates(bot);

  return {
    status: "succeeded",
    sleep: {
      asleep: bot.isSleeping,
      morning,
      respawnSet: true,
      timeOfDay: timeAfter,
      ...bedUseEvidence(bot, bed),
      otherPlayers: otherPlayers.length > 0 ? otherPlayers : undefined,
      observation: morning
        ? sleepOutcomes.sleptMorning
        : bot.isSleeping
          ? sleepOutcomes.restingInBed
          : sleepOutcomes.wokeUp,
    },
  };
}

/** Execute the complete sleep lifecycle: finding, approaching, placing if needed, and sleeping/setting respawn. */
export async function executeSleep(
  bot: Bot,
  navigation: NavigationRuntime,
  _request: SleepRequest,
  signal?: AbortSignal,
): Promise<SleepResult> {
  signal?.throwIfAborted();
  if (bot.game.dimension !== "overworld") {
    return {
      status: "failed",
      error: sleepOutcomes.dimensionUnsafe,
    };
  }

  if (bot.isSleeping) {
    const timeOfDay = bot.time.timeOfDay;
    return {
      status: "succeeded",
      sleep: {
        asleep: true,
        morning: !isBedSleepTime(timeOfDay),
        respawnSet: true,
        placedBed: false,
        timeOfDay,
        observation: sleepOutcomes.alreadySleeping,
      },
    };
  }

  const availability = await findOrPlaceBed(bot, signal);
  if (availability.kind === "failed") {
    return {
      status: "failed",
      error: availability.error,
    };
  }
  const { bed } = availability;

  const routeFailure = await approachBed(bot, navigation, bed.block, signal);
  if (routeFailure !== null) {
    return {
      status: "failed",
      error: sleepOutcomes.unreachable(bed.block.position, routeFailure),
    };
  }

  const timeOfDay = bot.time.timeOfDay;
  const canSleep = isBedSleepTime(timeOfDay) || (bot.isRaining && bot.thunderState > 0);
  if (canSleep) return sleepInBed(bot, bed, timeOfDay, signal);
  return setRespawnAtBed(bot, bed, timeOfDay, signal);
}

export function formatSleepResult(result: SleepResult): string {
  if (result.status === "failed") {
    return result.sleep ? formatSleepEvidence(result.sleep, result.error) : `**Observed stop:** ${result.error}`;
  }
  return formatSleepEvidence(result.sleep, result.status === "partial" ? result.error : undefined);
}

function formatSleepEvidence(sleep: SleepEvidence, error?: string): string {
  const lines = [
    sleep.observation,
    `- Sleeping now: ${sleep.asleep}`,
    `- Morning observed: ${sleep.morning}`,
    `- Respawn set: ${sleep.respawnSet}`,
    `- Bed placed from inventory: ${sleep.placedBed}`,
    `- Time of day: ${sleep.timeOfDay}`,
  ];
  if (sleep.ticksUntilNight !== undefined && sleep.minutesUntilNight !== undefined) {
    lines.push(`- Ticks until night: ${sleep.ticksUntilNight}`);
    lines.push(`- Time until night at 20 ticks/second: ${sleep.minutesUntilNight.toFixed(2)} minutes`);
  }
  if (sleep.warning) lines.push("", `> **Bed reminder:** ${sleep.warning}`);
  if (sleep.bedPosition) {
    lines.push(`- Bed: \`${sleep.bedPosition.x}, ${sleep.bedPosition.y}, ${sleep.bedPosition.z}\``);
  }
  if (sleep.otherPlayers) {
    lines.push("- Other players online:");
    for (const player of sleep.otherPlayers) {
      const state = player.sleepState === "unknown" ? "sleep state unknown" : player.sleepState;
      lines.push(`  - ${player.username}: ${state}`);
    }
  }
  if (sleep.nearbyHostiles) {
    lines.push("- Nearby hostile mobs:");
    for (const hostile of sleep.nearbyHostiles) {
      lines.push(
        `  - ${hostile.name}: ${hostile.distance.toFixed(2)} blocks away at \`${hostile.position.x}, ${hostile.position.y}, ${hostile.position.z}\``,
      );
    }
  }
  if (error) lines.push("", `**Observed stop:** ${error}`);
  return lines.join("\n");
}

/** Define the standalone sleep action. */
export function createSleepAction(bot: Bot, navigation: NavigationRuntime) {
  return defineAction({
    checkpointSchema: sleepCheckpointSchema,
    name: SLEEP,
    description: SLEEP_DESCRIPTION,
    inputSchema: sleepInputSchema,
    resultSchema: sleepResultSchema,
    formatResult: formatSleepResult,
    execution: { kind: "task" },
    annotations: sleepAnnotations,
    parse: parseSleepRequest,
    execute: (request, context) => {
      const timeBefore = bot.time.timeOfDay;
      context.observeProgress?.(() => ({ baseline: { timeOfDay: timeBefore },
        checkpoint: { phase: bot.isSleeping ? "sleeping" : "finding_or_entering_bed", asleep: bot.isSleeping, timeOfDay: bot.time.timeOfDay },
        completion: { kind: "event", observed: false, owes: "The sleep executor must confirm sleeping, respawn setting, or morning." },
      }));
      return executeSleep(bot, navigation, request, context.signal);
    },
  });
}
