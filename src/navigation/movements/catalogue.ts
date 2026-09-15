import { waterableLanding } from "../world/water-landing.js";
import {
  isClimbable,
  isDry,
  isFalling,
  isHeadPassable,
  isLiquid,
  isPassable,
  isSafeSupport,
  isSolid,
  isStandableTop,
  isWater,
} from "../world/block-geometry.js";
import { waterOccupancy } from "../world/water.js";
import { admitsDive } from "../world/swimming.js";
import { type CellRole, ExpansionCells, FEET, HEAD, NO_CELL, policyPenalty } from "./expansion-cells.js";
import { type GeneratedMovements, MovementCandidates } from "./movement-candidates.js";
/**
 * The movement catalogue: every transition search may consider from one
 * planning state, priced and with its world effects predicted.
 *
 * `generate` is the graph's edge function. It only collects. Each movement
 * family answers for itself from one prepared view of where the step leads:
 * sideways there are ascend, traverse, swim, bridge, fall, and descend; every
 * cardinal offers all of them and, when both corners are clear, a diagonal
 * offers the ones that keep the box off the corner; then the gap jumps, and
 * finally the vertical family, straight-down dig, climb, and pillar. A family never stands in for another, so the search
 * always prices the real alternatives. Nothing here touches the bot.
 *
 * Every movement is built from prepared cells. `prepareCell` answers, for one
 * block the movement needs clear, whether the route may pass it as it is,
 * open it, or dig it out, and what that costs. A cell is prepared once per
 * expansion however many movements share it, and lives in the expansion's
 * cell grid as columns; a movement names its cells by handle.
 *
 * Search expands tens of thousands of nodes and walks a route of fifty steps,
 * so generation is written to allocate almost nothing: cells are named by
 * three integer coordinates rather than position objects, and the movements
 * offered are rows of columns in `MovementCandidates`, each only its cost,
 * the cell it leads to, and the cells it assumed. A movement object exists
 * only for the rows search keeps, and the full `PlannedStep`, with its
 * preconditions (the block states it assumed), its operations (the breaks,
 * placements, activations, and finally the move), and its predicted effects,
 * is built the first time something reads `step`, which only happens for the
 * steps of a route about to be walked.
 */
import type { PlanningNode } from "../goals/goal.js";
import type { PlanningOverlay } from "../search/planning-overlay.js";
import {
  type BlockObservation,
  type BlockPosition,
  type LoadedBlock,
  type PlayerState,
  type WorldView,
  SPRINT_FOOD_MINIMUM,
  UNLOADED,
  activationGroupAt,
  packKey,
} from "../world/world.js";
import type { PlannedStep } from "./movement.js";
import type { DigContext, MovementPolicy, ScaffoldSelection } from "./policy.js";

import type { StepField } from "../step-field.js";
import { type StanceSight, priceExcavation, releasesLava, stanceSight } from "./excavation.js";

export type { GeneratedMovements } from "./movement-candidates.js";

export interface PlanningState {
  readonly node: PlanningNode;
  readonly overlay: PlanningOverlay;
}

/**
 * One transition out of a planning state.
 *
 * A movement made by the catalogue reads its cells from the catalogue's
 * grid, which the next expansion overwrites, so it is only good until the
 * catalogue's next `generate`: search reads `state` as it keeps a movement
 * and `step` straight after regenerating it. A goal's finish movement is
 * self-contained.
 */
export interface GeneratedMovement {
  /** The feet cell the movement ends in, and the scaffolds left on arrival: what names the arrival state. */
  readonly to: BlockPosition;
  readonly remainingScaffolds: number;
  /** The movement's total cost in ticks, the one number search prices with. */
  readonly cost: number;
  /**
   * Where the movement leads: the destination node and the overlay after its
   * predicted effects. Built on first read, because search decides from `to`,
   * `remainingScaffolds`, and `cost` whether an arrival is worth keeping, and
   * half of them are not.
   */
  readonly state: PlanningState;
  /** The full step, built on first read; only the steps of a walked route are ever read. */
  readonly step: PlannedStep;
}

/** What is true for every expansion of one search: the world, the policy, the player, and the cells to keep. */
export interface GenerationContext {
  readonly world: WorldView;
  readonly policy: MovementPolicy;
  readonly player: PlayerState;
  /** Feet cells the route has stood on; a dig may not open the cell under one. */
  readonly protectedFeet?: ReadonlySet<number>;
  /**
   * A caller-supplied price on standing somewhere, frozen for this search.
   *
   * Null is the common case and costs nothing to ask about. The field never
   * refuses a cell; only the policy can do that.
   */
  readonly stepField?: StepField | null;
}

/** The generation context plus what changes per expansion: the state, the dig context, and what this node has prepared. */
export interface MovementGenerationContext extends GenerationContext {
  readonly state: PlanningState;
  readonly digContext: DigContext;
  /** The policy's scaffold, read once: a live policy chooses it from the inventory each time it is asked. */
  readonly scaffold: ScaffoldSelection | null;
  /** The world as this expansion's overlay shows it, each cell read once, for the pricing that reads a view. */
  readonly view: WorldView;
  /** The cells looked at and prepared so far this expansion. */
  readonly cells: ExpansionCells;
  /** What the eye can see from where the bot stands, shared by every movement that digs. */
  readonly sight: StanceSight;
  /** The cell the feet are in and the one under it, as this expansion sees them: every family asks about the stance. */
  readonly feetCell: BlockObservation;
  readonly support: BlockObservation;
  /** The cell the head rises into when the bot jumps, two above the feet, prepared once: an ascent or a gap jump in any direction passes it. */
  readonly takeoffHead: number;
}

export interface MovementCatalogue {
  /**
   * Every transition search may consider from `state`, priced and with its
   * effects predicted. The rows are the catalogue's own and are overwritten by
   * the next call; so are the movements read out of them.
   */
  generate(state: PlanningState, context: GenerationContext, digContext: DigContext): GeneratedMovements;
}

const CARDINALS = [
  { x: 1, z: 0 },
  { x: -1, z: 0 },
  { x: 0, z: 1 },
  { x: 0, z: -1 },
] as const;
const DIAGONALS = [
  { x: 1, z: 1 },
  { x: 1, z: -1 },
  { x: -1, z: 1 },
  { x: -1, z: -1 },
] as const;

/**
 * Sprinting is a physical capability, not a preference.
 *
 * Minecraft refuses to sprint at or below six food. A sprint edge priced at
 * four ticks per block then executes at walking speed, and a three-block
 * sprint_jump becomes uncrossable: the bot jumps short, falls, fails the
 * movement, replans, and repeats until no-progress ends the run. The catalogue
 * already offers walking alternatives, so refusing to generate the edge is
 * enough.
 */
function canSprint(context: MovementGenerationContext): boolean {
  return context.policy.allowSprinting && context.player.food >= SPRINT_FOOD_MINIMUM;
}

/** The cell as this expansion's overlay shows it. */
function look(context: MovementGenerationContext, x: number, y: number, z: number): BlockObservation {
  return context.cells.look(x, y, z);
}

/** Baritone sprints a traverse only when one more body-length is safe. */
function sprintLookaheadClear(
  context: MovementGenerationContext,
  x: number,
  y: number,
  z: number,
  dx: number,
  dz: number,
): boolean {
  const intoX = x + dx;
  const intoZ = z + dz;
  for (let dy = 0; dy <= 1; dy += 1) {
    if (look(context, intoX, y + dy, intoZ).kind === "unloaded") return false;
    if (context.cells.stepPenalty(intoX, y + dy, intoZ, context.policy) === null) return false;
  }
  return true;
}

/** The cell as this expansion sees it, prepared once for a movement's feet and shared by every movement that needs it: its handle, or `NO_CELL`. */
function prepareCell(x: number, y: number, z: number, context: MovementGenerationContext): number {
  return prepare(x, y, z, context, FEET);
}

/** The same cell, asked whether the bot's head and chest fit through it. */
function prepareHeadCell(x: number, y: number, z: number, context: MovementGenerationContext): number {
  return prepare(x, y, z, context, HEAD);
}

function prepare(x: number, y: number, z: number, context: MovementGenerationContext, role: CellRole): number {
  const cells = context.cells;
  const slot = cells.prepareSlot(x, y, z);
  return cells.prepared(slot, role) ?? evaluateCell(x, y, z, context, role, slot);
}

function canOccupyWater(context: MovementGenerationContext, x: number, y: number, z: number): boolean {
  if (!context.policy.allowSwimming) return false;
  const occupancy = waterOccupancy(context.view.blockAt, x, y, z);
  if (occupancy === "submerged") return context.policy.dive !== undefined &&
    admitsDive(context.view.blockAt, { x, y, z }, context.policy.dive);
  return occupancy !== "unavailable";
}

/** Whether the cell may be passed as it stands: wading for water, the block's own geometry otherwise. */
function passableAs(
  role: CellRole,
  block: LoadedBlock,
  context: MovementGenerationContext,
  x: number,
  y: number,
  z: number,
) {
  if (isWater(block)) return canOccupyWater(context, x, role === FEET ? y : y - 1, z);
  return role === FEET ? isPassable(block) : isHeadPassable(block);
}

function evaluateCell(
  x: number,
  y: number,
  z: number,
  context: MovementGenerationContext,
  role: CellRole,
  slot: number,
): number {
  const cells = context.cells;
  const block = cells.lookSlot(slot, x, y, z);
  if (block.kind === "unloaded") return cells.refuse(slot, role);
  if (passableAs(role, block, context, x, y, z)) return cells.passable(slot, role, x, y, z, block.stateId);
  if (!cells.clearanceKnown(slot)) settleClearance(x, y, z, block, context, slot);
  return cells.viaClearance(slot, role);
}

/**
 * Work out what it takes to pass a cell that cannot be passed as it stands,
 * and keep it in its slot: an activation, one dig, a falling column, or a
 * refusal. Asked once per solid cell an expansion touches, so it allocates
 * nothing for the common answer, one dig priced by what its state settles.
 */
function settleClearance(
  x: number,
  y: number,
  z: number,
  block: LoadedBlock,
  context: MovementGenerationContext,
  slot: number,
): void {
  const cells = context.cells;
  const policy = context.policy;
  if (isLiquid(block)) {
    cells.refuseClearance(slot);
    return;
  }
  if (block.traits.openable && policy.allowDoors) {
    cells.settleOpening(slot, x, y, z, block.stateId, activationGroupAt(block, { x, y, z }), 1);
    return;
  }
  if (!policy.allowDigging) {
    cells.refuseClearance(slot);
    return;
  }
  // What removing this cell releases from above. A fluid pours in and is not
  // modelled, so it still refuses. A falling column is different: Baritone
  // charges its mining time into the target's own cost —
  // `getMiningDurationTicks` with `includeFalling` recurses upward — and mines
  // through it. Refusing instead makes every cell of a sand column unreachable,
  // and a mining goal that names one can never be satisfied.
  let top = y;
  for (;;) {
    const block = look(context, x, top + 1, z);
    if (!isDry(block)) {
      cells.refuseClearance(slot);
      return;
    }
    if (!isFalling(block)) break;
    top += 1;
  }
  if (top === y) {
    // Nearly every cell has nothing falling above it and is one dig, priced
    // from the block in hand by what its state settles. The rules that read
    // around the cell, the policy's and the lava beside it, are asked of the
    // digs search keeps, when a movement is settled.
    const evaluation = policy.priceBreak(block, x, y, z, context.view);
    if (evaluation.decision.kind === "prohibited") {
      cells.refuseClearance(slot);
      return;
    }
    cells.settleDig(
      slot,
      x,
      y,
      z,
      block.stateId,
      policy.digTimeEstimator.estimate(block, evaluation.tool, context.digContext),
      evaluation.decision.kind === "penalized" ? evaluation.decision.cost : 0,
      evaluation.tool.itemType,
    );
    return;
  }
  // A column is priced top down, every dig of it confirmed where it is, and
  // the lava rule asked of its foot here: a column is rare.
  if (releasesLava(context.view.blockAt, x, y, z)) {
    cells.refuseClearance(slot);
    return;
  }
  const excavation = priceExcavation({
    world: context.view,
    policy,
    position: { x, y, z },
    digContext: context.digContext,
  });
  if (excavation.kind === "unavailable") {
    cells.refuseClearance(slot);
    return;
  }
  cells.settleColumn(slot, x, y, z, block.stateId, excavation.digs);
}

// ── Lateral movements ─────────────────────────────────────────────────────────────────────

/**
 * One step sideways as every lateral family sees it: the destination column
 * at the source's own height, gated once by the policy and prepared once.
 *
 * Each family answers only for itself, whether it can be done from here and
 * what it costs, and the search prices the candidates against each other. No
 * family stands in for another. The day a placement step pre-empted the drop
 * beneath it, a bot with cobblestone in its pockets lost every plain drop in
 * its graph and descended an open staircase by digging the floor out from
 * under each tread.
 */
class Approach {
  dx = 0;
  dz = 0;
  x = 0;
  y = 0;
  z = 0;
  diagonal = false;
  /** A diagonal covers sqrt(2) blocks for the same input and is charged for the distance it travels. */
  tickScale = 1;
  /** The destination cells at the source's height, prepared: handles, or `NO_CELL`. */
  feet = NO_CELL;
  head = NO_CELL;
  /** The destination cell and the one beneath it, as observed. */
  target: BlockObservation = UNLOADED;
  below: BlockObservation = UNLOADED;

  /**
   * Point at the column `dx`, `dz` from the feet and prepare it. One instance
   * serves every direction of an expansion in turn, because the families read
   * a direction out before the next is aimed; eight per expansion added up.
   */
  aim(context: MovementGenerationContext, dx: number, dz: number): this {
    const from = context.state.node.feet;
    const x = from.x + dx;
    const y = from.y;
    const z = from.z + dz;
    const diagonal = dx !== 0 && dz !== 0;
    this.dx = dx;
    this.dz = dz;
    this.x = x;
    this.y = y;
    this.z = z;
    this.diagonal = diagonal;
    this.tickScale = diagonal ? Math.SQRT2 : 1;
    this.feet = prepareCell(x, y, z, context);
    this.head = prepareHeadCell(x, y + 1, z, context);
    this.target = look(context, x, y, z);
    this.below = look(context, x, y - 1, z);
    return this;
  }
}

function canPlace(context: MovementGenerationContext): boolean {
  return context.policy.allowPlacing && context.scaffold !== null && context.state.node.remainingScaffolds > 0;
}

/** Up one block onto the destination's tread, natural or placed: Baritone's MovementAscend. */
function ascend(context: MovementGenerationContext, a: Approach, out: MovementCandidates): void {
  const { x, y, z } = a;
  const from = context.state.node.feet;
  if (
    a.diagonal &&
    !(
      context.policy.allowDiagonalAscend &&
      isHeadPassable(look(context, from.x + a.dx, y + 2, from.z)) &&
      isHeadPassable(look(context, from.x, y + 2, from.z + a.dz))
    )
  ) {
    return;
  }
  // A jump from inside a vine or a ladder, or off one, does not rise; the
  // climb movement owns leaving a climbable.
  if (isClimbable(context.feetCell) || isClimbable(context.support)) return;
  const upperFeet = prepareCell(x, y + 1, z, context);
  const upperHead = prepareHeadCell(x, y + 2, z, context);
  const takeoffHead = context.takeoffHead;
  if (upperFeet === NO_CELL || upperHead === NO_CELL || takeoffHead === NO_CELL) return;
  if (isStandableTop(a.target)) {
    out
      .open("step_up", x, y + 1, z)
      .cell(upperFeet)
      .cell(upperHead)
      .cell(takeoffHead)
      .tickScale(a.tickScale)
      .offer();
  }
  if (a.target.kind === "loaded" && a.target.traits.empty && canPlace(context)) {
    out
      .open("step_up", x, y + 1, z)
      .cell(upperFeet)
      .cell(upperHead)
      .cell(takeoffHead)
      .tickScale(a.tickScale);
    if (bridgePlacement(context, x, y, z, out)) out.offer();
  }
}

/** Across at the same height on a safe floor, swimming when that floor is under source water: Baritone's MovementTraverse. */
function traverse(context: MovementGenerationContext, a: Approach, out: MovementCandidates): boolean {
  if (a.feet === NO_CELL || a.head === NO_CELL || !isSafeSupport(a.below)) return false;
  // A destination held up by nothing but a ladder or a vine is a column to
  // hang in, not a floor to stop on: the climbable clamps the descent and
  // leaves the horizontal speed alone. Sprinting in crosses the column's one
  // block of width in a handful of ticks and leaves by the far side still
  // falling. Observed live on 2026-09-13 at -6,102,29, incident 97c795ac: a
  // diagonal sprint off a ledge caught the vine, drifted one block sideways
  // out of it, and fell five blocks. Walking in spends half the speed and
  // keeps the lateral entry a ladder shaft needs at mid-height. A climbable
  // standing on its own floor is unaffected; only its support is read here.
  const hangingEntry = isClimbable(a.below);
  const kind = isWater(a.target)
    ? "swim"
    : canSprint(context) && !hangingEntry && sprintLookaheadClear(context, a.x, a.y, a.z, a.dx, a.dz)
      ? "sprint"
      : "walk";
  out.open(kind, a.x, a.y, a.z).cell(a.feet).cell(a.head).tickScale(a.tickScale).offer();
  return true;
}

/**
 * Into source water at the same height with nothing beneath it: the bot floats
 * where a traverse would fall.
 *
 * Swimming into a column settles it. Offering a fall out of the same water as
 * well would be a vertical water descent by another name, which prices no air
 * supply: the default-world progression drowned in eighteen such steps.
 */
function swim(context: MovementGenerationContext, a: Approach, out: MovementCandidates): boolean {
  if (!context.policy.allowSwimming || a.feet === NO_CELL || a.head === NO_CELL || isSafeSupport(a.below)) return false;
  if (!isWater(a.target)) return false;
  out.open("swim", a.x, a.y, a.z).cell(a.feet).cell(a.head).tickScale(a.tickScale).offer();
  return true;
}

/** Across an edge onto a block placed beneath the step: a bridge, one scaffold at a time. */
function bridge(context: MovementGenerationContext, a: Approach, out: MovementCandidates): void {
  if (a.feet === NO_CELL || a.head === NO_CELL || isSafeSupport(a.below) || !canPlace(context)) return;
  out.open("walk", a.x, a.y, a.z).cell(a.feet).cell(a.head).tickScale(a.tickScale);
  if (bridgePlacement(context, a.x, a.y - 1, a.z, out)) out.offer();
}

/**
 * Off the edge and down to the first safe landing: Baritone's MovementFall.
 *
 * Cardinal only. A diagonal descent can leave the player's collision box
 * balanced on the takeoff corner; diagonal travel remains available on
 * supported ground.
 */
function fall(context: MovementGenerationContext, a: Approach, out: MovementCandidates): void {
  if (a.diagonal || a.feet === NO_CELL || a.head === NO_CELL || isSafeSupport(a.below)) return;
  // Submerged descent uses the priced one-cell swim edges. A land-priced fall
  // would otherwise route past a midwater goal to the seabed and then rise.
  const from = context.state.node.feet;
  if (context.policy.dive && isWater(look(context, from.x, from.y, from.z))) return;
  const { x, y, z } = a;
  for (let distance = 1; distance <= Math.max(context.policy.maximumDrop, context.policy.maximumBucketDrop ?? 0); distance += 1) {
    const landingY = y - distance;
    // A refused landing is where a fall stops looking deeper, so the lava
    // rule other families leave to `settle` is asked of a dug landing here,
    // and the drops below it are offered exactly as they always were.
    const landingFeet = unlessLava(context, prepareCell(x, landingY, z, context), x, landingY, z);
    const landingHead = unlessLava(context, prepareHeadCell(x, landingY + 1, z, context), x, landingY + 1, z);
    const support = look(context, x, landingY - 1, z);
    const landingBlock = look(context, x, landingY, z);
    // A climbable under the landing is the third place a column was priced as
    // a floor, with the same answer as the gap jump and the sprint traverse: a
    // falling body does not stop in one, it slides on down to whatever the
    // column ends at, and the arrival the route predicted never happens.
    // Observed in the vine-ledge-entry fixture, where `2,-49,0>3,-52,0:drop`
    // was planned onto the top of an offset column and settled eight blocks
    // lower at y=-60. Entering a column from above belongs to `climb`, which
    // does it one cell at a time from directly overhead.
    const safeLanding =
      isSafeSupport(support) &&
      !isClimbable(support) &&
      landingBlock.kind === "loaded" &&
      (!isWater(landingBlock) || landingBlock.traits.liquidSource || canOccupyWater(context, x, landingY, z));
    // Sand or gravel directly over the landing falls in behind the bot once it
    // drops, burying the cell the route just claimed and failing the next
    // step's preconditions. Baritone's MovementFall refuses these landings.
    const ceiling = look(context, x, landingY + 2, z);
    const buried = isFalling(ceiling);
    const bucketDrop = distance > context.policy.maximumDrop;
    if (bucketDrop && (isSolid(landingBlock) || isLiquid(landingBlock))) return;
    if (!buried && landingFeet !== NO_CELL && landingHead !== NO_CELL && safeLanding) {
      if (bucketDrop && !waterableLanding(context.view, { x, y: landingY, z })) return;
      out
        .open(bucketDrop ? "bucket_drop" : "drop", x, landingY, z)
        .cell(a.feet)
        .cell(a.head)
        .cell(landingFeet)
        .cell(landingHead)
        .hazard(distance + (bucketDrop ? 40 : 0))
        .overshoot(a.dx, a.dz)
        .offer();
      return;
    }
    if (landingFeet === NO_CELL) return;
  }
}

/** The cell, or `NO_CELL` when it is one dig that would let lava in. */
function unlessLava(context: MovementGenerationContext, cell: number, x: number, y: number, z: number): number {
  const cells = context.cells;
  if (cell === NO_CELL || !cells.cellDug(cell) || cells.cellColumn(cell) !== null) return cell;
  return releasesLava(context.view.blockAt, x, y, z) ? NO_CELL : cell;
}

/**
 * One step down onto a tread this movement opens: Baritone's MovementDescend.
 *
 * Kept apart from `fall` deliberately. The two overlap on the cell they land
 * in but not on what they assume: this one never needs the approach column at
 * the source's own height to be usable, so it reaches treads a fall cannot,
 * and a fall reaches landings further down than one block. Search prices both.
 * With nothing to dig or open it is a plain drop, which `fall` already offers.
 */
function descend(context: MovementGenerationContext, dx: number, dz: number, out: MovementCandidates): void {
  const from = context.state.node.feet;
  const x = from.x + dx;
  const y = from.y - 1;
  const z = from.z + dz;
  if (!isStandableTop(look(context, x, y - 1, z))) return;
  const tread = prepareCell(x, y, z, context);
  const destinationHead = prepareHeadCell(x, y + 1, z, context);
  const transitionHead = prepareHeadCell(x, y + 2, z, context);
  if (tread === NO_CELL || destinationHead === NO_CELL || transitionHead === NO_CELL) return;
  const grid = context.cells;
  // The route may not open the cell under a tread it has already stood on.
  if (grid.cellDug(tread) && context.protectedFeet?.has(packKey(x, y + 1, z))) return;
  if (asItStands(grid, tread) && asItStands(grid, destinationHead) && asItStands(grid, transitionHead)) return;
  out.open("drop", x, y, z).cell(tread).cell(destinationHead).cell(transitionHead).overshoot(dx, dz).offer();
}

/** Whether the cell is passed with nothing dug and nothing opened. */
function asItStands(grid: ExpansionCells, cell: number): boolean {
  return !grid.cellDug(cell) && !grid.cellOpens(cell);
}

/**
 * Place a scaffold in this cell on the open row's way, if the policy allows
 * one. Whether a face supports it is settled with the row, for the rows
 * search keeps: a support can only refuse the placement, never reprice it.
 */
function bridgePlacement(
  context: MovementGenerationContext,
  x: number,
  y: number,
  z: number,
  out: MovementCandidates,
): boolean {
  const decision = policyPenalty(context.policy.decidePlace(x, y, z, context.world));
  if (decision === null || !context.scaffold) return false;
  // Placement confirmation currently owns air -> scaffold. Do not generate a
  // replaceable-water/plant edge whose own precondition is already false.
  const target = look(context, x, y, z);
  if (target.kind !== "loaded" || target.stateId !== 0) return false;
  out.placing(x, y, z, context.policy.placementPenalty + decision);
  return true;
}

/** Both corners of a diagonal must be open at feet and head, or the box catches on one of them. */
function diagonalClear(context: MovementGenerationContext, dx: number, dz: number): boolean {
  const from = context.state.node.feet;
  for (const [x, z] of [
    [from.x + dx, from.z],
    [from.x, from.z + dz],
  ] as const) {
    if (!isPassable(look(context, x, from.y, z))) return false;
    if (!isHeadPassable(look(context, x, from.y + 1, z))) return false;
    if (context.cells.stepPenalty(x, from.y, z, context.policy) === null) return false;
  }
  return true;
}

// ── Gap jumps ─────────────────────────────────────────────────────────────────────────────

/**
 * Every span a jump may clear. Parkour is the sprint-only gap crossing: it
 * owns the four-block span nothing else reaches and the ascending variants
 * that clear a gap and gain a block at the same time. Generated at a flat two
 * blocks, as it once was, it was an exact duplicate of jump.
 */
const GAP_SPANS = [
  { distance: 2, kind: "jump", sprinting: false, rise: 0 },
  { distance: 3, kind: "sprint_jump", sprinting: true, rise: 0 },
  { distance: 4, kind: "parkour", sprinting: true, rise: 0 },
  { distance: 2, kind: "parkour", sprinting: true, rise: 1 },
  { distance: 3, kind: "parkour", sprinting: true, rise: 1 },
] as const;

function gapJump(
  context: MovementGenerationContext,
  dx: number,
  dz: number,
  distance: number,
  kind: "jump" | "sprint_jump" | "parkour",
  rise: number,
  out: MovementCandidates,
): void {
  const from = context.state.node.feet;
  const x = from.x + dx * distance;
  const y = from.y + rise;
  const z = from.z + dz * distance;
  const feet = prepareCell(x, y, z, context);
  const head = prepareHeadCell(x, y + 1, z, context);
  const takeoffHead = context.takeoffHead;
  const landingSupport = look(context, x, y - 1, z);
  if (feet === NO_CELL || head === NO_CELL || takeoffHead === NO_CELL || !isSafeSupport(landingSupport)) {
    return;
  }
  // A climbable is support to hang in, never a pad to land on. It has no
  // collision and clamps only the descent, so a body arriving at sprint speed
  // passes straight through the column and keeps falling past it. Observed
  // live on 2026-09-13, incident bd95619b: a four-block parkour was planned
  // onto a free-hanging vine over a chasm, the vine caught the bot for seven
  // ticks while forward and sprint stayed held, and it left the far side and
  // fell nineteen blocks. `climb` owns entering a column, from directly above
  // at no horizontal speed, and a walking traverse owns entering one from the
  // side; a jump has no way to stop inside one.
  if (isClimbable(landingSupport)) return;
  // Landing one block up also needs the cell above the landing head clear: the
  // arc peaks over the landing, not at it.
  if (rise > 0 && prepareHeadCell(x, y + 2, z, context) === NO_CELL) return;
  let crossesGap = false;
  for (let index = 1; index < distance; index += 1) {
    const midX = from.x + dx * index;
    const midZ = from.z + dz * index;
    if (!isPassable(look(context, midX, y, midZ))) return;
    if (!isHeadPassable(look(context, midX, y + 1, midZ))) return;
    // A normal jump rises 1.249 blocks; with a 1.8-block body, its head enters
    // takeoff y + 3. Missing that cell admitted a head collision over lava.
    // Ascending jumps already inspect it as landing y + 2.
    if (!isPassable(look(context, midX, y + 2, midZ))) return;
    if (rise === 0 && !isPassable(look(context, midX, from.y + 3, midZ))) return;
    if (!isSolid(look(context, midX, y - 1, midZ))) crossesGap = true;
    // The lip of an ascending jump must not be in the way at the old height.
    if (rise > 0 && !isPassable(look(context, midX, y - 1, midZ))) return;
  }
  if (!crossesGap) return;
  out
    .open(kind, x, y, z)
    .cell(feet)
    .cell(head)
    .cell(takeoffHead)
    // A sprint jump carries past its planned cell, like a drop does, so it
    // needs the same arrival set or every long jump costs a replan.
    .overshoot(dx, dz)
    // An ascending jump spends its horizontal speed climbing, so it is dearer
    // than the same span on the flat.
    .hazard(rise > 0 ? context.policy.movementTicks.step_up : 0)
    .offer();
}

/** Every span that can be jumped in this direction, once the takeoff itself allows a jump at all. */
function gapJumps(context: MovementGenerationContext, dx: number, dz: number, out: MovementCandidates): void {
  if (!context.policy.allowParkour) return;
  const from = context.state.node.feet;
  const takeoffSupport = context.support;
  if (!isSolid(takeoffSupport) || takeoffSupport.kind !== "loaded") return;
  if (takeoffSupport.traits.parkourTakeoff === "prohibited") return;
  if (isLiquid(context.feetCell)) return;
  // A gap movement starts at the takeoff lip. If the adjacent cell has safe
  // support, traversing to it is a separate movement and produces the real
  // source state for the jump. Generating a long jump early swallowed shorter
  // fixture gaps and hid a whole supported cell of runway inside one edge;
  // execution then had no honest takeoff origin. Baritone rejects parkour from
  // the same condition before it searches for a landing.
  if (isSafeSupport(look(context, from.x + dx, from.y - 1, from.z + dz))) return;
  const sprinting = canSprint(context);
  const shortTakeoff = takeoffSupport.traits.parkourTakeoff === "short";
  for (const span of GAP_SPANS) {
    if (span.sprinting && !sprinting) continue;
    if (shortTakeoff && span.distance > 2) continue;
    gapJump(context, dx, dz, span.distance, span.kind, span.rise, out);
  }
}

// ── Vertical movements ────────────────────────────────────────────────────────────────────

/**
 * Up or down a ladder or vine the bot is standing in, or down into one
 * directly beneath its feet.
 *
 * Climbing up moves the head into a cell the bot does not occupy yet, so that
 * cell is prepared like any other: dug when it must be, and the climb refused
 * when it cannot be. Preparing only the destination's feet made the catalogue
 * blind to whatever was above it. Observed live on 2026-09-04, on a vine shaft
 * the bot had itself blocked with a placed cobblestone: the climb was offered,
 * the bot jammed against the block, and nothing broke it, because nothing had
 * ever looked at it. Climbing down leaves the head in the cell the bot already
 * stands in, which is clear by construction.
 *
 * Climbing down is also how a column is entered from above. Standing over the
 * top ladder or vine, the bot steps off into it and the climbable catches the
 * body; requiring the bot to already be inside made every column a dead end
 * from the top, and the search dug through the block beside a ladder rather
 * than descend it. Baritone's `MovementDownward.cost` prices exactly this:
 * `if (downBlock == Blocks.LADDER || downBlock == Blocks.VINE) return
 * LADDER_DOWN_ONE_COST;`, judged on the block below, not the one stood in.
 */
function climb(context: MovementGenerationContext, out: MovementCandidates): void {
  const { x, y, z } = context.state.node.feet;
  const here = context.feetCell;
  if (!context.policy.allowClimbing) return;
  const insideClimbable = here.kind === "loaded" && here.traits.climbable;
  const below = context.support;
  const overClimbable = below.kind === "loaded" && below.traits.climbable;
  if (!insideClimbable && !overClimbable) return;
  if (overClimbable || insideClimbable) {
    const feet = prepareCell(x, y - 1, z, context);
    if (feet !== NO_CELL)
      out
        .open("climb", x, y - 1, z)
        .cell(feet)
        .offer();
  }
  if (!insideClimbable) return;
  const feet = prepareCell(x, y + 1, z, context);
  if (feet === NO_CELL) return;
  const head = prepareHeadCell(x, y + 2, z, context);
  if (head === NO_CELL) return;
  out
    .open("climb", x, y + 1, z)
    .cell(feet)
    .cell(head)
    .offer();
}

/** Rise to a breathable surface from either a pickup hole or open ocean. */
function surface(context: MovementGenerationContext, out: MovementCandidates): void {
  if (!context.policy.allowSwimming) return;
  const { x, y, z } = context.state.node.feet;
  const feet = context.feetCell;
  const head = look(context, x, y + 1, z);
  const air = look(context, x, y + 2, z);
  if (
    feet.kind !== "loaded" ||
    feet.traits.liquid !== "water" ||
    head.kind !== "loaded" ||
    head.traits.liquid !== "water" ||
    air.kind !== "loaded" ||
    air.traits.liquid !== null ||
    !isHeadPassable(air)
  )
    return;
  // Admission belongs to the surface destination. Requiring a supported
  // submerged start strands a floating bot over deep water one node below it.
  const destination = prepareCell(x, y + 1, z, context);
  const destinationHead = prepareHeadCell(x, y + 2, z, context);
  if (destination !== NO_CELL && destinationHead !== NO_CELL) {
    out
      .open("swim", x, y + 1, z)
      .cell(destination)
      .cell(destinationHead)
      .offer();
  }
}

/** Vertical open-water travel uses the same body and air admission as lateral swimming. */
function verticalSwim(context: MovementGenerationContext, out: MovementCandidates): void {
  if (!context.policy.allowSwimming || !context.policy.dive || !isWater(context.feetCell)) return;
  const { x, y, z } = context.state.node.feet;
  for (const dy of [-1, 1]) {
    if (!isWater(look(context, x, y + dy, z))) continue;
    const feet = prepareCell(x, y + dy, z, context);
    const head = prepareHeadCell(x, y + dy + 1, z, context);
    if (feet !== NO_CELL && head !== NO_CELL)
      out.open("swim", x, y + dy, z).cell(feet).cell(head).offer();
  }
}

/** Up one block onto a scaffold placed beneath the bot's own feet. */
function pillar(context: MovementGenerationContext, out: MovementCandidates): void {
  if (!canPlace(context)) return;
  const { x, y, z } = context.state.node.feet;
  if (context.feetCell.kind === "unloaded") return;
  const feet = prepareCell(x, y + 1, z, context);
  const head = prepareHeadCell(x, y + 2, z, context);
  if (feet === NO_CELL || head === NO_CELL) return;
  out
    .open("pillar", x, y + 1, z)
    .cell(feet)
    .cell(head);
  if (bridgePlacement(context, x, y, z, out)) out.offer();
}

/** Straight down through the block beneath the bot's feet onto whatever stands under it. */
function directDownward(context: MovementGenerationContext, out: MovementCandidates): void {
  if (!context.policy.allowDownward) return;
  const { x, z } = context.state.node.feet;
  const y = context.state.node.feet.y - 1;
  if (!isStandableTop(look(context, x, y - 1, z))) return;
  const destination = prepareCell(x, y, z, context);
  if (destination === NO_CELL || !context.cells.cellDug(destination)) return;
  out.open("downward", x, y, z).cell(destination).offer();
}

// ── The catalogue ─────────────────────────────────────────────────────────────────────────

export function createMovementCatalogue(): MovementCatalogue {
  const cells = new ExpansionCells();
  const movements = new MovementCandidates();
  const approach = new Approach();
  return {
    generate(state, generation, digContext) {
      const feet = state.node.feet;
      const world = generation.world;
      cells.begin(feet, world, state.overlay);
      const view = cells.view;
      let sight: StanceSight | undefined;
      let takeoffHead: number | undefined;
      const context: MovementGenerationContext = {
        world,
        policy: generation.policy,
        player: generation.player,
        protectedFeet: generation.protectedFeet,
        stepField: generation.stepField,
        scaffold: generation.policy.scaffold,
        state,
        digContext,
        view,
        cells,
        // Most expansions dig nothing, and what the eye can see is only asked
        // about digs, so the sight is set up the first time a movement has one.
        get sight() {
          return (sight ??= stanceSight(view.blockAt, { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 }));
        },
        feetCell: cells.look(feet.x, feet.y, feet.z),
        support: cells.look(feet.x, feet.y - 1, feet.z),
        get takeoffHead() {
          return (takeoffHead ??= prepareHeadCell(feet.x, feet.y + 2, feet.z, context));
        },
      };
      movements.begin(context);
      for (const direction of CARDINALS) {
        const column = approach.aim(context, direction.x, direction.z);
        ascend(context, column, movements);
        if (!traverse(context, column, movements)) {
          const floating = swim(context, column, movements);
          if (!floating) bridge(context, column, movements);
          // Floating at the surface and stepping onto a shallow floor are
          // both useful: an item in a mined hole needs the lower arrival.
          if (!floating || canOccupyWater(context, column.x, column.y, column.z)) {
            fall(context, column, movements);
          }
        }
        descend(context, direction.x, direction.z, movements);
        gapJumps(context, direction.x, direction.z, movements);
      }
      for (const direction of DIAGONALS) {
        if (generation.policy.dive && waterOccupancy(view.blockAt, feet.x, feet.y, feet.z) === "submerged") continue;
        if (!diagonalClear(context, direction.x, direction.z)) continue;
        const column = approach.aim(context, direction.x, direction.z);
        ascend(context, column, movements);
        if (!traverse(context, column, movements) && !swim(context, column, movements)) {
          bridge(context, column, movements);
        }
      }
      directDownward(context, movements);
      climb(context, movements);
      surface(context, movements);
      verticalSwim(context, movements);
      pillar(context, movements);
      return movements;
    },
  };
}
