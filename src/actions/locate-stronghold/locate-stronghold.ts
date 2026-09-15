import { strongholdCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { recordEvent, type SqlBotData } from "../../bot-data/index.js";
import {
  advanceGoal,
  createMovements,
  nearXzGoal,
  type Goal,
  type NavigationRuntime,
} from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { findLoadedBlockPositions } from "../../world/index.js";
import { defineAction, type ActionContext } from "../action.js";
import {
  LOCATE_STRONGHOLD,
  LOCATE_STRONGHOLD_DESCRIPTION,
  locateStrongholdInputSchema,
  locateStrongholdResultSchema,
  type LocateStrongholdRequest,
  type LocateStrongholdResult,
} from "./contract.js";
import { strongholdSupplies } from "./supplies.js";
import { recoverEyeDrop } from "./recover-eye.js";
import { StrongholdEyeFlights } from "./throw-eye.js";
import { StrongholdThrows } from "./throw-store.js";
import { direction, triangulate, type Bearing } from "./triangulation.js";

const horizontalDistance = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

/** Full-height loaded-column observation; common masonry is never a success predicate. */
export function loadedStrongholdFrame(bot: Bot, center: { x: number; z: number }, radius: number) {
  const block = bot.registry.blocksByName.end_portal_frame;
  if (!block) return null;
  const stateIds = new Set<number>();
  for (let id = block.minStateId; id <= block.maxStateId; id++) stateIds.add(id);
  const found = findLoadedBlockPositions(bot, {
    center: { ...center, y: bot.entity.position.y },
    radius,
    stateIds,
    limit: 1,
  })[0];
  return found ? { block: "end_portal_frame" as const, position: { x: found.x, y: found.y, z: found.z } } : null;
}

/** Survey successive chunk columns inside the caller's requested search area. */
function* survey(center: { x: number; z: number }, radius: number) {
  for (let ring = 16; ring <= radius; ring += 16) {
    for (let x = -ring; x <= ring; x += 16) {
      for (let z = -ring; z <= ring; z += 16) {
        if (Math.max(Math.abs(x), Math.abs(z)) !== ring || Math.hypot(x, z) > radius) continue;
        yield { x: Math.floor(center.x + x), z: Math.floor(center.z + z) };
      }
    }
  }
}

export function createLocateStrongholdAction(
  bot: Bot,
  navigation: NavigationRuntime,
  data: SqlBotData,
  flights: StrongholdEyeFlights,
) {
  return defineAction({
    checkpointSchema: strongholdCheckpointSchema,
    name: LOCATE_STRONGHOLD,
    description: LOCATE_STRONGHOLD_DESCRIPTION,
    inputSchema: locateStrongholdInputSchema,
    resultSchema: locateStrongholdResultSchema,
    parse: (input) => locateStrongholdInputSchema.parse(input ?? {}),
    execution: { kind: "resumable_task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: { title: LOCATE_STRONGHOLD, destructiveHint: true, openWorldHint: true },
    formatResult: (result) => {
      const confirmed = result.confirmation;
      const location = confirmed
        ? `Observed end_portal_frame at ${confirmed.position.x}, ${confirmed.position.y}, ${confirmed.position.z}.`
        : result.estimate
          ? `Unconfirmed estimate: ${result.estimate.x.toFixed(1)}, ${result.estimate.z.toFixed(1)}.`
          : "No intersection established.";
      const journey = result.journey
        ? `\n\nApproximate journey: ${Math.round(result.journey.horizontalDistanceBlocks)} blocks, ${result.journey.walkingMinutes.toFixed(1)} minutes walking. ${result.journey.basis}`
        : "";
      const supplies = result.supplies
        .map((item) => `${item.recommendation}: ${item.carried}/${item.required}`)
        .join("; ");
      const next =
        result.phase === "estimate" && result.status === "succeeded"
          ? `\n\nStock up for the Ender Dragon fight before travelling. Then call phase: "locate" with search_id: ${JSON.stringify(result.searchId)}. If supplies are missing, explicitly set continue_without_recommended_items: true to proceed anyway.`
          : "";
      return `${location}${journey}\n\nRecommended loadout (carried/target): ${supplies}.${next}\n\nPhase: ${result.phase}. Search: ${result.searchId}. Saved throws: ${result.throwIds.length} in stronghold_throws.${result.status === "succeeded" ? "" : `\n\n${result.error}`}`;
    },
    begin: (request) => (context) => locate(bot, navigation, data, flights, request, context),
  });
}

async function locate(
  bot: Bot,
  navigation: NavigationRuntime,
  data: SqlBotData,
  flights: StrongholdEyeFlights,
  request: LocateStrongholdRequest,
  context: ActionContext,
): Promise<LocateStrongholdResult> {
  const dimension = bot.game.dimension;
  const store = new StrongholdThrows(data, bot.username, dimension, request.search_id);
  let estimate: { x: number; z: number } | null = null;
  let confirmation: LocateStrongholdResult["confirmation"] = null;
  const evidence = () => ({
    phase: request.phase,
    journey: estimate
      ? {
          horizontalDistanceBlocks: horizontalDistance(bot.entity.position, estimate),
          walkingMinutes: horizontalDistance(bot.entity.position, estimate) / 4.3 / 60,
          basis:
            "Straight-line distance at 4.3 blocks/second; actual path, terrain, digging and stops are unknown." as const,
        }
      : null,
    supplies: strongholdSupplies(bot),
    searchId: request.search_id,
    dimension,
    throwIds: store.read().map((row) => row.throw_id),
    estimate,
    confirmation,
  });
  const assertActive = () => {
    context.observeProgress?.(() => ({ baseline: { dimension, searchId: request.search_id },
      checkpoint: { phase: request.phase, throwIds: store.read().map((row) => row.throw_id), estimate: estimate ? { ...estimate } : null,
        confirmed: confirmation !== null },
      completion: { kind: "current", observed: request.phase === "estimate" ? estimate !== null : confirmation !== null,
        owes: request.phase === "estimate" ? "A usable eye-bearing estimate." : "An observed loaded end_portal_frame." },
    }));
    context.signal?.throwIfAborted();
    if (bot.game.dimension !== dimension)
      throw new Error(`Dimension changed from ${dimension} to ${bot.game.dimension}.`);
  };
  const scan = () => {
    assertActive();
    confirmation = loadedStrongholdFrame(bot, estimate ?? bot.entity.position, request.search_radius);
    return confirmation !== null;
  };
  const walk = async (goal: Goal) => {
    assertActive();
    const result = await navigation.navigate({
      movements: createMovements(bot, { scaffolding: false }),
      goal,
      signal: context.signal,
    });
    assertActive();
    if (result.status !== "completed") throw new Error(`Stronghold route stopped: ${result.reason}`);
  };
  const throwEye = async () => {
    assertActive();
    const eye = bot.inventory.items().find((item) => item.name === "ender_eye");
    if (!eye) throw new Error("No carried Eyes of Ender remain; saved bearings can be resumed after supplying eyes.");
    // Spawn packets have no thrower ID. Avoid attributing a nearby player's
    // simultaneous throw to this bot; pre-existing eyes are never adopted.
    if (
      Object.values(bot.entities).some(
        (entity) =>
          entity !== bot.entity && entity.type === "player" && entity.position.distanceTo(bot.entity.position) < 6,
      )
    )
      throw new Error(
        "Another player is within six blocks; an eye spawn here would not identify its thrower reliably.",
      );
    await bot.equip(eye, "hand");
    assertActive();
    flights.start(store);
    await flights.wait(context.signal);
    assertActive();
    const latest = store.read().at(-1);
    if (!latest?.start_json || !latest.end_json)
      throw new Error("No Eye of Ender flight was observed for the saved throw attempt.");
    if (
      !direction({ start: latest.start_json, end: latest.end_json }) &&
      !(latest.state === "observed" && latest.end_json.y < latest.start_json.y - 1)
    )
      throw new Error("The observed eye flight supplied neither a horizontal bearing nor a descending local estimate.");
    await recoverEyeDrop(bot, navigation, latest.end_json, context.signal);
    assertActive();
  };
  try {
    assertActive();
    if (dimension !== "overworld") throw new Error("Eyes of Ender locate strongholds only in the Overworld.");
    await flights.wait(context.signal);
    if (request.phase === "locate") {
      const missing = strongholdSupplies(bot).filter((item) => item.carried < item.required);
      if (missing.length && !request.continue_without_recommended_items)
        throw new Error(
          `[STRONGHOLD_MISSING_SUPPLIES] Departure paused. Missing recommended items: ${missing.map((item) => `${item.recommendation} (${item.carried}/${item.required})`).join("; ")}. Set continue_without_recommended_items: true to continue anyway.`,
        );
    }
    // A cancelled flight keeps its bearing. On resume, recover a still-loaded
    // local drop before departing or returning the saved estimate.
    const resumed = store.read().at(-1);
    if (resumed?.state === "observed" && resumed.end_json) {
      await recoverEyeDrop(bot, navigation, resumed.end_json, context.signal);
      assertActive();
    }
    while (true) {
      const observations = store.read();
      const bearings: Bearing[] = observations.flatMap((row) =>
        row.start_json && row.end_json && direction({ start: row.start_json, end: row.end_json })
          ? [{ start: row.start_json, end: row.end_json }]
          : [],
      );
      const latest = bearings.at(-1);
      const previous = bearings.at(-2);
      estimate = latest && previous ? triangulate(previous, latest) : null;
      const last = observations.at(-1);
      // Directly above the target, a native eye can descend almost vertically.
      // That is a local estimate to survey, not a reason to spend every eye
      // trying to obtain a horizontal bearing from the same place.
      const descending =
        last?.state === "observed" &&
        last.start_json &&
        last.end_json &&
        !direction({ start: last.start_json, end: last.end_json }) &&
        last.end_json.y < last.start_json.y - 1;
      if (descending && last.end_json) estimate = { x: last.end_json.x, z: last.end_json.z };
      if (request.phase === "estimate" && estimate) return { status: "succeeded", ...evidence() };
      if (request.phase === "locate" && !estimate)
        throw new Error('No usable saved estimate. Complete phase: "estimate" with this search_id first.');
      if (!latest && !estimate) {
        await throwEye();
        continue;
      }
      if (!estimate) {
        if (!latest) throw new Error("No horizontal eye bearing is available.");
        const heading = direction(latest)!;
        // Begin with 32 blocks of parallax. If the last pair was unusable,
        // double its lateral separation rather than spending eyes on the same
        // poorly conditioned geometry. Saved origins preserve this on resume.
        const sideways = { x: -heading.z, z: heading.x };
        const separation = previous
          ? Math.abs(
              (latest.start.x - previous.start.x) * sideways.x + (latest.start.z - previous.start.z) * sideways.z,
            )
          : 16;
        await walk(advanceGoal(latest.start, sideways, Math.max(32, separation * 2)));
        await throwEye();
        continue;
      }
      await walk(nearXzGoal({ x: Math.floor(estimate.x), z: Math.floor(estimate.z) }, 8));
      // One fresh local bearing refines an estimate made far away. A resumed
      // local throw already in SQLite is reused instead of spending another.
      if (latest && !descending && horizontalDistance(latest.start, bot.entity.position) > 16) {
        await throwEye();
        continue;
      }
      if (scan()) break;
      for (const target of survey(estimate, request.search_radius)) {
        await walk(nearXzGoal(target, 2));
        if (scan()) break;
      }
      if (confirmation) break;
      throw new Error(
        `No end_portal_frame was observed in the ${request.search_radius}-block survey around the estimate.`,
      );
    }
    assertActive();
    const result = evidence();
    if (!result.confirmation) throw new Error("No loaded portal frame was confirmed.");
    recordEvent(data, bot.username, {
      type: "stronghold_located",
      observedAt: new Date().toISOString(),
      summary: `Stronghold portal frame observed at ${result.confirmation.position.x}, ${result.confirmation.position.y}, ${result.confirmation.position.z}.`,
      payload: {
        searchId: request.search_id,
        dimension,
        throwIds: result.throwIds,
        estimate,
        confirmation: result.confirmation,
      },
    });
    return { status: "succeeded", ...result };
  } catch (error) {
    if (context.signal?.aborted) throw error;
    const result = evidence();
    return {
      status: result.throwIds.length ? "partial" : "failed",
      error: error instanceof Error ? error.message : String(error),
      ...result,
    };
  }
}
