/**
 * Dig a dry, walkable diagonal staircase from the nearest dry shore down to a
 * confirmed stronghold end-portal room.
 *
 * The descent as one route times out — the full search explores tens of
 * thousands of nodes before Pathfinder gives up — so the line to the target is
 * dug in hops no longer than `segment_length`, each a standard navigate with
 * digging on. The route stays dry because the movement policy refuses any dig
 * that would open a cell into water or lava (`opensIntoLiquid`), even when the
 * hop explicitly asks for that break; a stretch that cannot stay dry stops the
 * carve rather than flooding it. The same refusal is the hard lava guard. The
 * ~1:1 diagonal keeps every step's drop under the policy's unassisted limit, so
 * no water bucket is needed; a steeper, vertical run gets ladders instead.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { SqlBotData } from "../../bot-data/index.js";
import {
  createMovements,
  isSafeSupport,
  observeMineflayerBlock,
  type NavigationRuntime,
} from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { defineAction, type ActionContext } from "../action.js";
import { tunnelToCheckpointSchema } from "../checkpoint-schemas.js";
import { loadedStrongholdFrame } from "../locate-stronghold/locate-stronghold.js";
import { findEndFrame, outsideEndOpening, type EndPortalFrame } from "../activate-portal/end-frame.js";
import { navigate as runNavigate } from "../navigate/navigate.js";
import type { NavigateResult } from "../navigate/contract.js";
import { StrongholdLandmarks } from "./landmark-store.js";
import {
  TUNNEL_TO,
  TUNNEL_TO_DESCRIPTION,
  tunnelToInputSchema,
  tunnelToResultSchema,
  type Point,
  type TunnelToRequest,
  type TunnelToResult,
} from "./contract.js";

type Hazard = TunnelToResult["hazards"][number];

const asVec = (point: Point): Vec3 => new Vec3(point.x, point.y, point.z);
const asPoint = (vec: Vec3): Point => ({ x: vec.x, y: vec.y, z: vec.z });
const dist2d = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const dist3d = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** The integer feet cell the bot stands in. */
function feetOf(bot: Bot): Point {
  const p = bot.entity.position;
  return { x: Math.floor(p.x), y: Math.round(p.y), z: Math.floor(p.z) };
}

function passable(bot: Bot, cell: Vec3): boolean {
  const block = bot.blockAt(cell);
  return block !== null && block.boundingBox === "empty" && block.name !== "water" && block.name !== "lava";
}

function supported(bot: Bot, feet: Vec3): boolean {
  const below = bot.blockAt(feet.offset(0, -1, 0));
  return below !== null && isSafeSupport(observeMineflayerBlock(below));
}

/** Feet and head clear, and solid footing below. Unloaded cells are not standable. */
function standable(bot: Bot, feet: Vec3): boolean {
  return passable(bot, feet) && passable(bot, feet.offset(0, 1, 0)) && supported(bot, feet);
}

function liquidName(bot: Bot, cell: Vec3): "water" | "lava" | null {
  const block = bot.blockAt(cell);
  return block?.name === "water" ? "water" : block?.name === "lava" ? "lava" : null;
}

/**
 * A standable cell beside the frame to end the staircase on: as close to the
 * bot's approach as a dry, lava-free foothold allows, and always clear of the
 * portal opening so the bot never ends standing over the drop to the lava.
 */
function approachCell(bot: Bot, frame: EndPortalFrame, from: Point): Point | null {
  const center = asPoint(frame.center);
  let best: { cell: Point; distance: number } | null = null;
  for (let dx = -3; dx <= 3; dx += 1)
    for (let dz = -3; dz <= 3; dz += 1)
      for (let dy = -1; dy <= 1; dy += 1) {
        const feet = frame.center.offset(dx, dy, dz);
        if (!outsideEndOpening(frame, asPoint(feet)) || !standable(bot, feet)) continue;
        if (liquidName(bot, feet.offset(0, -1, 0)) === "lava") continue;
        const distance = dist2d(asPoint(feet), from);
        if (!best || distance < best.distance) best = { cell: asPoint(feet), distance };
      }
  void center;
  return best?.cell ?? null;
}

/** Resolve the walkable target: the caller's cell, or a foothold beside the loaded frame. */
function resolveTarget(bot: Bot, request: TunnelToRequest): Point {
  if (request.target) return request.target;
  const found = loadedStrongholdFrame(bot, bot.entity.position, 128);
  if (!found)
    throw new Error(
      "No loaded end_portal_frame within 128 blocks. Confirm the frame with locate_stronghold first, or pass target.",
    );
  const frame = findEndFrame(bot, asVec(found.position));
  const foothold = frame && approachCell(bot, frame, feetOf(bot));
  if (foothold) return foothold;
  // The sockets are loaded but no dry foothold was observed beside them yet;
  // aim two blocks out from the centre on the bot's side and let the carve's
  // final hops settle the exact landing.
  const center = frame?.center ?? asVec(found.position);
  const toward = Math.sign(bot.entity.position.z - center.z) || 1;
  return asPoint(center.offset(0, 0, 2 * toward));
}

/**
 * The nearest dry land to the target, as a horizontal aim-point. The frontier
 * records a chunk's surface-water fraction the first time the bot loads it, so
 * a fully dry chunk (`surface_water_fraction = 0`) is land the bot has already
 * seen. The exact dry column is resolved by the shore navigate itself, which
 * walks a ground target on water to the nearest standable shore.
 */
function dryShoreAim(
  bot: Bot,
  data: SqlBotData,
  target: Point,
  maxDistance: number,
): { aim: { x: number; z: number }; distance: number } | null {
  const dimension = bot.game.dimension;
  const chunks = data.read(
    "SELECT chunk_x, chunk_z FROM frontier_chunks WHERE dimension = ? AND surface_water_fraction = 0.0",
    dimension,
  );
  let best: { aim: { x: number; z: number }; distance: number } | null = null;
  for (const row of chunks) {
    const aim = { x: Number(row.chunk_x) * 16 + 8, z: Number(row.chunk_z) * 16 + 8 };
    const distance = dist2d(aim, target);
    if (distance > maxDistance) continue;
    if (!best || distance < best.distance) best = { aim, distance };
  }
  return best;
}

/** The highest standable feet height at or below a cell in its loaded column, if any. */
function groundBelow(bot: Bot, cell: Point, depth = 64): number | null {
  for (let y = cell.y; y >= cell.y - depth; y -= 1) if (standable(bot, new Vec3(cell.x, y, cell.z))) return y;
  return null;
}

/** Integer waypoints along the straight line to the target, no farther apart than one hop. */
export function decompose(from: Point, to: Point, segment: number): Point[] {
  const total = dist3d(from, to);
  const steps = Math.max(1, Math.ceil(total / segment));
  const points: Point[] = [];
  for (let i = 1; i <= steps; i += 1)
    points.push({
      x: Math.round(from.x + (to.x - from.x) * (i / steps)),
      y: Math.round(from.y + (to.y - from.y) * (i / steps)),
      z: Math.round(from.z + (to.z - from.z) * (i / steps)),
    });
  points[points.length - 1] = { ...to };
  return points;
}

/** Lava and silverfish touching a planned waypoint, for the record; the policy owns the hard refusal. */
function scanHazards(bot: Bot, waypoint: Point, silverfishBudget: number, accepted: { count: number }): Hazard[] {
  const hazards: Hazard[] = [];
  for (let dx = -1; dx <= 1; dx += 1)
    for (let dy = -1; dy <= 1; dy += 1)
      for (let dz = -1; dz <= 1; dz += 1) {
        const cell = asVec(waypoint).offset(dx, dy, dz);
        const block = bot.blockAt(cell);
        if (!block) continue;
        if (block.name === "lava") hazards.push({ kind: "lava", position: asPoint(cell), action: "avoided" });
        else if (block.name.startsWith("infested_")) {
          const accept = accepted.count < silverfishBudget;
          if (accept) accepted.count += 1;
          hazards.push({ kind: "silverfish", position: asPoint(cell), action: accept ? "accepted" : "avoided" });
        }
      }
  return hazards;
}

interface Carver {
  readonly bot: Bot;
  readonly navigation: NavigationRuntime;
  readonly context: ActionContext;
}

/** One dig-hop to an explicit cell with digging and scaffolding on. */
async function hop(carver: Carver, waypoint: Point): Promise<NavigateResult> {
  return runNavigate(
    carver.bot,
    { x: waypoint.x, y: waypoint.y, z: waypoint.z, range: 1, dig: true, scaffold: true, build: false },
    carver.context,
    { createMovements, navigate: carver.navigation.navigate },
  );
}

const UNSUPPORTED_GROUND = /ground in that column is at y=(-?\d+)/;

async function tunnelTo(
  bot: Bot,
  navigation: NavigationRuntime,
  data: SqlBotData,
  request: TunnelToRequest,
  context: ActionContext,
): Promise<TunnelToResult> {
  const dimension = bot.game.dimension;
  const landmarks = new StrongholdLandmarks(data, bot.username, dimension, request.search_id);
  const carver: Carver = { bot, navigation, context };

  const target = resolveTarget(bot, request);
  let mouth: Point | null = null;
  let portalExit: Point | null = null;
  let shoreDistanceBlocks: number | null = null;
  let segments = 0;
  let descentStart = feetOf(bot).y;
  let laddersPlaced = 0;
  let touchedWater = false;
  let touchedLava = false;
  const hazards: Hazard[] = [];
  const accepted = { count: 0 };

  const observeLiquidContact = () => {
    const feet = asVec(feetOf(bot));
    for (const cell of [feet, feet.offset(0, 1, 0), feet.offset(0, -1, 0)]) {
      const liquid = liquidName(bot, cell);
      if (liquid === "water") touchedWater = true;
      if (liquid === "lava") touchedLava = true;
    }
  };

  const report = (phase: string) => {
    const here = feetOf(bot);
    context.observeProgress?.(() => ({
      baseline: { dimension, searchId: request.search_id },
      checkpoint: {
        phase,
        target,
        mouth,
        segments,
        descent: Math.max(0, descentStart - here.y),
        touchedWater,
        touchedLava,
      },
      completion: {
        kind: "current",
        observed: dist3d(feetOf(bot), target) <= 1.5,
        owes: "The bot standing dry at the stronghold portal room.",
      },
    }));
    context.signal?.throwIfAborted();
  };

  const result = (status: TunnelToResult["status"], error?: string): TunnelToResult => {
    const arrived = feetOf(bot);
    const evidence = {
      target,
      arrived,
      reachedTarget: dist3d(arrived, target) <= 1.5,
      mouth,
      portalExit,
      shoreDistanceBlocks,
      staircase: { segments, descent: Math.max(0, descentStart - arrived.y), laddersPlaced },
      touchedWater,
      touchedLava,
      hazards,
    };
    return status === "succeeded"
      ? { status, ...evidence }
      : { status, error: error ?? "Tunnel did not complete.", ...evidence };
  };

  try {
    report("approach");
    if (dimension !== "overworld") throw new Error("Strongholds are tunnelled to only in the Overworld.");

    // Reach the dry mouth: travel to the nearest fully-dry shore, unless one is
    // already underfoot. The exact standable column is settled by the navigate.
    const aim = dryShoreAim(bot, data, target, request.max_shore_distance);
    if (aim) {
      shoreDistanceBlocks = aim.distance;
      if (dist2d(feetOf(bot), aim.aim) > 1) {
        const shore = await runNavigate(
          bot,
          { x: aim.aim.x, y: null, z: aim.aim.z, range: 1, dig: true, scaffold: true, build: false },
          context,
          { createMovements, navigate: navigation.navigate },
        );
        if (shore.status !== "succeeded")
          throw new Error(`Could not reach dry land near ${aim.aim.x}, ${aim.aim.z}: ${shore.error ?? "stopped"}`);
      }
    }
    context.signal?.throwIfAborted();
    const mouthCell = feetOf(bot);
    if (!standable(bot, asVec(mouthCell)))
      throw new Error("The staircase would begin off dry land; no standable mouth was reached.");
    mouth = mouthCell;
    landmarks.set("mouth", mouth);
    descentStart = mouthCell.y;
    report("carve");

    // Carve the diagonal, hop by hop, down to the target.
    const waypoints = decompose(mouthCell, target, request.segment_length);
    for (const waypoint of waypoints) {
      report("carve");
      hazards.push(...scanHazards(bot, waypoint, request.silverfish_budget, accepted));
      let aimed = waypoint;
      let outcome = await hop(carver, aimed);
      // Auto-y: a waypoint that fell in open air names the ground in its column.
      for (let retry = 0; retry < 3 && outcome.status !== "succeeded"; retry += 1) {
        const ground = UNSUPPORTED_GROUND.exec(outcome.error ?? "");
        const groundY = ground ? Number(ground[1]) : groundBelow(bot, aimed);
        if (groundY === null || groundY === aimed.y) break;
        aimed = { ...aimed, y: groundY };
        outcome = await hop(carver, aimed);
      }
      observeLiquidContact();
      if (outcome.status !== "succeeded") {
        // A hop that cannot stay dry (the policy refused a break into liquid)
        // or is otherwise blocked stops the carve. The bot is parked on the
        // last dry step and the mouth is saved, so a retry resumes from here.
        const near = hazards.find((h) => h.kind === "lava" && dist3d(h.position, aimed) <= 2);
        if (near) near.action = "rerouted";
        throw new Error(`Staircase stopped before ${aimed.x}, ${aimed.y}, ${aimed.z}: ${outcome.error ?? "stopped"}`);
      }
      segments += 1;
    }

    const arrived = feetOf(bot);
    if (dist3d(arrived, target) > 1.5)
      throw new Error(`Carve ended ${dist3d(arrived, target).toFixed(1)} blocks from the target at ${target.x}, ${target.y}, ${target.z}.`);
    portalExit = arrived;
    landmarks.set("portal_exit", portalExit);
    observeLiquidContact();
    report("arrived");

    if (touchedWater || touchedLava)
      return result("partial", `Reached the target but the route contacted ${touchedWater ? "water" : "lava"}.`);
    return result("succeeded");
  } catch (error) {
    if (context.signal?.aborted) throw error;
    return result(mouth ? "partial" : "failed", error instanceof Error ? error.message : String(error));
  }
}

export function formatTunnelToResult(result: TunnelToResult): string {
  const place = result.reachedTarget
    ? `Standing at the portal room, ${result.arrived?.x}, ${result.arrived?.y}, ${result.arrived?.z}.`
    : `Did not reach the portal room; at ${result.arrived?.x}, ${result.arrived?.y}, ${result.arrived?.z}.`;
  const dry =
    result.touchedWater || result.touchedLava
      ? `Route contacted ${[result.touchedWater ? "water" : null, result.touchedLava ? "lava" : null].filter(Boolean).join(" and ")}.`
      : "Route stayed dry: no water or lava contact.";
  const stair = `Staircase: ${result.staircase.segments} hops, descended ${result.staircase.descent} blocks, ${result.staircase.laddersPlaced} ladders.`;
  const shore =
    result.mouth && result.shoreDistanceBlocks !== null
      ? `Mouth at ${result.mouth.x}, ${result.mouth.y}, ${result.mouth.z} (${Math.round(result.shoreDistanceBlocks)} blocks from the frame).`
      : "No dry mouth was established.";
  const hazardNote = result.hazards.length
    ? `\n\nHazards: ${result.hazards
        .map((h) => `${h.kind} ${h.action} at ${h.position.x}, ${h.position.y}, ${h.position.z}`)
        .join("; ")}.`
    : "";
  return `${place}\n\n${dry} ${stair}\n\n${shore}${hazardNote}${result.status === "succeeded" ? "" : `\n\n${result.error ?? ""}`}`;
}

export function createTunnelToAction(bot: Bot, navigation: NavigationRuntime, data: SqlBotData) {
  return defineAction({
    checkpointSchema: tunnelToCheckpointSchema,
    name: TUNNEL_TO,
    description: TUNNEL_TO_DESCRIPTION,
    inputSchema: tunnelToInputSchema,
    resultSchema: tunnelToResultSchema,
    parse: (input) => tunnelToInputSchema.parse(input ?? {}),
    execution: { kind: "resumable_task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: { title: TUNNEL_TO, destructiveHint: true, openWorldHint: true },
    formatResult: formatTunnelToResult,
    begin: (request) => (context) => tunnelTo(bot, navigation, data, request, context),
  });
}
