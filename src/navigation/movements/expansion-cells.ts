/**
 * The cells one expansion has looked at and prepared, kept as columns by
 * offset from its feet.
 *
 * No movement reaches further than four blocks sideways or three up or
 * down, so a fixed grid indexed by offset answers "seen this already?" with
 * an array read rather than a hash of the packed key, and one grid serves
 * every expansion of a catalogue: a stamp per slot says which expansion
 * filled it, so nothing is cleared between nodes. The rare prepared cell
 * outside the grid, a landing under a policy that allows a deeper drop, takes
 * an overflow slot for the expansion and is not found again by coordinates.
 *
 * A prepared cell is a handle: its slot and the role it was prepared for, in
 * one integer. One cell is two different questions, because the cell a
 * traverse passes its head through is the cell a step-up puts its feet in,
 * and a carpet answers those differently; so the verdict is kept per handle.
 * The clearance a cell needs when it is passable as neither, an activation
 * or the digs, is the same answer for both roles and is kept once per slot,
 * as numbers: what a dig costs and takes, not a dig. Search prices every
 * solid cell a movement could pass and keeps few, so the dig itself is
 * spelled out only for a movement search keeps. Everything a movement needs
 * of a cell is read back through the handle, and preparing a cell allocates
 * nothing. The columns are overwritten by the next expansion, which is why a
 * generated movement is only good until the catalogue's next `generate`.
 */
import type { PlanningOverlay } from "../search/planning-overlay.js";
import { type BlockObservation, type BlockPosition, UNLOADED, type WorldView } from "../world/world.js";
import type { Dig } from "./excavation.js";
import type { MovementPolicy, PolicyDecision } from "./policy.js";

/** The two questions a movement asks of a cell: may the feet stand in it, may the head pass through it. */
export const FEET = 0;
export const HEAD = 1;
export type CellRole = typeof FEET | typeof HEAD;

/** The handle of a cell the route may not enter or clear. */
export const NO_CELL = -1;

const NO_BRINGS: readonly BlockPosition[] = Object.freeze([]);

/** A handle's verdict. */
const UNKNOWN = 0;
const REFUSED = 1;
const PASSABLE = 2;
const CLEARED = 3;

/** A slot's clearance: not asked, refused, or how the cell is passed. */
const OPENED = 2;
const DUG = 3;
const COLUMN = 4;

/** What the cell grid reads before any expansion has begun. */
const UNKNOWN_WORLD: WorldView = {
  blockAt: () => UNLOADED,
  revision: 0,
  subscribe: () => () => {},
};

export function policyPenalty(decision: PolicyDecision): number | null {
  if (decision.kind === "prohibited") return null;
  return decision.kind === "penalized" ? decision.cost : 0;
}

const CELL_REACH = 4;
const CELL_RISE = 3;
const CELL_SPAN = 2 * CELL_REACH + 1;
const CELL_LAYERS = 2 * CELL_RISE + 1;
const CELL_SLOTS = CELL_SPAN * CELL_LAYERS * CELL_SPAN;
const INITIAL_OVERFLOW = 64;

export class ExpansionCells {
  #x = 0;
  #y = 0;
  #z = 0;
  #expansion = 0;
  #world: WorldView = UNKNOWN_WORLD;
  #overlay: PlanningOverlay | null = null;
  #untouched = true;
  /** The world as this expansion sees it, each cell read once: what the pricing that takes a view reads. */
  readonly view: WorldView;

  constructor() {
    const cells = this;
    this.view = {
      blockAt: (x, y, z) => cells.look(x, y, z),
      get revision() {
        return cells.#world.revision;
      },
      subscribe: (listener) => cells.#world.subscribe(listener),
    };
  }

  // What the grid remembers about a slot it has looked at, grid slots only.
  readonly #stamps = new Uint32Array(CELL_SLOTS);
  readonly #looked: (BlockObservation | undefined)[] = new Array<BlockObservation | undefined>(CELL_SLOTS);
  /** The policy's step penalty for a cell, or null where it refuses the cell; asked once per expansion. */
  readonly #stepPenalties: (number | null | undefined)[] = new Array<number | null | undefined>(CELL_SLOTS);

  // The prepared cell in a slot, grid and overflow slots alike.
  #capacity = CELL_SLOTS + INITIAL_OVERFLOW;
  #overflowNext = CELL_SLOTS;
  #cellX = new Int32Array(this.#capacity);
  #cellY = new Int32Array(this.#capacity);
  #cellZ = new Int32Array(this.#capacity);
  #stateId = new Int32Array(this.#capacity);
  #clearance = new Int8Array(this.#capacity);
  #activationPenalty = new Float64Array(this.#capacity);
  readonly #activationGroup: (string | null)[] = [];
  /** A dug slot's one dig as numbers: the ticks it takes, the penalty it carries, the tool it wants (-1 for none). */
  #digTicks = new Float64Array(this.#capacity);
  #digPenalty = new Float64Array(this.#capacity);
  #digTool = new Int32Array(this.#capacity);
  /** A falling column priced top down, the rare clearance that is more than one dig. */
  readonly #columns: (readonly Dig[] | undefined)[] = [];
  /** Per handle: two per slot. */
  #verdict = new Int8Array(2 * this.#capacity);

  /** Counts `begin` calls; a handle is only good while this still matches the expansion that made it. */
  get expansion(): number {
    return this.#expansion;
  }

  /**
   * Start an expansion standing at `feet`, seeing `world` through `overlay`.
   *
   * The overlay's edits inside the grid are settled here, once, so that a
   * look at any other cell reads the world directly rather than asking the
   * overlay first; an overlay is a handful of cells, an expansion looks at
   * dozens.
   */
  begin(feet: BlockPosition, world: WorldView, overlay: PlanningOverlay): void {
    this.#x = feet.x;
    this.#y = feet.y;
    this.#z = feet.z;
    this.#world = world;
    this.#overlay = overlay;
    this.#expansion += 1;
    this.#overflowNext = CELL_SLOTS;
    const edited = overlay.editedCells;
    this.#untouched = edited.length === 0;
    for (const cell of edited) {
      const slot = this.slot(cell.x, cell.y, cell.z);
      if (slot >= 0) this.#looked[slot] = overlay.blockAt(world, cell.x, cell.y, cell.z);
    }
  }

  /** The policy's step penalty for a cell, asked of the policy once per expansion. */
  stepPenalty(x: number, y: number, z: number, policy: MovementPolicy): number | null {
    const slot = this.slot(x, y, z);
    if (slot < 0) return policyPenalty(policy.decideStep(x, y, z, this.#world));
    let penalty = this.#stepPenalties[slot];
    if (penalty === undefined) {
      // The policy judges the observed world, never a hypothesis. With no
      // edits in the overlay the grid is the observed world, read once.
      penalty = policyPenalty(policy.decideStep(x, y, z, this.#untouched ? this.view : this.#world));
      this.#stepPenalties[slot] = penalty;
    }
    return penalty;
  }

  /** The grid slot that keeps a cell, or -1 for one outside the grid. */
  slot(x: number, y: number, z: number): number {
    const dx = x - this.#x + CELL_REACH;
    const dy = y - this.#y + CELL_RISE;
    const dz = z - this.#z + CELL_REACH;
    if (dx < 0 || dx >= CELL_SPAN || dy < 0 || dy >= CELL_LAYERS || dz < 0 || dz >= CELL_SPAN) return -1;
    const slot = (dx * CELL_LAYERS + dy) * CELL_SPAN + dz;
    if (this.#stamps[slot] !== this.#expansion) {
      this.#stamps[slot] = this.#expansion;
      this.#looked[slot] = undefined;
      this.#stepPenalties[slot] = undefined;
      this.#forget(slot);
    }
    return slot;
  }

  /** The slot to prepare a cell in: its grid slot, or a fresh overflow slot for a cell beyond the grid. */
  prepareSlot(x: number, y: number, z: number): number {
    const slot = this.slot(x, y, z);
    if (slot >= 0) return slot;
    if (this.#overflowNext === this.#capacity) this.#grow();
    const overflow = this.#overflowNext;
    this.#overflowNext += 1;
    this.#forget(overflow);
    return overflow;
  }

  #forget(slot: number): void {
    this.#verdict[2 * slot] = UNKNOWN;
    this.#verdict[2 * slot + 1] = UNKNOWN;
    this.#clearance[slot] = UNKNOWN;
  }

  #grow(): void {
    this.#capacity *= 2;
    this.#cellX = grown(this.#cellX, this.#capacity);
    this.#cellY = grown(this.#cellY, this.#capacity);
    this.#cellZ = grown(this.#cellZ, this.#capacity);
    this.#stateId = grown(this.#stateId, this.#capacity);
    this.#clearance = grown(this.#clearance, this.#capacity);
    this.#activationPenalty = grown(this.#activationPenalty, this.#capacity);
    this.#digTicks = grown(this.#digTicks, this.#capacity);
    this.#digPenalty = grown(this.#digPenalty, this.#capacity);
    this.#digTool = grown(this.#digTool, this.#capacity);
    this.#verdict = grown(this.#verdict, 2 * this.#capacity);
  }

  /** The cell as this expansion sees it, read once. */
  look(x: number, y: number, z: number): BlockObservation {
    const slot = this.slot(x, y, z);
    if (slot < 0) return this.#overlay!.blockAt(this.#world, x, y, z);
    return (this.#looked[slot] ??= this.#world.blockAt(x, y, z));
  }

  /** The same, for a cell whose slot `prepareSlot` has just handed out, so the slot is not worked out twice; an overflow slot reads through the overlay. */
  lookSlot(slot: number, x: number, y: number, z: number): BlockObservation {
    if (slot >= CELL_SLOTS) return this.#overlay!.blockAt(this.#world, x, y, z);
    return (this.#looked[slot] ??= this.#world.blockAt(x, y, z));
  }

  // ── Preparing a cell ────────────────────────────────────────────────────────

  /** The handle already prepared for this slot and role, `NO_CELL` if it was refused, or undefined if not asked yet. */
  prepared(slot: number, role: CellRole): number | undefined {
    const handle = 2 * slot + role;
    const verdict = this.#verdict[handle];
    if (verdict === UNKNOWN) return undefined;
    return verdict === REFUSED ? NO_CELL : handle;
  }

  refuse(slot: number, role: CellRole): number {
    this.#verdict[2 * slot + role] = REFUSED;
    return NO_CELL;
  }

  /** The cell may be passed as it stands. */
  passable(slot: number, role: CellRole, x: number, y: number, z: number, stateId: number): number {
    this.#place(slot, x, y, z, stateId);
    const handle = 2 * slot + role;
    this.#verdict[handle] = PASSABLE;
    return handle;
  }

  /** Whether the clearance for this slot has been worked out this expansion, for either role. */
  clearanceKnown(slot: number): boolean {
    return this.#clearance[slot] !== UNKNOWN;
  }

  /** Nothing can clear the cell, for either role. */
  refuseClearance(slot: number): void {
    this.#clearance[slot] = REFUSED;
  }

  /** The cell is passed by opening a door or gate; both halves of one share an activation group. */
  settleOpening(slot: number, x: number, y: number, z: number, stateId: number, group: string | null, penalty: number): void {
    this.#place(slot, x, y, z, stateId);
    this.#clearance[slot] = OPENED;
    this.#activationGroup[slot] = group;
    this.#activationPenalty[slot] = penalty;
  }

  /** The cell is passed by digging it, one block priced by what its state settles. */
  settleDig(slot: number, x: number, y: number, z: number, stateId: number, ticks: number, penalty: number, toolType: number | null): void {
    this.#place(slot, x, y, z, stateId);
    this.#clearance[slot] = DUG;
    this.#digTicks[slot] = ticks;
    this.#digPenalty[slot] = penalty;
    this.#digTool[slot] = toolType ?? -1;
  }

  /** The cell is passed by digging the falling column above it and then the cell, already priced top down. */
  settleColumn(slot: number, x: number, y: number, z: number, stateId: number, digs: readonly Dig[]): void {
    this.#place(slot, x, y, z, stateId);
    this.#clearance[slot] = COLUMN;
    this.#columns[slot] = digs;
  }

  /** The cell is passed by way of the slot's settled clearance, if there is one. */
  viaClearance(slot: number, role: CellRole): number {
    const handle = 2 * slot + role;
    if (this.#clearance[slot] >= OPENED) {
      this.#verdict[handle] = CLEARED;
      return handle;
    }
    this.#verdict[handle] = REFUSED;
    return NO_CELL;
  }

  #place(slot: number, x: number, y: number, z: number, stateId: number): void {
    this.#cellX[slot] = x;
    this.#cellY[slot] = y;
    this.#cellZ[slot] = z;
    this.#stateId[slot] = stateId;
  }

  // ── Reading a prepared cell back ────────────────────────────────────────────

  cellX(handle: number): number {
    return this.#cellX[handle >> 1]!;
  }

  cellY(handle: number): number {
    return this.#cellY[handle >> 1]!;
  }

  cellZ(handle: number): number {
    return this.#cellZ[handle >> 1]!;
  }

  cellStateId(handle: number): number {
    return this.#stateId[handle >> 1]!;
  }

  /** How the cell is cleared, or `UNKNOWN` for one passed as it stands. */
  #clearanceOf(handle: number): number {
    return this.#verdict[handle] === CLEARED ? this.#clearance[handle >> 1]! : UNKNOWN;
  }

  cellOpens(handle: number): boolean {
    return this.#clearanceOf(handle) === OPENED;
  }

  cellActivationGroup(handle: number): string | null {
    return this.#clearanceOf(handle) === OPENED ? this.#activationGroup[handle >> 1]! : null;
  }

  cellActivationPenalty(handle: number): number {
    return this.#clearanceOf(handle) === OPENED ? this.#activationPenalty[handle >> 1]! : 0;
  }

  /** Whether entering the cell digs anything: the block itself, or a column and then the block. */
  cellDug(handle: number): boolean {
    return this.#clearanceOf(handle) >= DUG;
  }

  /** The falling column a cell digs, top down and the cell last, or null for a cell that is one dig or none. */
  cellColumn(handle: number): readonly Dig[] | null {
    return this.#clearanceOf(handle) === COLUMN ? this.#columns[handle >> 1]! : null;
  }

  /** What one dug cell costs, for pricing a movement without spelling its dig out; zero for a column, which is priced from its digs. */
  cellDigTicks(handle: number): number {
    return this.#clearanceOf(handle) === DUG ? this.#digTicks[handle >> 1]! : 0;
  }

  cellDigPenalty(handle: number): number {
    return this.#clearanceOf(handle) === DUG ? this.#digPenalty[handle >> 1]! : 0;
  }

  /** The one dig a dug cell is, spelled out for a movement search keeps. */
  cellDig(handle: number): Dig {
    const slot = handle >> 1;
    const tool = this.#digTool[slot]!;
    return {
      position: { x: this.#cellX[slot]!, y: this.#cellY[slot]!, z: this.#cellZ[slot]! },
      stateId: this.#stateId[slot]!,
      toolType: tool < 0 ? null : tool,
      expectedTicks: this.#digTicks[slot]!,
      penalty: this.#digPenalty[slot]!,
      brings: NO_BRINGS,
    };
  }
}

function grown<T extends Int32Array | Int8Array | Uint8Array | Float64Array>(column: T, capacity: number): T {
  const wider = new (column.constructor as new (length: number) => T)(capacity);
  wider.set(column);
  return wider;
}
