import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  createMovements,
  enterPortal,
  portalApproachGoal,
  type Navigate,
  type NavigationRuntime,
  type PortalBlock,
} from "../../navigation/index.js";
import { scaffoldBlockNames } from "../../navigation/mineflayer/movement-policy.js";
import { bucketDropTotals } from "../../navigation/mineflayer/water-landing.js";
import { observeToolTierLoss } from "../../world/tool-loss.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ObserveRequest } from "../../session/request.js";
import { armSignal, asVec3, type Position3 } from "../../utils/index.js";
import { defineAction, type ActionContext } from "../action.js";
import { navigateCheckpointSchema } from "../checkpoint-schemas.js";
import { formatNavigateResult } from "../navigate/navigate.js";
import type { NavigationEvidence } from "../navigate/contract.js";
import {
  ENTER_END_PORTAL,
  ENTER_END_PORTAL_DESCRIPTION,
  ENTER_NETHER_PORTAL,
  ENTER_NETHER_PORTAL_DESCRIPTION,
  enterEndPortalInputSchema,
  enterNetherPortalInputSchema,
  parseEndPortalRequest,
  parseNetherPortalRequest,
  portalEntryResultSchema,
  type PortalEntryRequest,
  type PortalEntryResult,
} from "./contract.js";
import { personalRespawnObservation } from "./respawn-knowledge.js";
import { portalSupplyWarning, type PortalDestination } from "./portal-policy.js";

export interface PortalEntryDependencies {
  readonly navigate: Navigate;
  readonly createMovements: typeof createMovements;
}

function destinationFor(kind: PortalEntryRequest["kind"], from: string): PortalDestination | null {
  if (kind === "nether") return from === "overworld" ? "the_nether" : from === "the_nether" ? "overworld" : null;
  return from === "overworld" ? "the_end" : from === "the_end" ? "overworld" : null;
}

function portalBlock(kind: PortalEntryRequest["kind"]): PortalBlock {
  return kind === "nether" ? "nether_portal" : "end_portal";
}

function position(value: Position3): Position3 {
  return { x: value.x, y: value.y, z: value.z };
}

function evidence(bot: Bot, request: PortalEntryRequest, start: Position3, startDimension: string, elapsedMs: number, scaffoldBefore: ReadonlyMap<string, number>, bucketBefore: ReturnType<typeof bucketDropTotals>): NavigationEvidence {
  return {
    startDimension,
    endDimension: bot.game.dimension,
    target: { x: request.x, y: request.y, z: request.z },
    range: 0,
    start,
    end: position(bot.entity.position),
    remainingDistance: bot.game.dimension === startDimension ? bot.entity.position.distanceTo(new Vec3(request.x, request.y, request.z)) : null,
    elapsedMs,
    scaffolding: [...new Set([...scaffoldBefore.keys(), ...scaffoldBlockNames(bot)])].map((item) => ({
      item,
      inventoryBefore: scaffoldBefore.get(item) ?? 0,
      inventoryAfter: bot.inventory.count(bot.registry.itemsByName[item]?.id ?? -1, null),
      consumed: Math.max(0, (scaffoldBefore.get(item) ?? 0) - bot.inventory.count(bot.registry.itemsByName[item]?.id ?? -1, null)),
    })),
    bucketDrops: { count: bucketDropTotals(bot).count - bucketBefore.count, waterRecovered: bucketDropTotals(bot).waterRecovered - bucketBefore.waterRecovered },
    missingDigTools: (["shovel", "pickaxe", "axe"] as const).filter((tool) => !bot.inventory.items().some((item) => item.name.endsWith(`_${tool}`))),
  };
}

export function endRespawnProblem(bot: Bot, request: PortalEntryRequest, destination: PortalDestination): string | null {
  if (request.kind !== "end" || destination !== "the_end" || request.allowDistantRespawn) return null;
  const observed = personalRespawnObservation(bot);
  if (!observed) {
    return "[END_PORTAL_RESPAWN_UNKNOWN] No personal respawn bed has been confirmed through this session's sleep action. Mineflayer's spawnPoint is world spawn, not personal bed evidence. Use sleep near a bed, or set allow_distant_respawn: true to override this guard.";
  }
  const loaded = bot.blockAt(asVec3(observed.position));
  if (loaded && !loaded.name.endsWith("_bed")) {
    return `[END_PORTAL_RESPAWN_STALE] The bed at the last confirmed personal respawn position now contains ${loaded.name}. Use sleep with an available bed, or set allow_distant_respawn: true to override this guard.`;
  }
  const distance = new Vec3(request.x, request.y, request.z).distanceTo(asVec3(observed.position));
  return distance <= request.respawnWithin
    ? null
    : `[END_PORTAL_RESPAWN_DISTANT] The last confirmed personal respawn bed is ${distance.toFixed(2)} blocks from this portal, beyond respawn_within=${request.respawnWithin}. The bed was confirmed in this session at ${new Date(observed.observedAt).toISOString()}, but its continued existence has not been proven. Set allow_distant_respawn: true to override.`;
}

export async function enterPortalAction(
  bot: Bot,
  request: PortalEntryRequest,
  context: ActionContext,
  dependencies: PortalEntryDependencies,
  lifetime: AbortSignal,
  observe: ObserveRequest = () => {},
): Promise<PortalEntryResult> {
  return beginPortalEntry(bot, request, dependencies, lifetime, observe)(context);
}

export function beginPortalEntry(
  bot: Bot,
  request: PortalEntryRequest,
  dependencies: PortalEntryDependencies,
  lifetime: AbortSignal,
  observe: ObserveRequest = () => {},
) {
  const start = position(bot.entity.position);
  const startDimension = bot.game.dimension;
  const destination = destinationFor(request.kind, startDimension);
  const cell = new Vec3(request.x, request.y, request.z);
  const block = portalBlock(request.kind);
  let positionedDimension = startDimension;
  let died = false;
  let elapsedMs = 0;
  const toolLoss = observeToolTierLoss(bot);
  const bucketBefore = bucketDropTotals(bot);
  const scaffoldBefore = new Map(scaffoldBlockNames(bot).map((item) => [item, bot.inventory.count(bot.registry.itemsByName[item]?.id ?? -1, null)]));
  const receipt = () => evidence(bot, request, start, startDimension, elapsedMs, scaffoldBefore, bucketBefore);
  observe(() => ({
    baseline: { dimension: startDimension, position: { ...start } },
    checkpoint: { destination: { ...position(cell) }, remainingDistance: bot.game.dimension === startDimension ? bot.entity.position.distanceTo(cell) : null, dimension: bot.game.dimension, positionedDimension, died, portal: { block, cell: cell.toString() } },
    completion: { kind: "current", observed: !died && destination !== null && positionedDimension === destination, owes: destination ? `Observed positioned arrival in ${destination}.` : "A supported dimension crossing." },
  }));
  const positioned = () => { positionedDimension = bot.game.dimension; };
  const death = () => { died = true; };
  bot.on("forcedMove", positioned);
  bot.on("death", death);
  lifetime.addEventListener("abort", () => { bot.off("forcedMove", positioned); bot.off("death", death); toolLoss.close(); }, { once: true });
  const waitForPositionedArrival = async (context: ActionContext) => {
    const arrival = armSignal(bot, ["forcedMove", "death"], () => died || positionedDimension === bot.game.dimension, { context, timeoutMs: 30_000 });
    const outcome = await arrival.promise;
    context.signal?.throwIfAborted();
    return outcome.kind === "signalled" && positionedDimension === bot.game.dimension;
  };
  return async (context: ActionContext): Promise<PortalEntryResult> => {
    context.signal?.throwIfAborted();
    if (died) return { status: "failed", error: "[PORTAL_DIED] The bot died during portal entry.", navigation: receipt() };
    if (!destination) return { status: "failed", error: `[PORTAL_DESTINATION] ${request.kind} portal entry is unsupported from ${startDimension}.`, navigation: receipt() };
    if (bot.game.dimension !== startDimension) {
      if (positionedDimension !== bot.game.dimension && !died) {
        const arrived = await waitForPositionedArrival(context);
        if (died) return { status: "failed", error: "[PORTAL_DIED] The bot died during portal entry.", navigation: receipt() };
        if (!arrived) return { status: "failed", error: "[PORTAL_ENTRY_TIMEOUT] The dimension changed, but no server-positioned arrival was observed within 30 seconds.", navigation: receipt() };
      }
      return !died && bot.game.dimension === destination && positionedDimension === destination
        ? { status: "succeeded", navigation: receipt() }
        : { status: "failed", error: died ? "[PORTAL_DIED] The bot died during portal entry." : `[PORTAL_DIMENSION_CHANGED] Expected ${destination}; observed ${bot.game.dimension}.`, navigation: receipt() };
    }
    const observedBlock = bot.blockAt(cell);
    if (observedBlock && observedBlock.name !== block) return { status: "failed", error: `[PORTAL_TARGET] Expected active ${block} at ${cell}; observed ${observedBlock.name}.`, navigation: receipt() };
    const problem = endRespawnProblem(bot, request, destination) ?? (!request.allowLowSupplies ? portalSupplyWarning(bot, destination) : null);
    if (problem) return { status: "failed", error: problem, navigation: receipt() };
    if (bot.blockAt(bot.entity.position.floored())?.name === block) return { status: "failed", error: `[PORTAL_ALREADY_INSIDE] The bot already occupies this ${block} after a recent arrival. Leave the portal opening and retry after the native portal cooldown; waiting inside can keep refreshing the cooldown.`, navigation: receipt() };

    const startedAt = Date.now();
    const elapsedBefore = elapsedMs;
    try {
      let route = await dependencies.navigate({ movements: dependencies.createMovements(bot), goal: portalApproachGoal(bot, cell, block), signal: context.signal, stopSignal: toolLoss.signal, onToolSelected: toolLoss.select });
      elapsedMs += route.elapsedMs;
      const lost = toolLoss.loss();
      if (lost) return { status: "partial", error: lost.reason, navigation: receipt() };
      if (bot.game.dimension === startDimension && route.status === "completed") {
        const callerSignal = context.signal ?? new AbortController().signal;
        const entrySignal = AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)]);
        const entry = await enterPortal(bot, cell, block, entrySignal);
        elapsedMs += entry.elapsedMs;
        route = entry;
      }
      if (bot.game.dimension !== startDimension && positionedDimension !== bot.game.dimension && !died) {
        const arrived = await waitForPositionedArrival(context);
        if (died) return { status: "failed", error: "[PORTAL_DIED] The bot died during portal entry.", navigation: receipt() };
        if (!arrived) return { status: "failed", error: "[PORTAL_ENTRY_TIMEOUT] The dimension changed, but no server-positioned arrival was observed within 30 seconds.", navigation: receipt() };
      }
      context.signal?.throwIfAborted();
      const finalReceipt = receipt();
      if (!died && bot.game.dimension === destination && positionedDimension === destination) return { status: "succeeded", navigation: finalReceipt };
      return { status: "failed", error: died ? "[PORTAL_DIED] The bot died during portal entry." : route.status === "stopped" ? `[PORTAL_STOPPED] Portal entry stopped: ${route.reason}.` : `[PORTAL_NOT_ENTERED] No positioned arrival in ${destination} was observed.`, navigation: finalReceipt };
    } catch (cause) {
      elapsedMs = elapsedBefore + (Date.now() - startedAt);
      if (context.signal?.aborted) throw cause;
      const timedOut = cause instanceof DOMException && cause.name === "TimeoutError";
      return { status: "failed", error: timedOut ? "[PORTAL_ENTRY_TIMEOUT] No positioned portal arrival was observed within 30 seconds." : `[PORTAL_FAILED] Portal entry threw: ${cause instanceof Error ? cause.message : String(cause)}`, navigation: receipt() };
    }
  };
}

function createPortalAction(bot: Bot, navigation: NavigationRuntime, kind: "nether" | "end", dependencies: PortalEntryDependencies = { navigate: navigation.navigate, createMovements }) {
  const end = kind === "end";
  return defineAction({
    checkpointSchema: navigateCheckpointSchema,
    name: end ? ENTER_END_PORTAL : ENTER_NETHER_PORTAL,
    description: end ? ENTER_END_PORTAL_DESCRIPTION : ENTER_NETHER_PORTAL_DESCRIPTION,
    inputSchema: end ? enterEndPortalInputSchema : enterNetherPortalInputSchema,
    resultSchema: portalEntryResultSchema,
    formatResult: formatNavigateResult,
    execution: { kind: "resumable_task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: { title: end ? ENTER_END_PORTAL : ENTER_NETHER_PORTAL, destructiveHint: true, openWorldHint: true },
    parse: end ? parseEndPortalRequest : parseNetherPortalRequest,
    begin: (request, lifetime, observe) => beginPortalEntry(bot, request, dependencies, lifetime, observe),
  });
}

export const createEnterNetherPortalAction = (bot: Bot, navigation: NavigationRuntime, dependencies?: PortalEntryDependencies) => createPortalAction(bot, navigation, "nether", dependencies);
export const createEnterEndPortalAction = (bot: Bot, navigation: NavigationRuntime, dependencies?: PortalEntryDependencies) => createPortalAction(bot, navigation, "end", dependencies);
