/** An in-memory `WorldView` for tests: blocks are loaded by hand, and every load publishes a change. */
import {
  type BlockObservation,
  type BlockPosition,
  type BlockTraits,
  type CollisionBox,
  type WorldChange,
  type WorldView,
  UNLOADED,
  blockKey,
  loadedObservation,
  packKey,
} from "./world.js";

const AIR_TRAITS: BlockTraits = Object.freeze({
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
});

export interface MemoryBlock {
  readonly stateId: number;
  readonly collisionShapes?: readonly CollisionBox[];
  readonly traits?: Partial<BlockTraits>;
}

export class MemoryWorld implements WorldView {
  readonly #blocks = new Map<number, BlockObservation>();
  readonly #listeners = new Set<(change: WorldChange) => void>();
  #revision = 0;

  get revision(): number {
    return this.#revision;
  }

  blockAt(x: number, y: number, z: number): BlockObservation {
    return this.#blocks.get(packKey(x, y, z)) ?? UNLOADED;
  }

  load(position: BlockPosition, block: MemoryBlock): void {
    const before = this.blockAt(position.x, position.y, position.z);
    this.#revision += 1;
    const traits: BlockTraits = Object.freeze({
      ...AIR_TRAITS,
      empty: block.stateId === 0,
      parkourTakeoff: block.stateId === 0 ? "prohibited" : "normal",
      safeToBreak: block.stateId !== 0,
      ...block.traits,
    });
    const after = loadedObservation(
      block.stateId,
      block.collisionShapes ?? (traits.empty ? [] : [{ minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 }]),
      traits,
    );
    this.#blocks.set(blockKey(position), after);
    const change = Object.freeze({
      position: Object.freeze({ ...position }),
      before,
      after,
      worldRevision: this.#revision,
    });
    for (const listener of this.#listeners) listener(change);
  }

  subscribe(listener: (change: WorldChange) => void): () => void {
    this.#listeners.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      this.#listeners.delete(listener);
    };
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }
}
