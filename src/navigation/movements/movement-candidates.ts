/**
 * The movements one expansion offers, kept as columns, and the movement
 * search reads out of a row once it has decided to keep it.
 *
 * Search decides from three numbers, the arrival cell, the scaffolds left,
 * and the cost, whether an arrival improves on one it already knows, and
 * about half of them do not. So the families do not make a movement each;
 * they fill a row of columns through the builder here, `open` to `offer`, and
 * `offer` prices the row and commits it. Nothing is allocated for a row that
 * is refused or that search rejects. `movement` spells a kept row out as a
 * `GeneratedMovement` whose state and step are built on first read.
 *
 * The rows, like the cells they name by handle, belong to the expansion that
 * filled them and are overwritten by the next: a movement is only good until
 * the catalogue's next `generate`, and says so if read later.
 */
import {
  hasUnstableFallingSupport,
  isHeadPassable,
  isPassable,
  isSafeSupport,
  isSolid,
} from "../world/block-geometry.js";
import type { BlockObservation } from "../world/world.js";
import { SWIM_DOWN_TICKS, SWIM_UP_TICKS, SWIM_HORIZONTAL_TICKS } from "../world/swimming.js";
import { type BlockPosition, blockLabel } from "../world/world.js";
import type { GeneratedMovement, MovementGenerationContext, PlanningState } from "./catalogue.js";
import { type Dig, confirmDigs, prepareExcavationDigs, releasesLava } from "./excavation.js";
import {
  type MovementKind,
  type PlacementPlan,
  type PlannedOperation,
  type PlannedStep,
  type PredictedWorldEffect,
  type WorldPrecondition,
  stateMatcher,
} from "./movement.js";

/**
 * What `generate` returns: rows search reads by index, and a movement for
 * each row it keeps.
 *
 * A row's cost is exact from the start, but a row that digs is not yet known
 * to be possible: whether every dig can be seen from the stance is the dear
 * part of pricing a dig, and it can only refuse a row, never reprice it. So
 * search reads the cost first, asks the arrival frontier whether the row is
 * worth anything, and only then asks `settle`, which is where the eye ray
 * runs. Most rows lose to a known arrival and are never settled.
 */
export interface GeneratedMovements extends Iterable<GeneratedMovement> {
  readonly length: number;
  /** The columns search decides from before anything is made: the arrival cell, the scaffolds left, the cost. */
  readonly toX: ArrayLike<number>;
  readonly toY: ArrayLike<number>;
  readonly toZ: ArrayLike<number>;
  readonly remainingScaffolds: ArrayLike<number>;
  readonly cost: ArrayLike<number>;
  /** Whether the row can be made from the stance: false for a row whose digs cannot all be seen, which search drops. */
  settle(index: number): boolean;
  /** The movement in one settled row, spelled out. */
  movement(index: number): GeneratedMovement;
  /** Every settled row's movement, for callers that read them all. */
  toArray(): GeneratedMovement[];
}

/** Ready-made movements in the shape `generate` returns, for a catalogue stubbed in a test. */
export function movementList(movements: readonly GeneratedMovement[]): GeneratedMovements {
  return {
    length: movements.length,
    toX: movements.map((movement) => movement.to.x),
    toY: movements.map((movement) => movement.to.y),
    toZ: movements.map((movement) => movement.to.z),
    remainingScaffolds: movements.map((movement) => movement.remainingScaffolds),
    cost: movements.map((movement) => movement.cost),
    settle: () => true,
    movement: (index) => movements[index]!,
    toArray: () => [...movements],
    [Symbol.iterator]: () => movements[Symbol.iterator](),
  };
}

/** What an opened door or gate must read as before the route walks through it. */
const OPENED = {
  description: "open block",
  matches: (candidate: BlockObservation) =>
    candidate.kind === "loaded" && candidate.traits.openable && candidate.traits.open,
};

const NO_DIGS: readonly Dig[] = [];
const CELLS_PER_MOVEMENT = 4;
const INITIAL_CAPACITY = 64;

/** Whether a row has been settled: not yet, kept, or refused by a cell rule, the stance's sight, or a missing support. */
const SETTLE_PENDING = 0;
const SETTLE_CLEAR = 1;
const SETTLE_REFUSED = 2;

/** The five faces a scaffold can be placed against, in the order tried. */
const SUPPORT_FACES = [
  { x: -1, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: -1, z: 0 },
  { x: 0, y: 0, z: -1 },
  { x: 0, y: 0, z: 1 },
] as const;
const NO_FACE = -1;

export class MovementCandidates implements GeneratedMovements {
  /** Rows committed so far; the row being built is the one at `length`. */
  length = 0;
  /** Counts `begin` calls; a movement is only good while this still matches the expansion that made it. */
  expansion = 0;
  #capacity = INITIAL_CAPACITY;
  toX = new Int32Array(INITIAL_CAPACITY);
  toY = new Int32Array(INITIAL_CAPACITY);
  toZ = new Int32Array(INITIAL_CAPACITY);
  remainingScaffolds = new Int32Array(INITIAL_CAPACITY);
  cost = new Float64Array(INITIAL_CAPACITY);
  readonly #kind: MovementKind[] = [];
  /** Handles into the expansion's cell grid, `CELLS_PER_MOVEMENT` per row. */
  #cells = new Int32Array(INITIAL_CAPACITY * CELLS_PER_MOVEMENT);
  #cellCount = new Uint8Array(INITIAL_CAPACITY);
  #expectedTicks = new Float64Array(INITIAL_CAPACITY);
  #breakPenalty = new Float64Array(INITIAL_CAPACITY);
  #placementPenalty = new Float64Array(INITIAL_CAPACITY);
  #hazardPenalty = new Float64Array(INITIAL_CAPACITY);
  /**
   * The movement may carry one cell past its destination in this direction;
   * zero when it may not. Whether that cell is a valid arrival is judged when
   * the step is built.
   */
  #overshootDx = new Int8Array(INITIAL_CAPACITY);
  #overshootDz = new Int8Array(INITIAL_CAPACITY);
  /**
   * The one block the movement places on its way, as numbers: the cell, and
   * the face of the support it is placed against, found when the row is
   * settled. The plan is spelled out for a row search keeps.
   */
  #places = new Uint8Array(INITIAL_CAPACITY);
  #placeX = new Int32Array(INITIAL_CAPACITY);
  #placeY = new Int32Array(INITIAL_CAPACITY);
  #placeZ = new Int32Array(INITIAL_CAPACITY);
  #placeFace = new Int8Array(INITIAL_CAPACITY);
  readonly #placement: (PlacementPlan | null)[] = [];
  /** The digs the movement makes, spelled out and put in the order it makes them when the row is settled. */
  readonly #digs: (readonly Dig[])[] = [];
  #settled = new Uint8Array(INITIAL_CAPACITY);
  /**
   * What the open row was told beyond its columns, settled into its cost by
   * `offer`: a diagonal covers `sqrt(2)` blocks for the same input and is
   * charged for the distance it travels, and a drop or an ascending jump
   * carries a penalty of its own.
   */
  #tickScale = 1;
  #hazard = 0;
  #context!: MovementGenerationContext;

  /** Start filling rows for one expansion. */
  begin(context: MovementGenerationContext): void {
    this.#context = context;
    this.length = 0;
    this.expansion += 1;
  }

  // ── Building a row ──────────────────────────────────────────────────────────

  /** Start a row for a movement of `kind` ending with the feet in this cell. */
  open(kind: MovementKind, x: number, y: number, z: number): this {
    const row = this.length;
    if (row === this.#capacity) this.#grow();
    this.#kind[row] = kind;
    this.toX[row] = x;
    this.toY[row] = y;
    this.toZ[row] = z;
    this.remainingScaffolds[row] = this.#context.state.node.remainingScaffolds;
    this.#cellCount[row] = 0;
    this.#places[row] = 0;
    this.#placement[row] = null;
    this.#placementPenalty[row] = 0;
    this.#overshootDx[row] = 0;
    this.#overshootDz[row] = 0;
    this.#tickScale = 1;
    this.#hazard = 0;
    return this;
  }

  /** A cell the movement passes through, by handle, in the order the movement assumes them. */
  cell(handle: number): this {
    const row = this.length;
    const count = this.#cellCount[row]!;
    this.#cells[row * CELLS_PER_MOVEMENT + count] = handle;
    this.#cellCount[row] = count + 1;
    return this;
  }

  tickScale(scale: number): this {
    this.#tickScale = scale;
    return this;
  }

  hazard(penalty: number): this {
    this.#hazard = penalty;
    return this;
  }

  overshoot(dx: number, dz: number): this {
    this.#overshootDx[this.length] = dx;
    this.#overshootDz[this.length] = dz;
    return this;
  }

  /** The movement places one scaffold in this cell, spending one of the node's; its support is found when the row is settled. */
  placing(x: number, y: number, z: number, penalty: number): this {
    const row = this.length;
    this.#places[row] = 1;
    this.#placeX[row] = x;
    this.#placeY[row] = y;
    this.#placeZ[row] = z;
    this.#placeFace[row] = NO_FACE;
    this.#placementPenalty[row] = penalty;
    this.remainingScaffolds[row] = this.#context.state.node.remainingScaffolds - 1;
    return this;
  }

  /** Find a face to place the row's scaffold against, in the order the faces are tried; false when none supports it. */
  #findSupport(row: number): boolean {
    const grid = this.#context.cells;
    const x = this.#placeX[row]!;
    const y = this.#placeY[row]!;
    const z = this.#placeZ[row]!;
    for (let index = 0; index < SUPPORT_FACES.length; index += 1) {
      const face = SUPPORT_FACES[index]!;
      const block = grid.look(x + face.x, y + face.y, z + face.z);
      // A chest or door face answers the right-click itself, so the scaffold is
      // never placed, no mutation is observed, and the route replans onto the
      // same support for as long as it has patience.
      if (isSolid(block) && !(block.kind === "loaded" && block.traits.interactive)) {
        this.#placeFace[row] = index;
        return true;
      }
    }
    return false;
  }

  /** The row's placement spelled out, or null when it places nothing. */
  #placementOf(row: number): PlacementPlan | null {
    if (this.#places[row] === 0) return null;
    let placement = this.#placement[row];
    if (!placement) {
      const x = this.#placeX[row]!;
      const y = this.#placeY[row]!;
      const z = this.#placeZ[row]!;
      const face = SUPPORT_FACES[this.#placeFace[row]!]!;
      // Placement is gated on the policy's scaffold, so a row that places has one.
      const scaffold = this.#context.scaffold!;
      const axis = face.x !== 0 ? "x" : face.y !== 0 ? "y" : "z";
      placement = {
        position: { x, y, z },
        stateId: scaffold.stateIdByAxis?.[axis] ?? scaffold.stateId,
        itemType: scaffold.itemType,
        support: { x: x + face.x, y: y + face.y, z: z + face.z },
        face: { x: -face.x, y: -face.y, z: -face.z },
      };
      this.#placement[row] = placement;
    }
    return placement;
  }

  /**
   * Price the open row and commit it, unless the policy refuses its arrival.
   *
   * The price is exact here: a dig costs the same wherever it is ordered, and
   * a cell two of the row's cells both clear is charged once, as `settle`
   * will dig it once. What is left to `settle` can only refuse the row, so
   * the digs themselves are not spelled out until then.
   */
  offer(): void {
    const context = this.#context;
    const row = this.length;
    let hazard = stepHazard(context, this.toX[row]!, this.toY[row]!, this.toZ[row]!);
    if (hazard === null) return;
    if (context.policy.decideMovement) {
      const decision = context.policy.decideMovement(this.#kind[row]!, context.state.node.feet,
        { x: this.toX[row]!, y: this.toY[row]!, z: this.toZ[row]! });
      if (decision.kind === "prohibited") return;
      if (decision.kind === "penalized") hazard += decision.cost;
    }
    const grid = context.cells;
    const first = row * CELLS_PER_MOVEMENT;
    const end = first + this.#cellCount[row]!;
    let breakTicks = 0;
    let breakPenalty = 0;
    let dug = false;
    let column = false;
    for (let at = first; at < end; at += 1) {
      const cell = this.#cells[at]!;
      if (grid.cellOpens(cell)) {
        breakPenalty += grid.cellActivationPenalty(cell);
      } else if (grid.cellDug(cell)) {
        dug = true;
        if (grid.cellColumn(cell) !== null) column = true;
        else if (!this.#duplicatesEarlierCell(first, at)) {
          breakTicks += grid.cellDigTicks(cell);
          breakPenalty += grid.cellDigPenalty(cell);
        }
      }
    }
    if (column) {
      // The rare row that digs a falling column is priced from its digs,
      // each cell of the column once however many of the row's cells it
      // stands above.
      const digs = this.#digsOf(row);
      breakTicks = 0;
      breakPenalty = 0;
      for (let index = 0; index < digs.length; index += 1) {
        const dig = digs[index]!;
        if (duplicatesEarlierDig(digs, index)) continue;
        breakTicks += dig.expectedTicks;
        breakPenalty += dig.penalty;
      }
      for (let at = first; at < end; at += 1) {
        const cell = this.#cells[at]!;
        if (grid.cellOpens(cell)) breakPenalty += grid.cellActivationPenalty(cell);
      }
    }
    const expectedTicks = (this.#kind[row] === "swim" && context.policy.dive
      ? (this.toY[row]! < context.state.node.feet.y ? SWIM_DOWN_TICKS : this.toY[row]! > context.state.node.feet.y ? SWIM_UP_TICKS : SWIM_HORIZONTAL_TICKS)
      : context.policy.movementTicks[this.#kind[row]!]) * this.#tickScale + breakTicks;
    const hazardPenalty = hazard + this.#hazard;
    this.#digs[row] = NO_DIGS;
    this.#settled[row] = dug || this.#places[row] === 1 ? SETTLE_PENDING : SETTLE_CLEAR;
    this.#expectedTicks[row] = expectedTicks;
    this.#breakPenalty[row] = breakPenalty;
    this.#hazardPenalty[row] = hazardPenalty;
    this.cost[row] = expectedTicks + breakPenalty + this.#placementPenalty[row]! + hazardPenalty;
    this.length = row + 1;
  }

  /**
   * Confirm the row's digs where they are, then order them so that each can
   * be seen from the stance when its turn comes, and find the support for
   * its placement; refuse the row when the policy's cell rules, the stance's
   * sight, or a missing support refuse it. Asked once per row, and only for
   * the rows search has found worth keeping.
   */
  settle(index: number): boolean {
    let settled = this.#settled[index]!;
    if (settled === SETTLE_PENDING) {
      settled =
        this.#settleDigs(index) && (this.#places[index] === 0 || this.#findSupport(index))
          ? SETTLE_CLEAR
          : SETTLE_REFUSED;
      this.#settled[index] = settled;
    }
    return settled === SETTLE_CLEAR;
  }

  #settleDigs(index: number): boolean {
    const context = this.#context;
    const digs = this.#digsOf(index);
    if (digs.length === 0) return true;
    if (this.#releasesLava(index) || !confirmDigs(context.policy, context.view, digs)) return false;
    const excavation = prepareExcavationDigs(context.view.blockAt, context.sight, digs);
    if (excavation.kind !== "prepared") return false;
    this.#digs[index] = excavation.digs;
    return true;
  }

  /** Whether one of the row's single digs would let lava in; a column's foot was asked when it was priced. */
  #releasesLava(row: number): boolean {
    const context = this.#context;
    const grid = context.cells;
    const first = row * CELLS_PER_MOVEMENT;
    const end = first + this.#cellCount[row]!;
    for (let at = first; at < end; at += 1) {
      const cell = this.#cells[at]!;
      if (!grid.cellDug(cell) || grid.cellColumn(cell) !== null) continue;
      if (releasesLava(context.view.blockAt, grid.cellX(cell), grid.cellY(cell), grid.cellZ(cell))) return true;
    }
    return false;
  }

  /** Whether an earlier dug cell of the row is the same cell, which the row digs once. */
  #duplicatesEarlierCell(first: number, at: number): boolean {
    const grid = this.#context.cells;
    const cell = this.#cells[at]!;
    for (let earlier = first; earlier < at; earlier += 1) {
      const other = this.#cells[earlier]!;
      if (
        grid.cellDug(other) &&
        grid.cellX(other) === grid.cellX(cell) &&
        grid.cellY(other) === grid.cellY(cell) &&
        grid.cellZ(other) === grid.cellZ(cell)
      ) {
        return true;
      }
    }
    return false;
  }

  /** The row's digs spelled out, cell by cell in the row's order, a column's top down. */
  #digsOf(row: number): readonly Dig[] {
    const grid = this.#context.cells;
    const first = row * CELLS_PER_MOVEMENT;
    const end = first + this.#cellCount[row]!;
    let digs: Dig[] | null = null;
    for (let at = first; at < end; at += 1) {
      const cell = this.#cells[at]!;
      if (!grid.cellDug(cell)) continue;
      const column = grid.cellColumn(cell);
      if (column === null) (digs ??= []).push(grid.cellDig(cell));
      else (digs ??= []).push(...column);
    }
    return digs ?? NO_DIGS;
  }

  #grow(): void {
    this.#capacity *= 2;
    this.toX = grown(this.toX, this.#capacity);
    this.toY = grown(this.toY, this.#capacity);
    this.toZ = grown(this.toZ, this.#capacity);
    this.remainingScaffolds = grown(this.remainingScaffolds, this.#capacity);
    this.cost = grown(this.cost, this.#capacity);
    this.#cells = grown(this.#cells, this.#capacity * CELLS_PER_MOVEMENT);
    this.#cellCount = grown(this.#cellCount, this.#capacity);
    this.#expectedTicks = grown(this.#expectedTicks, this.#capacity);
    this.#breakPenalty = grown(this.#breakPenalty, this.#capacity);
    this.#placementPenalty = grown(this.#placementPenalty, this.#capacity);
    this.#places = grown(this.#places, this.#capacity);
    this.#placeX = grown(this.#placeX, this.#capacity);
    this.#placeY = grown(this.#placeY, this.#capacity);
    this.#placeZ = grown(this.#placeZ, this.#capacity);
    this.#placeFace = grown(this.#placeFace, this.#capacity);
    this.#hazardPenalty = grown(this.#hazardPenalty, this.#capacity);
    this.#overshootDx = grown(this.#overshootDx, this.#capacity);
    this.#overshootDz = grown(this.#overshootDz, this.#capacity);
    this.#settled = grown(this.#settled, this.#capacity);
  }

  // ── Reading a row out ───────────────────────────────────────────────────────

  movement(index: number): GeneratedMovement {
    if (!this.settle(index)) throw new Error("A movement whose digs cannot be seen from the stance was read.");
    return new Movement(this, index);
  }

  toArray(): GeneratedMovement[] {
    return [...this];
  }

  *[Symbol.iterator](): Iterator<GeneratedMovement> {
    for (let index = 0; index < this.length; index += 1) if (this.settle(index)) yield this.movement(index);
  }

  #row(row: number, expansion: number): number {
    if (expansion !== this.expansion) {
      throw new Error("A generated movement was read after the catalogue moved on to another expansion.");
    }
    return row;
  }

  /** The overlay after the row's breaks, activations, and placements, applied in that order. */
  arrive(index: number, expansion: number, to: BlockPosition, remainingScaffolds: number): PlanningState {
    const row = this.#row(index, expansion);
    const context = this.#context;
    const grid = context.cells;
    let overlay = context.state.overlay;
    for (const dig of this.#digs[row]!) {
      overlay = overlay.apply({ kind: "break", position: dig.position, stateId: 0 });
      for (const brought of dig.brings) overlay = overlay.apply({ kind: "break", position: brought, stateId: 0 });
    }
    const first = row * CELLS_PER_MOVEMENT;
    const end = first + this.#cellCount[row]!;
    for (let at = first; at < end; at += 1) {
      const cell = this.#cells[at]!;
      if (grid.cellOpens(cell)) {
        overlay = overlay.apply({
          kind: "activate",
          position: { x: grid.cellX(cell), y: grid.cellY(cell), z: grid.cellZ(cell) },
          stateId: grid.cellStateId(cell),
        });
      }
    }
    const placement = this.#placementOf(row);
    if (placement) overlay = overlay.apply({ kind: "place", position: placement.position, stateId: placement.stateId });
    return {
      // The overlay's identity is a string spelled out from its hashes, and
      // search never reads it: it is built when a step id or a caller asks.
      node: {
        feet: to,
        remainingScaffolds,
        get overlayId() {
          return overlay.identity;
        },
      },
      overlay,
    };
  }

  /**
   * The row as a step: its preconditions (the block states it assumed), its
   * operations (the breaks, placements, activations, and finally the move),
   * and its predicted effects. Immutability is the `readonly` types' job;
   * freezing every step at runtime cost eleven percent of a search and caught
   * nothing the compiler does not.
   */
  materialise(index: number, expansion: number, to: BlockPosition, state: PlanningState, cost: number): PlannedStep {
    const row = this.#row(index, expansion);
    const context = this.#context;
    const grid = context.cells;
    const kind = this.#kind[row]!;
    const from = context.state.node.feet;
    const operations: PlannedOperation[] = [];
    const effects: PredictedWorldEffect[] = [];
    const preconditions: WorldPrecondition[] = [];
    const activated = new Set<string>();
    for (const dig of this.#digs[row]!) {
      operations.push({
        kind: "break",
        position: dig.position,
        expectedStateId: dig.stateId,
        toolType: dig.toolType,
        brings: dig.brings,
      });
      for (const cleared of [dig.position, ...dig.brings])
        effects.push({ kind: "break", position: cleared, stateId: 0 });
      preconditions.push({ position: dig.position, expected: stateMatcher(dig.stateId) });
    }
    const first = row * CELLS_PER_MOVEMENT;
    const end = first + this.#cellCount[row]!;
    for (let at = first; at < end; at += 1) {
      const cell = this.#cells[at]!;
      if (grid.cellDug(cell)) continue;
      const position = { x: grid.cellX(cell), y: grid.cellY(cell), z: grid.cellZ(cell) };
      const stateId = grid.cellStateId(cell);
      const expected = stateMatcher(stateId);
      if (grid.cellOpens(cell)) {
        // Both halves of a door share one activation group; the movement opens it once.
        const group = grid.cellActivationGroup(cell);
        if (group === null || !activated.has(group)) {
          operations.push({ kind: "activate", position, before: expected, after: OPENED });
          if (group !== null) activated.add(group);
        }
        effects.push({ kind: "activate", position, stateId });
      }
      preconditions.push({ position, expected });
    }
    const placement = this.#placementOf(row);
    if (placement) operations.push({ kind: "place", placement });
    operations.push({ kind: "move", movement: kind, target: { x: to.x + 0.5, y: to.y, z: to.z + 0.5 } });
    if (placement) {
      effects.push({ kind: "place", position: placement.position, stateId: placement.stateId });
      preconditions.push({ position: placement.position, expected: stateMatcher(0) });
    }
    // The landing floor is an execution dependency just like the cleared body
    // cells. Without it, a removed floor is classified as irrelevant and the
    // bot walks into a drop whose planned landing no longer exists.
    const floor = { x: to.x, y: to.y - 1, z: to.z };
    const support = context.view.blockAt(floor.x, floor.y, floor.z);
    if (isSafeSupport(support) && support.kind === "loaded")
      preconditions.push({ position: floor, expected: stateMatcher(support.stateId) });
    const dx = this.#overshootDx[row]!;
    const dz = this.#overshootDz[row]!;
    return {
      id: `${blockLabel(from)}>${blockLabel(to)}:${kind}:${state.overlay.identity}`,
      kind,
      from,
      to,
      validArrivals: dx !== 0 || dz !== 0 ? arrivals(context, to, dx, dz) : [to],
      preconditions,
      operations,
      effects,
      cost: {
        expectedTicks: this.#expectedTicks[row]!,
        breakPenalty: this.#breakPenalty[row]!,
        placementPenalty: this.#placementPenalty[row]!,
        hazardPenalty: this.#hazardPenalty[row]!,
        total: cost,
      },
    };
  }
}

/**
 * One kept row as search holds it: the three numbers it decided on, and the
 * state and the step read out of the row on first use.
 */
class Movement implements GeneratedMovement {
  readonly to: BlockPosition;
  readonly remainingScaffolds: number;
  readonly cost: number;
  readonly #rows: MovementCandidates;
  readonly #row: number;
  readonly #expansion: number;
  #state: PlanningState | undefined;
  #step: PlannedStep | undefined;

  constructor(rows: MovementCandidates, row: number) {
    this.#rows = rows;
    this.#row = row;
    this.#expansion = rows.expansion;
    this.to = { x: rows.toX[row]!, y: rows.toY[row]!, z: rows.toZ[row]! };
    this.remainingScaffolds = rows.remainingScaffolds[row]!;
    this.cost = rows.cost[row]!;
  }

  get state(): PlanningState {
    return (this.#state ??= this.#rows.arrive(this.#row, this.#expansion, this.to, this.remainingScaffolds));
  }

  get step(): PlannedStep {
    return (this.#step ??= this.#rows.materialise(this.#row, this.#expansion, this.to, this.state, this.cost));
  }
}

/**
 * What standing in this cell costs beyond the movement itself: the policy's
 * own penalty plus whatever the supplied field prices there, or null when the
 * policy refuses the cell outright.
 *
 * The field is only ever an addition. Somewhere the policy will not go stays
 * somewhere the route will not go, however cheap the field says it is.
 */
function stepHazard(context: MovementGenerationContext, x: number, y: number, z: number): number | null {
  const penalty = context.cells.stepPenalty(x, y, z, context.policy);
  if (penalty === null) return null;
  if (hasUnstableFallingSupport(context.view.blockAt, x, y - 1, z)) return null;
  return context.stepField ? penalty + context.stepField.costAt(x, y, z) : penalty;
}

/**
 * Where a movement that carries past its destination may end up.
 *
 * A drop or a sprint jump lands with momentum. Observed: a four-block parkour
 * span landed at x 13.19 on ground when the plan named 12.5, and the run
 * reported a movement failure for what was a clean landing one block along.
 * The cell one further in the direction of travel is a valid arrival when the
 * bot could stand there.
 */
function arrivals(
  context: MovementGenerationContext,
  destination: BlockPosition,
  dx: number,
  dz: number,
): readonly BlockPosition[] {
  const x = destination.x + dx;
  const z = destination.z + dz;
  const y = destination.y;
  const cells = context.cells;
  const clear =
    isPassable(cells.look(x, y, z)) &&
    isHeadPassable(cells.look(x, y + 1, z)) &&
    isSafeSupport(cells.look(x, y - 1, z)) &&
    !hasUnstableFallingSupport(context.view.blockAt, x, y - 1, z);
  return clear ? [destination, { x, y, z }] : [destination];
}

/** Whether a dig earlier in the list clears the same cell as the one at `index`: the cell is dug once, so it is charged once. */
function duplicatesEarlierDig(digs: readonly Dig[], index: number): boolean {
  const { x, y, z } = digs[index]!.position;
  for (let earlier = 0; earlier < index; earlier += 1) {
    const at = digs[earlier]!.position;
    if (at.x === x && at.y === y && at.z === z) return true;
  }
  return false;
}

function grown<T extends Int32Array | Int8Array | Uint8Array | Float64Array>(column: T, capacity: number): T {
  const wider = new (column.constructor as new (length: number) => T)(capacity);
  wider.set(column);
  return wider;
}
