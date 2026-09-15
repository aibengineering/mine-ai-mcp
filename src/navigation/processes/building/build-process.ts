/**
 * Make every cell of a structure hold its block.
 *
 * This is Baritone's `BuilderProcess`, and it keeps that shape: every tick it
 * finds the cells that are wrong, breaks the wrong ones in reach, places the
 * placeable ones in reach without moving, and otherwise hands the pathing
 * behaviour one composite goal of the cells it can work next, revalidated as
 * the world changes rather than reissued. So the goal here is the same kind of
 * continuously evaluated object `MineProcess` uses: every time the planner
 * takes a snapshot it reclassifies the structure, and a route already running
 * walks on to whatever is workable now.
 *
 * What is left out is Baritone's schematic-aware cost context, in which a
 * route lays correct blocks as its own scaffolding. No structure asked for
 * here is tall enough to need it, and that context is what made Baritone's
 * builder hard.
 *
 * Two rules Baritone does not have. A placement never goes into the bot's own
 * cells and never seals the bot in: standing inside a structure it is asked to
 * close, the bot steps out first. And cells already correct are protected from
 * the route that reaches the next one.
 *
 * The result is every cell's final state, so a caller can say not only how
 * many cells are still wrong but why each one was left: it holds another
 * block, nothing is there to place against, its block is not carried, placing
 * it would seal the bot in, or the server or the pathfinder refused it. The
 * first ten live calls of the action above this all failed, and the model
 * retried blind, because the audit only counted.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { asVec3 } from "../../../utils/index.js";
import {
  findPlacementSupport,
  isAir,
  isReplaceableForPlacement,
  type BlockPlacement,
  type BlockPlacementResult,
  type WorldBlock,
} from "../../../world/index.js";
import {
  anyGoal,
  describeCalculationFailure,
  nearGoal,
  packKey,
  type BlockPosition,
  type BreakBlockInPlace,
  type Goal,
  type MovementPolicy,
  type Navigate,
  type NavigationResult,
} from "../../index.js";
import type { Position3 } from "../../world/world.js";

/**
 * How far a cell may be from the feet to be worked without moving, measured
 * feet cell to cell the way `nearGoal` measures arrival, so a route that
 * reports "already there" and the in-reach test agree; the first live run
 * looped on their disagreement. Four blocks between cells keeps the eyes within
 * the server's 4.5-block use reach in every direction.
 */
export const BUILD_REACH = 4;

/**
 * How far a flood fill looks for open ground before calling the bot sealed in.
 * Three blocks beyond the structure is past any wall it could be asked to
 * close, so a doorway or an open top lets the fill out.
 */
const ENCLOSURE_MARGIN = 3;

/**
 * Passes that change nothing before the process stops. One covers a route that
 * completed without bringing anything into reach; a second in a row means the
 * world and the loop disagree about what is workable, and continuing would
 * only repeat the disagreement.
 */
const IDLE_PASSES = 2;

/**
 * How often the classification actually looks at the world again. The planner
 * asks for a snapshot far more often than the world changes, and every cell is
 * several block reads; the mine process throttles its rescan the same way.
 */
const REFRESH_MS = 250;

const NEIGHBOURS = [
  new Vec3(1, 0, 0),
  new Vec3(-1, 0, 0),
  new Vec3(0, 1, 0),
  new Vec3(0, -1, 0),
  new Vec3(0, 0, 1),
  new Vec3(0, 0, -1),
] as const;

export interface BuildCell {
  readonly position: BlockPosition;
  readonly blockName: string;
}

/** What one cell of the structure is, as of the last look at the world. */
export type BuildCellState =
  | { readonly kind: "correct" }
  /** Empty enough, something solid beside it, its block carried, and safe to fill. */
  | { readonly kind: "placeable"; readonly support: WorldBlock; readonly face: Vec3 }
  /** Holds another block, and the request allows digging it out; a cell asked to be air always does. */
  | { readonly kind: "diggable"; readonly holds: string }
  /** Holds another block, and the request leaves such cells alone. */
  | { readonly kind: "blocked"; readonly holds: string }
  /** Not loaded, so nothing is known until the bot is nearer. */
  | { readonly kind: "unloaded" }
  /** Nothing solid on any side to place against. */
  | { readonly kind: "unsupported" }
  | { readonly kind: "not_carried" }
  /** Filling it would leave the bot's feet with no way out. */
  | { readonly kind: "would_enclose" }
  /** The bot's own feet or head. */
  | { readonly kind: "occupied" }
  /** A placement, dig, or route to it failed; it is not tried again this run. */
  | { readonly kind: "refused"; readonly reason: string };

export interface BuildRequest {
  readonly cells: readonly BuildCell[];
  readonly removeWrongBlocks: boolean;
  /**
   * The route policy, given the live set of packed cells the route must never
   * dig: the structure's correct cells, kept current by the process.
   */
  readonly movements: (protectedCells: ReadonlySet<number>) => MovementPolicy;
  readonly route: Navigate;
  readonly breakInPlace: BreakBlockInPlace;
  /** Whether the target has a reachable visible face from these feet. */
  readonly canSeeDig: (target: BlockPosition, standing: Position3) => boolean;
  /** Injectable physical placement for process regressions. */
  readonly place: (placement: BlockPlacement) => Promise<BlockPlacementResult>;
  readonly signal?: AbortSignal;
  /** A policy stop observed between completed cell operations/routes. */
  readonly stopSignal?: AbortSignal;
}

export interface BuildResult {
  readonly status: "complete" | "stopped";
  /** Why the run stopped short, when one event rather than the cell states explains it. */
  readonly reason: string | null;
  readonly placed: number;
  readonly dug: number;
  readonly passes: number;
  readonly cells: readonly { readonly cell: BuildCell; readonly state: BuildCellState }[];
}

const keyOf = (position: BlockPosition) => packKey(position.x, position.y, position.z);
const isSolid = (block: WorldBlock | null): boolean => block?.boundingBox === "block";

function feetOf(bot: Bot): Vec3 {
  return bot.entity.position.floored();
}

function withinReach(bot: Bot, position: BlockPosition): boolean {
  return feetOf(bot).distanceTo(asVec3(position)) <= BUILD_REACH;
}

/**
 * Whether the bot's feet would be sealed in once `filled` holds blocks: a
 * flood fill through passable cells from the feet that never reaches beyond
 * the structure's surroundings. The world's own blocks bound the fill too, so
 * a floor under a roofed box counts, and a doorway lets the fill out.
 */
export function enclosesBot(
  bot: Bot,
  feet: Vec3,
  filled: ReadonlySet<number>,
  bounds: { readonly min: Vec3; readonly max: Vec3 },
): boolean {
  const min = bounds.min.offset(-ENCLOSURE_MARGIN, -ENCLOSURE_MARGIN, -ENCLOSURE_MARGIN);
  const max = bounds.max.offset(ENCLOSURE_MARGIN, ENCLOSURE_MARGIN, ENCLOSURE_MARGIN);
  const blocked = (position: Vec3) => filled.has(keyOf(position)) || isSolid(bot.blockAt(position));
  if (blocked(feet)) return true;
  const seen = new Set<number>([keyOf(feet)]);
  const queue = [feet];
  while (queue.length > 0) {
    const current = queue.pop()!;
    for (const step of NEIGHBOURS) {
      const next = current.plus(step);
      if (next.x < min.x || next.y < min.y || next.z < min.z || next.x > max.x || next.y > max.y || next.z > max.z) {
        return false;
      }
      const key = keyOf(next);
      if (seen.has(key) || blocked(next)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return true;
}

function boundsOf(cells: readonly BuildCell[]): { min: Vec3; max: Vec3 } {
  const min = new Vec3(Infinity, Infinity, Infinity);
  const max = new Vec3(-Infinity, -Infinity, -Infinity);
  for (const { position } of cells) {
    min.set(Math.min(min.x, position.x), Math.min(min.y, position.y), Math.min(min.z, position.z));
    max.set(Math.max(max.x, position.x), Math.max(max.y, position.y), Math.max(max.z, position.z));
  }
  return { min, max };
}

function carriedCounts(bot: Bot): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
  return counts;
}

/**
 * Everything one build remembers between looks at the world: the state of
 * every cell, the cells refused this run, and the tally. It is shared by the
 * loop and the goal because they ask the same question at different rates,
 * and one cache means they can never disagree about what is workable.
 */
class BuildTargeting {
  readonly #states = new Map<number, BuildCellState>();
  readonly #refused = new Map<number, string>();
  /** The correct cells as packed keys, handed to the movement policy and kept current. */
  readonly protectedCells = new Set<number>();
  readonly #bounds: { readonly min: Vec3; readonly max: Vec3 };
  #refreshedAtMs = Number.NEGATIVE_INFINITY;
  placed = 0;
  dug = 0;
  passes = 0;

  constructor(
    private readonly bot: Bot,
    private readonly request: BuildRequest,
  ) {
    this.#bounds = boundsOf(request.cells);
  }

  /** Work done or given up on, whose standing still across passes means the run is idle. */
  get progress(): number {
    return this.placed + this.dug + this.#refused.size;
  }

  refuse(cell: BuildCell, reason: string): void {
    this.#refused.set(keyOf(cell.position), reason);
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
  }

  /** Baritone's `blacklistClosestOnFailure`: the target nearest the failure is given up on, not the build. */
  refuseClosest(position: BlockPosition, reason: string): boolean {
    const origin = asVec3(position);
    let closest: BuildCell | null = null;
    for (const target of this.targets()) {
      if (
        closest === null ||
        asVec3(target.position).distanceSquared(origin) < asVec3(closest.position).distanceSquared(origin)
      )
        closest = target;
    }
    if (closest === null) return false;
    this.refuse(closest, reason);
    return true;
  }

  refresh(): void {
    this.#refreshedAtMs = Number.NEGATIVE_INFINITY;
    this.states();
  }

  /** Every cell's state, reclassifying the world at most every `REFRESH_MS`. */
  states(now = Date.now()): ReadonlyMap<number, BuildCellState> {
    if (now - this.#refreshedAtMs < REFRESH_MS) return this.#states;
    const bot = this.bot;
    const feet = feetOf(bot);
    const head = feet.offset(0, 1, 0);
    const carried = carriedCounts(bot);

    this.#states.clear();
    this.protectedCells.clear();
    for (const cell of this.request.cells) {
      if (cell.blockName === "air") continue;
      const block = bot.blockAt(asVec3(cell.position));
      if (block?.name === cell.blockName) this.protectedCells.add(keyOf(cell.position));
    }
    for (const cell of this.request.cells) {
      this.#states.set(keyOf(cell.position), this.classify(cell, feet, head, carried));
    }
    this.#refreshedAtMs = Date.now();
    return this.#states;
  }

  private classify(cell: BuildCell, feet: Vec3, head: Vec3, carried: ReadonlyMap<string, number>): BuildCellState {
    const position = asVec3(cell.position);
    const block = this.bot.blockAt(position);
    if (block === null) return { kind: "unloaded" };
    if (block.name === cell.blockName || (cell.blockName === "air" && isAir(block))) return { kind: "correct" };
    const refused = this.#refused.get(keyOf(cell.position));
    if (refused !== undefined) return { kind: "refused", reason: refused };
    // A cell asked to be air can only be dug clear, so asking is allowing.
    if (cell.blockName === "air") return { kind: "diggable", holds: block.name };
    if (!isReplaceableForPlacement(block)) {
      return this.request.removeWrongBlocks
        ? { kind: "diggable", holds: block.name }
        : { kind: "blocked", holds: block.name };
    }
    if (position.equals(feet) || position.equals(head)) return { kind: "occupied" };
    const placement = findPlacementSupport(this.bot, position);
    if (!placement) return { kind: "unsupported" };
    if ((carried.get(cell.blockName) ?? 0) === 0) return { kind: "not_carried" };
    const after = new Set(this.protectedCells);
    after.add(keyOf(cell.position));
    if (enclosesBot(this.bot, feet, after, this.#bounds)) return { kind: "would_enclose" };
    return { kind: "placeable", support: placement.support, face: placement.face };
  }

  stateOf(cell: BuildCell): BuildCellState {
    return this.states().get(keyOf(cell.position)) ?? { kind: "unloaded" };
  }

  canWorkFrom(cell: BuildCell, standing: Position3): boolean {
    return this.stateOf(cell).kind !== "diggable" || this.request.canSeeDig(cell.position, standing);
  }

  wrong(): readonly BuildCell[] {
    return this.request.cells.filter((cell) => this.stateOf(cell).kind !== "correct");
  }

  /**
   * The cells worth going to, lowest first and nearest on a tie, so a wall
   * rises from its supports: those placeable or diggable now, and those not
   * loaded yet, which become one or the other once the bot is near them.
   */
  targets(): readonly BuildCell[] {
    const from = this.bot.entity.position;
    return this.request.cells
      .filter((cell) => {
        const kind = this.stateOf(cell).kind;
        return kind === "placeable" || kind === "diggable" || kind === "unloaded";
      })
      .sort(
        (left, right) =>
          left.position.y - right.position.y ||
          asVec3(left.position).distanceTo(from) - asVec3(right.position).distanceTo(from),
      );
  }

  /** The bot is standing where the structure needs a block. */
  standingInStructure(): boolean {
    return this.request.cells.some((cell) => this.stateOf(cell).kind === "occupied");
  }

  /** Every remaining placement would seal the bot in, so it has to leave before any of them. */
  onlyEnclosing(): boolean {
    return (
      this.targets().length === 0 && this.request.cells.some((cell) => this.stateOf(cell).kind === "would_enclose")
    );
  }

  /** Any cell beside the structure but outside its bounds is a way out. */
  outsideGoal(): Goal {
    const feet = feetOf(this.bot);
    return nearGoal({ x: this.#bounds.max.x + 2, y: feet.y, z: this.#bounds.max.z + 2 }, 2);
  }

  private workGoal(target: BuildCell): Goal {
    const approach = nearGoal(target.position, BUILD_REACH);
    return {
      resolve: (observation) => {
        const spatial = approach.resolve(observation);
        if (spatial.kind === "invalid" || this.stateOf(target).kind !== "diggable") return spatial;
        return {
          ...spatial,
          revision: `visible-dig:${spatial.revision}`,
          isSatisfied: (node, world) =>
            spatial.isSatisfied(node, world) &&
            this.canWorkFrom(target, {
              x: node.feet.x + 0.5,
              y: node.feet.y,
              z: node.feet.z + 0.5,
            }),
        };
      },
    };
  }

  /**
   * The goal Baritone revalidates rather than reissues: within reach of any
   * workable cell. Every snapshot is a fresh look at the structure, so a route
   * already running walks on to whatever is workable now.
   */
  goal(): Goal {
    return {
      resolve: (observation) => {
        const targets = this.targets();
        if (targets.length === 0) return { kind: "invalid", observation: "No workable cell remains." } as const;
        return anyGoal(targets.map((target) => this.workGoal(target))).resolve(observation);
      },
    };
  }

  identity(): string {
    return this.targets()
      .map((target) => keyOf(target.position))
      .join("|");
  }

  result(status: BuildResult["status"], reason: string | null): BuildResult {
    this.refresh();
    return {
      status,
      reason,
      placed: this.placed,
      dug: this.dug,
      passes: this.passes,
      cells: this.request.cells.map((cell) => ({ cell, state: this.stateOf(cell) })),
    };
  }
}

/**
 * Baritone's builder breaks and places in reach before it will consider
 * pathing anywhere. Lowest first, refreshing after each so a cell placed this
 * pass supports the next; a cell that fails is refused for the run.
 */
async function workInReach(
  bot: Bot,
  request: BuildRequest,
  targeting: BuildTargeting,
  movements: MovementPolicy,
  signal?: AbortSignal,
): Promise<boolean> {
  let worked = false;
  // The bot has usually just arrived somewhere, so what is in reach, occupied,
  // or enclosing is not what the last look said.
  targeting.refresh();
  for (;;) {
    signal?.throwIfAborted();
    if (request.stopSignal?.aborted) return worked;
    const target = targeting
      .targets()
      .find((cell) => withinReach(bot, cell.position) && targeting.canWorkFrom(cell, bot.entity.position));
    if (!target) return worked;
    const state = targeting.stateOf(target);
    if (state.kind === "diggable") {
      const dug = await request.breakInPlace({ movements, position: target.position, signal });
      if (dug.status === "broken") targeting.dug += 1;
      else targeting.refuse(target, dug.reason);
    } else if (state.kind === "placeable") {
      const item = bot.inventory.items().find((candidate) => candidate.name === target.blockName)!;
      const placed = await request.place({
        item,
        support: state.support,
        face: state.face,
        expectedCells: [target.position],
        matches: (block) => block.name === target.blockName,
        signal,
      });
      if (placed.kind === "placed") targeting.placed += 1;
      else targeting.refuse(target, placed.error);
    } else {
      // A cell within reach that still reads as unloaded is nothing to work on.
      return worked;
    }
    worked = true;
    targeting.refresh();
  }
}

export async function build(bot: Bot, request: BuildRequest): Promise<BuildResult> {
  const targeting = new BuildTargeting(bot, request);
  const movements = request.movements(targeting.protectedCells);
  let idlePasses = 0;

  for (;;) {
    request.signal?.throwIfAborted();
    if (request.stopSignal?.aborted) return targeting.result("stopped", String(request.stopSignal.reason));
    targeting.passes += 1;
    targeting.refresh();
    if (targeting.wrong().length === 0) return targeting.result("complete", null);
    const progressBefore = targeting.progress;

    // Standing in a cell the structure needs means every placement around it
    // would either be refused or wall the bot into a pit, so step out first;
    // likewise when every remaining placement would seal the bot in.
    if (targeting.standingInStructure() || targeting.onlyEnclosing()) {
      const exit = await request.route({ movements, goal: targeting.outsideGoal(), signal: request.signal, stopSignal: request.stopSignal });
      if (exit.status === "stopped") {
        return targeting.result("stopped", `could not step out of the structure: ${exit.reason}`);
      }
      continue;
    }

    if (await workInReach(bot, request, targeting, movements, request.signal)) {
      idlePasses = 0;
      continue;
    }
    if (targeting.targets().length === 0) return targeting.result("stopped", null);

    const routed = targeting.identity();
    const route = await runRoute(bot, request, targeting, movements);
    if (route.status === "stopped") {
      targeting.refresh();
      if (request.stopSignal?.aborted) return targeting.result("stopped", String(request.stopSignal.reason));
      // A goal the search could not reach is not a reason to abandon the build,
      // only that cell — unless the targets already changed underneath it.
      if (targeting.identity() === routed && !targeting.refuseClosest(feetOf(bot), route.reason)) {
        return targeting.result("stopped", route.reason);
      }
    }

    idlePasses = targeting.progress === progressBefore ? idlePasses + 1 : 0;
    if (idlePasses >= IDLE_PASSES) {
      return targeting.result("stopped", `${IDLE_PASSES} passes changed nothing; last route ${route.status}`);
    }
  }
}

/** One leg: walk under a goal that keeps re-evaluating, working every arrival, until nothing workable remains. */
async function runRoute(
  bot: Bot,
  request: BuildRequest,
  targeting: BuildTargeting,
  movements: MovementPolicy,
): Promise<NavigationResult> {
  return request.route({
    movements,
    goal: targeting.goal(),
    onArrival: async ({ signal }) => {
      // An arrival that works nothing ends the route: continuing would ask the
      // navigator the same question from the same place, and the loop above
      // counts idle passes where a route cannot.
      if (!(await workInReach(bot, request, targeting, movements, signal))) return { kind: "completed" };
      targeting.refresh();
      const more = targeting.targets().length > 0 && !targeting.standingInStructure();
      return more ? { kind: "continue" } : { kind: "completed" };
    },
    onCalculationFailure: async ({ failure, observation }) => {
      targeting.refuseClosest(observation.position, describeCalculationFailure(failure));
      targeting.refresh();
      return targeting.targets().length > 0 ? { kind: "continue" } : { kind: "completed" };
    },
    signal: request.signal,
    stopSignal: request.stopSignal,
  });
}
