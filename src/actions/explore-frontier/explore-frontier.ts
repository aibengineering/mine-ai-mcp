import { exploreCheckpointSchema } from "../checkpoint-schemas.js";
/** Expand one remembered world boundary through short, observable Pathfinder legs. */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  nearestFrontierQuery,
  refreshNearestFrontier,
  snapshotBotStatus,
  type NearestFrontierTarget,
  type SqlBotData,
} from "../../bot-data/index.js";
import {
  advanceGoal,
  createMovements,
  type Navigate,
  type NavigationResult,
  type NavigationRuntime,
} from "../../navigation/index.js";
import type { FrontierChunk, SessionFrontier } from "../../runtime/frontier.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { RequestExecution, ActionContext } from "../action.js";
import { defineSqlAction, sqlActionSource, type SqlAction } from "../sql-action.js";
import {
  exploreOutcomes,
  parseExploreFrontierRequest,
  EXPLORE_FRONTIER,
  EXPLORE_FRONTIER_DESCRIPTION,
  exploreFrontierInputSchema,
  exploreFrontierResultSchema,
  unitVectorForHeading,
  type ExploreFrontierRequest,
  type ExploreFrontierResult,
  type UnitVector,
} from "./contract.js";

const LEG_DISTANCE = 16;
// One scaffold must save roughly 16 walking blocks (5 ticks each). Exploration
// can follow a shore instead of spending its expedition supplies on a bridge.
const EXPLORATION_PLACEMENT_PENALTY = 80;
/** A leg is judged at the feet cell's centre; the settled bot may stand up to half a block short of it. */
const ARRIVAL_SLACK = 0.5;
const MIN_FORWARD_PROGRESS = 0.5;
const EXPLORE_FRONTIER_QUERIES = [nearestFrontierQuery] as const;

export interface ExploreFrontierDependencies {
  readonly createMovements: typeof createMovements;
  readonly navigate: Navigate;
}

function productionDependencies(navigate: Navigate): ExploreFrontierDependencies {
  return { createMovements, navigate };
}

interface RecordedExpansion {
  readonly baseline: number;
  readonly chunkKeys: Set<string>;
  furthestBoundary: number;
  expandedChunks: number;
}

/** Execute one data-bound exploration request. */
export async function exploreFrontier(
  bot: Bot,
  request: ExploreFrontierRequest,
  context: ActionContext,
  frontier: SessionFrontier,
  dependencies: ExploreFrontierDependencies,
  botData?: SqlBotData,
): Promise<ExploreFrontierResult> {
  return beginExploreFrontier(bot, request, frontier, dependencies, botData)(context);
}

/** Keep the requested boundary and observed expansion across interrupted attempts. */
export function beginExploreFrontier(
  bot: Bot,
  request: ExploreFrontierRequest,
  frontier: SessionFrontier,
  dependencies: ExploreFrontierDependencies,
  botData?: SqlBotData,
): RequestExecution<ExploreFrontierResult> {
  const start = bot.entity.position.clone();
  const dimension = bot.game.dimension;
  const vector = unitVectorForHeading(request.heading);
  let recorded: RecordedExpansion | null = null;
  let enteredBiome: { x: number; y: number; z: number } | null = null;
  return async (context) => {
    context.observeProgress?.(() => ({ baseline: { start: position(start), dimension },
      checkpoint: { phase: "exploring", expandedChunks: recorded?.expandedChunks ?? 0, requested: request.chunks,
        enteredBiome: enteredBiome ? { ...enteredBiome } : null },
      completion: { kind: "current", observed: request.biome ? enteredBiome !== null : (recorded?.expandedChunks ?? 0) >= request.chunks,
        owes: "Observe the requested frontier expansion or enter the requested biome with supported footing." },
    }));
    let unsubscribe = () => {};
    const biomeStop = new AbortController();
    const observeBiome = () => {
      if (!request.biome || enteredBiome || bot.game.dimension !== dimension || !bot.entity.onGround) return;
      const feet = bot.entity.position.floored();
      // World returns biome ID 0 for an unloaded column. Only a loaded column
      // and the connection's registry establish the biome at these feet.
      if (!bot.world.getColumnAt(feet)) return;
      if (bot.registry.biomes[bot.world.getBiome(feet)]?.name !== request.biome) return;
      enteredBiome = position(feet);
      biomeStop.abort(`Observed ${request.biome} at the grounded bot's feet.`);
    };

    try {
      context.signal?.throwIfAborted();
      if (request.biome) {
        if (!bot.registry.biomesArray.some((biome) => biome.name === request.biome)) {
          return settleExploration({
            bot,
            request,
            vector,
            dimension,
            recorded: recorded ?? freshExpansion(0),
            start,
            enteredBiome,
            error: exploreOutcomes.unknownBiome(request.biome),
            botData,
          });
        }
        observeBiome();
        if (enteredBiome !== null && bot.game.dimension === dimension) {
          return settleExploration({
            bot,
            request,
            vector,
            dimension,
            recorded: recorded ?? freshExpansion(0),
            start,
            enteredBiome,
            error: null,
            botData,
          });
        }
        bot.on("physicsTick", observeBiome);
      }
      await frontier.idle();
      context.signal?.throwIfAborted();

      const frontierError = frontier.status().error;
      if (frontierError) {
        return settleExploration({
          bot,
          request,
          vector,
          dimension,
          recorded: recorded ?? freshExpansion(0),
          start,
          enteredBiome,
          error: exploreOutcomes.frontierError(frontierError),
          botData,
        });
      }

      if (bot.game.dimension !== dimension) {
        return settleExploration({
          bot,
          request,
          vector,
          dimension,
          recorded: recorded ?? freshExpansion(0),
          start,
          enteredBiome,
          error: exploreOutcomes.dimensionChanged(dimension, bot.game.dimension),
          botData,
        });
      }

      if (recorded === null) {
        const baseline = frontier.boundary(dimension, vector);
        if (baseline === null) {
          return settleExploration({
            bot,
            request,
            vector,
            dimension,
            recorded: freshExpansion(0),
            start,
            enteredBiome,
            error: exploreOutcomes.emptyFrontier(dimension),
            botData,
          });
        }

        recorded = freshExpansion(baseline);
      }
      const expansion = recorded;
      const currentExpansion = () => {
        expansion.expandedChunks = eligibleExpandedChunks(expansion, start, bot.entity.position, vector);
        return expansion.expandedChunks;
      };
      // There is no await between the baseline read and this subscription, so a
      // chunk event cannot slip into an unobserved gap on the JavaScript thread.
      // Only records observed during exploration count, as before. A resumed
      // attempt adds to the same evidence without accepting shared writes or
      // retaining a listener while another response owns the bot.
      unsubscribe = frontier.onRecorded((chunk) => rememberRecordedChunk(expansion, chunk, dimension, vector));

      // Standard bot movements with digging and scaffolding enabled allow
      // the bot to navigate natural uneven terrain, scale hills/cliffs, break
      // obstructing foliage, and bridge gaps during frontier exploration.
      const movements = dependencies.createMovements(bot, { placementPenalty: EXPLORATION_PLACEMENT_PENALTY });

      let stopError: string | null = null;
      while (enteredBiome === null && currentExpansion() < request.chunks) {
        context.signal?.throwIfAborted();
        const legStart = bot.entity.position.clone();
        let route: NavigationResult;
        try {
          // A short horizontal leg can require a long climb or excavation.
          // Request scope and Pathfinder's failure/cancellation own its end;
          // the former 30-second deadline cut off a progressing Nether ascent.
          // The leg asks for ground gained along the heading, not a point on
          // it: a point over the lava sea was bridged rather than walked round.
          route = await dependencies.navigate({
            movements,
            goal: advanceGoal(legStart, vector, LEG_DISTANCE),
            signal: context.signal,
            ...(request.biome && { stopSignal: biomeStop.signal }),
          });
        } catch (cause) {
          context.signal?.throwIfAborted();
          stopError = exploreOutcomes.executionFailed(cause);
          break;
        }

        await frontier.idle();
        context.signal?.throwIfAborted();
        observeBiome();

        if (bot.game.dimension !== dimension) {
          stopError = exploreOutcomes.dimensionChanged(dimension, bot.game.dimension);
          break;
        }
        if (enteredBiome !== null || currentExpansion() >= request.chunks) break;

        const currentFrontierError = frontier.status().error;
        if (currentFrontierError) {
          stopError = exploreOutcomes.frontierError(currentFrontierError);
          break;
        }
        const progress = forwardProgress(legStart, bot.entity.position, vector);
        if (route.status === "stopped") {
          stopError = exploreOutcomes.routeStopped(route.reason);
          break;
        }
        if (progress < MIN_FORWARD_PROGRESS) {
          stopError = exploreOutcomes.noForwardProgress(request.heading);
          break;
        }
      }

      return settleExploration({
        bot,
        request,
        vector,
        dimension,
        recorded,
        start,
        enteredBiome,
        error: stopError,
        botData,
      });
    } finally {
      // Preserve columns already corroborated by this attempt's movement even
      // when a takeover aborts navigation before its result can be inspected.
      if (recorded && bot.game.dimension === dimension) {
        recorded.expandedChunks = eligibleExpandedChunks(recorded, start, bot.entity.position, vector);
      }
      unsubscribe();
      if (request.biome) bot.off("physicsTick", observeBiome);
    }
  };
}

function freshExpansion(baseline: number): RecordedExpansion {
  return { baseline, chunkKeys: new Set(), furthestBoundary: baseline, expandedChunks: 0 };
}

function rememberRecordedChunk(
  expansion: RecordedExpansion,
  chunk: FrontierChunk,
  dimension: string,
  vector: UnitVector,
): void {
  if (chunk.dimension !== dimension) return;
  expansion.chunkKeys.add(`${chunk.dimension}|${chunk.chunkX}|${chunk.chunkZ}`);
  expansion.furthestBoundary = Math.max(expansion.furthestBoundary, chunkProjection(chunk, vector));
}

function chunkProjection(chunk: Pick<FrontierChunk, "chunkX" | "chunkZ">, vector: UnitVector): number {
  return chunk.chunkX * vector.x + chunk.chunkZ * vector.z;
}

function positionProjection(position: Pick<Vec3, "x" | "z">, vector: UnitVector): number {
  return position.x * vector.x + position.z * vector.z;
}

function eligibleExpandedChunks(expansion: RecordedExpansion, start: Vec3, current: Vec3, vector: UnitVector): number {
  const committed = Math.max(0, Math.floor(expansion.furthestBoundary - expansion.baseline + 1e-9));
  // A late spawn-ring packet is locally committed evidence, but it is not
  // exploration. Corroborate directional expansion with the distance this
  // action actually travelled, allowing only the arrival slack of a settled leg.
  const travelled = Math.max(0, forwardProgress(start, current, vector));
  const travelledChunkColumns = Math.floor((travelled + ARRIVAL_SLACK) / LEG_DISTANCE);
  return Math.max(expansion.expandedChunks, Math.min(committed, travelledChunkColumns));
}

function forwardProgress(start: Vec3, end: Vec3, vector: UnitVector): number {
  return positionProjection(end, vector) - positionProjection(start, vector);
}

function position(position: Vec3): { x: number; y: number; z: number } {
  const cell = position.floored();
  return { x: cell.x, y: cell.y, z: cell.z };
}

function bestEffortNearestFrontier(botData: SqlBotData | undefined, bot: Bot): NearestFrontierTarget | null {
  if (!botData) return null;
  try {
    return refreshNearestFrontier(botData, snapshotBotStatus(bot));
  } catch {
    return null;
  }
}

interface SettleInput {
  readonly bot: Bot;
  readonly request: ExploreFrontierRequest;
  readonly vector: UnitVector;
  readonly dimension: string;
  readonly recorded: RecordedExpansion;
  readonly start: Vec3;
  readonly enteredBiome: { x: number; y: number; z: number } | null;
  readonly error: string | null;
  readonly botData?: SqlBotData;
}

function settleExploration(input: SettleInput): ExploreFrontierResult {
  const expanded =
    input.bot.game.dimension === input.dimension
      ? eligibleExpandedChunks(input.recorded, input.start, input.bot.entity.position, input.vector)
      : input.recorded.expandedChunks;
  const nearestFrontier = bestEffortNearestFrontier(input.botData, input.bot);
  const explored = {
    dimension: input.dimension,
    heading: input.request.heading,
    requestedChunks: input.request.chunks,
    expandedChunks: expanded,
    newChunksRecorded: input.recorded.chunkKeys.size,
    start: position(input.start),
    end: position(input.bot.entity.position),
    nearestFrontier,
    ...(input.request.biome !== undefined && {
      biome:
        input.enteredBiome === null
          ? { status: "not_observed" as const, name: input.request.biome }
          : { status: "entered" as const, name: input.request.biome, position: input.enteredBiome },
    }),
  };
  const source = sqlActionSource(EXPLORE_FRONTIER_QUERIES);
  const reached = input.request.biome ? input.enteredBiome !== null : expanded >= input.request.chunks;
  if (reached && input.error === null) {
    return { status: "succeeded", explored, source };
  }
  const failure =
    input.error ??
    (input.request.biome
      ? exploreOutcomes.biomeNotObserved(input.request.biome, expanded, input.request.chunks)
      : exploreOutcomes.boundaryNotReached(expanded, input.request.chunks));
  return expanded > 0
    ? { status: "partial", error: failure, explored, source }
    : { status: "failed", error: failure, explored, source };
}

export function formatExploreFrontierResult(result: ExploreFrontierResult): string {
  const { explored } = result;
  const nearest = explored.nearestFrontier
    ? `chunk ${explored.nearestFrontier.chunkX},${explored.nearestFrontier.chunkZ} (${explored.nearestFrontier.distanceBlocks} blocks, heading ${explored.nearestFrontier.heading}°)`
    : "None recorded";
  const evidence = [
    `Expanded **${explored.expandedChunks}/${explored.requestedChunks}** requested chunk columns heading **${explored.heading}°** in \`${explored.dimension}\`.`,
    `- New chunks recorded: ${explored.newChunksRecorded}`,
    `- Start: \`${explored.start.x}, ${explored.start.y}, ${explored.start.z}\``,
    `- End: \`${explored.end.x}, ${explored.end.y}, ${explored.end.z}\``,
    `- Nearest frontier: ${nearest}`,
    ...(explored.biome
      ? [
          explored.biome.status === "entered"
            ? `- Biome entered: \`${explored.biome.name}\` at \`${explored.biome.position.x}, ${explored.biome.position.y}, ${explored.biome.position.z}\` (observed at the grounded bot's feet)`
            : `- Biome not observed at the grounded bot's feet: \`${explored.biome.name}\``,
        ]
      : []),
  ].join("\n");
  return result.status === "succeeded" ? evidence : `${evidence}\n\n**Observed stop:** ${result.error}`;
}

export function createExploreFrontierAction(
  bot: Bot,
  navigation: NavigationRuntime,
  frontier: SessionFrontier,
  botData?: SqlBotData,
  dependencies: ExploreFrontierDependencies = productionDependencies(navigation.navigate),
): SqlAction<typeof EXPLORE_FRONTIER, ExploreFrontierRequest, ExploreFrontierResult> {
  return defineSqlAction({
    checkpointSchema: exploreCheckpointSchema,
    name: EXPLORE_FRONTIER,
    description: EXPLORE_FRONTIER_DESCRIPTION,
    inputSchema: exploreFrontierInputSchema,
    resultSchema: exploreFrontierResultSchema,
    queries: EXPLORE_FRONTIER_QUERIES,
    formatResult: formatExploreFrontierResult,
    execution: { kind: "resumable_task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: {
      title: EXPLORE_FRONTIER,
      destructiveHint: false,
      openWorldHint: true,
    },
    parse: parseExploreFrontierRequest,
    begin: (request) => beginExploreFrontier(bot, request, frontier, dependencies, botData),
  });
}
