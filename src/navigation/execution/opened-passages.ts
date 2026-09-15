import { STANDING_EYE_HEIGHT } from "../../world/block-visibility.js";
import type { PlannedOperation, PlannedStep } from "../movements/movement.js";
import { navigationFeet } from "../world/block-geometry.js";
import {
  activationGroupAt,
  type BlockPosition,
  type NavigationObservation,
  type Position3,
  type WorldView,
} from "../world/world.js";

export interface OpenedPassage {
  readonly group: string;
  readonly position: BlockPosition;
  readonly cells: readonly BlockPosition[];
}

export interface UnrestoredPassage {
  readonly position: BlockPosition;
  readonly observation: string;
}

/** Doors opened by one navigation run, retained across route invalidation and replanning. */
export class OpenedPassages {
  readonly #opened = new Map<string, { passage: OpenedPassage; state: "opening" | "open" }>();

  constructor(
    readonly world: WorldView,
    readonly dimension: string,
  ) {}

  get hasOpened(): boolean {
    return this.#opened.size > 0;
  }

  closedAt(position: BlockPosition): OpenedPassage | null {
    const block = this.world.blockAt(position.x, position.y, position.z);
    const group = activationGroupAt(block, position);
    if (block.kind !== "loaded" || !block.traits.openable || block.traits.open || group === null) return null;
    const lower = { ...position, y: position.y - (block.traits.upperHalf ? 1 : 0) };
    const upper = { ...lower, y: lower.y + 1 };
    const cells = [lower];
    if (activationGroupAt(this.world.blockAt(upper.x, upper.y, upper.z), upper) === group) cells.push(upper);
    return { group, position: lower, cells };
  }

  /** Called only after the activation was issued, including an acknowledgement arriving after cancellation. */
  remember(passage: OpenedPassage | null): void {
    if (passage) this.#opened.set(passage.group, { passage, state: "opening" });
  }

  #obstruction(passage: OpenedPassage, observed: NavigationObservation): string | null {
    if (observed.dimension !== this.dimension) return "The bot changed dimension.";
    for (const position of passage.cells) {
      const block = this.world.blockAt(position.x, position.y, position.z);
      if (block.kind === "unloaded") return "The doorway is no longer loaded.";
      if (activationGroupAt(block, position) !== passage.group) return "The doorway blocks changed.";
      if (!block.traits.open) return "The doorway is only partially confirmed open.";
    }
    // Wait until the entire body has cleared the passage, not merely the thin
    // closed collision plane. This also leaves an occupied gate open.
    if (this.#occupies(passage, observed.position, 0.6, 1.8)) return "The bot still occupies the doorway.";
    if (
      [...observed.entities.values()].some((entity) =>
        this.#occupies(passage, entity.position, entity.width, entity.height),
      )
    )
      return "An entity occupies the doorway.";
    // Survival block interaction reach; do not walk back or extend a completed route to close a door.
    if (
      Math.hypot(
        observed.position.x - passage.position.x - 0.5,
        observed.position.y + STANDING_EYE_HEIGHT - passage.position.y - 0.5,
        observed.position.z - passage.position.z - 0.5,
      ) > 4.5
    )
      return "The doorway is outside interaction reach.";
    return null;
  }

  #occupies(passage: OpenedPassage, position: Position3, width: number, height: number): boolean {
    return passage.cells.some(
      (cell) =>
        position.x + width / 2 > cell.x &&
        position.x - width / 2 < cell.x + 1 &&
        position.z + width / 2 > cell.z &&
        position.z - width / 2 < cell.z + 1 &&
        position.y + height > cell.y &&
        position.y < cell.y + (passage.cells.length === 1 ? 1.5 : 1),
    );
  }

  /** Finish fitting inside the reached stance; never move out of a doorway's own cell for cleanup. */
  clearanceCell(observed: NavigationObservation, requiredCells: readonly BlockPosition[] = []): BlockPosition | null {
    this.#refresh(observed);
    if (observed.dimension !== this.dimension || observed.stance !== "supported") return null;
    const cell = navigationFeet(observed.position, true);
    const center = { x: cell.x + 0.5, y: observed.position.y, z: cell.z + 0.5 };
    const passages = [...this.#opened.values()].filter(
      (entry) => entry.state === "open" && !this.#required(entry.passage, requiredCells),
    );
    return passages.some(({ passage }) => this.#occupies(passage, observed.position, 0.6, 1.8)) &&
      passages.every(({ passage }) => !this.#occupies(passage, center, 0.6, 1.8))
      ? cell
      : null;
  }

  #refresh(observed: NavigationObservation): void {
    if (observed.dimension !== this.dimension) return;
    for (const [group, entry] of this.#opened) {
      const { passage } = entry;
      if (
        passage.cells.some((position) => {
          const block = this.world.blockAt(position.x, position.y, position.z);
          return block.kind === "loaded" && activationGroupAt(block, position) === group && block.traits.open;
        })
      )
        entry.state = "open";
      if (
        entry.state === "open" &&
        passage.cells.every((position) => {
          const block = this.world.blockAt(position.x, position.y, position.z);
          return block.kind === "loaded" && activationGroupAt(block, position) === group && !block.traits.open;
        })
      )
        this.#opened.delete(group);
    }
  }

  #required(passage: OpenedPassage, cells: readonly BlockPosition[]): boolean {
    return passage.cells.some((door) =>
      cells.some((cell) => cell.x === door.x && cell.y === door.y && cell.z === door.z),
    );
  }

  nextToClose(observed: NavigationObservation, requiredCells: readonly BlockPosition[] = []): OpenedPassage | null {
    this.#refresh(observed);
    return (
      [...this.#opened.values()].find(
        ({ passage, state }) =>
          state === "open" && !this.#required(passage, requiredCells) && this.#obstruction(passage, observed) === null,
      )?.passage ?? null
    );
  }

  pending(observed: NavigationObservation): readonly UnrestoredPassage[] {
    this.#refresh(observed);
    return [...this.#opened.values()].map(({ passage, state }) => ({
      position: passage.position,
      observation:
        state === "opening"
          ? "Opening was issued but has not been confirmed."
          : (this.#obstruction(passage, observed) ?? "The doorway has not been confirmed closed."),
    }));
  }

  /** Reuse the executor's confirmed activation operation for restoration of every door half. */
  closingStep(
    passage: OpenedPassage,
    step: PlannedStep,
  ): PlannedStep & {
    readonly operations: readonly [Extract<PlannedOperation, { kind: "activate" }>];
  } {
    return {
      ...step,
      id: `${step.id}:close:${passage.group}`,
      cost: { expectedTicks: 1, breakPenalty: 0, placementPenalty: 0, hazardPenalty: 0, total: 1 },
      operations: [
        {
          kind: "activate",
          position: passage.position,
          before: {
            description: "open passage",
            matches: (block) => block.kind === "loaded" && block.traits.openable && block.traits.open,
          },
          after: {
            description: "closed passage",
            matches: (block) => block.kind === "loaded" && block.traits.openable && !block.traits.open,
          },
        },
      ],
      effects: passage.cells.map((position) => {
        const block = this.world.blockAt(position.x, position.y, position.z);
        if (block.kind !== "loaded") throw new Error("Restoration target became unloaded.");
        return { kind: "activate", position, stateId: block.stateId };
      }),
    };
  }
}
