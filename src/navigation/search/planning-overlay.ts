/**
 * The planning overlay: edits a candidate route has predicted, layered over
 * the observed world. A hypothesis, never a fact — the live `WorldView` stays
 * authoritative, and the overlay exists only so search can reason about the
 * cells after the breaks and placements its route has already assumed.
 *
 * Overlays are immutable and share structure: `apply` returns a new overlay
 * that reuses the untouched parts of the old one, so the many overlays a
 * search creates cost little. Entries live in a treap keyed by block, which
 * gives every set of edits one canonical shape and therefore one content
 * hash, so the same edits always yield the same `identity` whichever order
 * they were made in.
 */
import type { PredictedWorldEffect } from "../movements/movement.js";
import {
  blockKey,
  loadedObservation,
  packKey,
  type BlockObservation,
  type BlockPosition,
  type LoadedBlock,
  type WorldView,
} from "../world/world.js";

interface OverlayEntry {
  readonly key: number;
  readonly priority: number;
  readonly hashA: number;
  readonly hashB: number;
  readonly position: BlockPosition;
  readonly stateId: number;
  readonly kind: PredictedWorldEffect["kind"];
}

interface OverlayNode {
  readonly hashA: number;
  readonly hashB: number;
  readonly size: number;
  readonly entry: OverlayEntry;
  readonly left: OverlayNode | null;
  readonly right: OverlayNode | null;
}

const EMPTY_TRAITS = Object.freeze({
  empty: true,
  liquid: null,
  liquidSource: false,
  waterlogged: false,
  waterloggable: false,
  climbable: false,
  openable: false,
  open: false,
  activationGroup: null,
  upperHalf: false,
  falling: false,
  yielding: false,
  damaging: false,
  interactive: false,
  parkourTakeoff: "prohibited",
  safeToBreak: false,
} as const);

const SOLID_TRAITS = Object.freeze({
  empty: false,
  liquid: null,
  liquidSource: false,
  waterlogged: false,
  waterloggable: false,
  climbable: false,
  openable: false,
  open: false,
  activationGroup: null,
  upperHalf: false,
  falling: false,
  yielding: false,
  damaging: false,
  interactive: false,
  parkourTakeoff: "normal",
  safeToBreak: true,
} as const);

/** What a predicted break leaves behind: air. */
const BROKEN: BlockObservation = loadedObservation(0, [], EMPTY_TRAITS);
const FULL_BLOCK = Object.freeze([Object.freeze({ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 })]);
/** What a predicted placement puts down, one shared observation per placed state. */
const placed = new Map<number, BlockObservation>();

function placedObservation(stateId: number): BlockObservation {
  if (stateId === 0) return BROKEN;
  let observation = placed.get(stateId);
  if (!observation) {
    observation = loadedObservation(stateId, FULL_BLOCK, SOLID_TRAITS);
    placed.set(stateId, observation);
  }
  return observation;
}

function mix(hash: number, value: number): number {
  hash ^= value;
  return Math.imul(hash, 0x01000193) >>> 0;
}

/** Hash a packed cell key: its low and high halves fed through the same FNV-style mix. */
function priority(key: number): number {
  return mix(mix(0x811c9dc5, key >>> 0), Math.floor(key / 4294967296));
}

function entryHash(seed: number, keyHash: number, kind: PredictedWorldEffect["kind"], stateId: number): number {
  let hash = mix(seed, keyHash);
  hash ^= kind === "break" ? 1 : kind === "place" ? 2 : 3;
  hash = Math.imul(hash, 0x01000193);
  hash ^= stateId;
  return Math.imul(hash, 0x01000193) >>> 0;
}

function comesBefore(left: OverlayEntry, right: OverlayEntry): boolean {
  const leftPriority = left.priority;
  const rightPriority = right.priority;
  return leftPriority < rightPriority || (leftPriority === rightPriority && left.key < right.key);
}

function contentHash(seed: number, entryHashValue: number, left: number, right: number): number {
  return mix(mix(mix(seed, entryHashValue), left), right);
}

/** Creates structurally shared immutable edit trees with deterministic content identities. */
export class OverlayInterner {
  #node(entry: OverlayEntry, left: OverlayNode | null, right: OverlayNode | null): OverlayNode {
    const leftA = left?.hashA ?? 0;
    const rightA = right?.hashA ?? 0;
    const leftB = left?.hashB ?? 0;
    const rightB = right?.hashB ?? 0;
    return {
      hashA: contentHash(0x811c9dc5, entry.hashA, leftA, rightA),
      hashB: contentHash(0x9e3779b9, entry.hashB, leftB, rightB),
      size: 1 + (left?.size ?? 0) + (right?.size ?? 0),
      entry,
      left,
      right,
    };
  }

  set(root: OverlayNode | null, entry: OverlayEntry): OverlayNode {
    if (!root) return this.#node(entry, null, null);
    if (entry.key === root.entry.key) {
      if (entry.stateId === root.entry.stateId && entry.kind === root.entry.kind) return root;
      return this.#node(entry, root.left, root.right);
    }
    if (entry.key < root.entry.key) {
      const left = this.set(root.left, entry);
      const updated = this.#node(root.entry, left, root.right);
      if (!comesBefore(left.entry, updated.entry)) return updated;
      return this.#node(left.entry, left.left, this.#node(updated.entry, left.right, updated.right));
    }
    const right = this.set(root.right, entry);
    const updated = this.#node(root.entry, root.left, right);
    if (!comesBefore(right.entry, updated.entry)) return updated;
    return this.#node(right.entry, this.#node(updated.entry, updated.left, right.left), right.right);
  }
}

/** The identity of an overlay with no predicted edits: the world as observed. */
export const EMPTY_OVERLAY_IDENTITY = "overlay:0";

/** Every entry of a treap in key order, and the cell of each. */
function collectEntries(node: OverlayNode | null, byKey: Map<number, OverlayEntry>, cells: BlockPosition[]): void {
  if (!node) return;
  collectEntries(node.left, byKey, cells);
  byKey.set(node.entry.key, node.entry);
  cells.push(node.entry.position);
  collectEntries(node.right, byKey, cells);
}

interface FlattenedEntries {
  readonly byKey: ReadonlyMap<number, OverlayEntry>;
  readonly cells: readonly BlockPosition[];
}

const NO_ENTRIES: FlattenedEntries = Object.freeze({
  byKey: new Map<number, OverlayEntry>(),
  cells: Object.freeze([]),
});

/**
 * The opened form of a door or gate's observation, made once per state: the
 * world's observations are shared per state, and every expansion under an
 * overlay that opens a door reads the opened cell again.
 */
const OPENED = new WeakMap<LoadedBlock, LoadedBlock>();
function openedObservation(original: LoadedBlock, stateId: number): LoadedBlock {
  const known = OPENED.get(original);
  if (known !== undefined && known.stateId === stateId) return known;
  const opened = loadedObservation(stateId, original.collisionShapes, { ...original.traits, open: true });
  OPENED.set(original, opened);
  return opened;
}

export class PlanningOverlay {
  /** Read this route's predicted edits through the same interface as the observed world. */
  view(world: WorldView): WorldView {
    return {
      blockAt: (x, y, z) => this.blockAt(world, x, y, z),
      get revision() {
        return world.revision;
      },
      subscribe: (listener) => world.subscribe(listener),
    };
  }

  #identity: string | undefined;
  #entries: FlattenedEntries | undefined;

  constructor(
    readonly interner: OverlayInterner,
    readonly root: OverlayNode | null = null,
  ) {}

  /** The content identity, spelled out on first read: a chain of applies names only its last overlay. */
  get identity(): string {
    return (this.#identity ??= this.root
      ? `overlay:${this.root.size}:${this.root.hashA.toString(36)}:${this.root.hashB.toString(36)}`
      : EMPTY_OVERLAY_IDENTITY);
  }

  apply(effect: PredictedWorldEffect): PlanningOverlay {
    const key = blockKey(effect.position);
    const keyPriority = priority(key);
    const entry = {
      key,
      priority: keyPriority,
      hashA: entryHash(0x811c9dc5, keyPriority, effect.kind, effect.stateId),
      hashB: entryHash(0x9e3779b9, keyPriority, effect.kind, effect.stateId),
      position: effect.position,
      stateId: effect.stateId,
      kind: effect.kind,
    };
    const root = this.interner.set(this.root, entry);
    return root === this.root ? this : new PlanningOverlay(this.interner, root);
  }

  blockAt(world: WorldView, x: number, y: number, z: number): BlockObservation {
    // Most overlays are empty, and most lookups through a non-empty one miss.
    if (!this.root) return world.blockAt(x, y, z);
    const entry = this.#flattened().byKey.get(packKey(x, y, z));
    if (!entry) return world.blockAt(x, y, z);
    if (entry.kind === "activate") {
      const original = world.blockAt(x, y, z);
      if (original.kind === "unloaded") return original;
      return openedObservation(original, entry.stateId);
    }
    return placedObservation(entry.stateId);
  }

  /** The cells this overlay edits, for a reader that settles them all before asking cell by cell. */
  get editedCells(): readonly BlockPosition[] {
    return this.#flattened().cells;
  }

  /**
   * The treap gives every set of edits one shape and one identity; reading it
   * is a walk. An overlay that is read at all is read for every cell of every
   * expansion that carries it, so its entries are flattened the first time,
   * and the walk is paid once.
   */
  #flattened(): FlattenedEntries {
    if (!this.#entries) {
      if (!this.root) return (this.#entries = NO_ENTRIES);
      const byKey = new Map<number, OverlayEntry>();
      const cells: BlockPosition[] = [];
      collectEntries(this.root, byKey, cells);
      this.#entries = { byKey, cells };
    }
    return this.#entries;
  }
}
