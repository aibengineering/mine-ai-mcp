import { canReleaseOnObservedGround, hasSupportedCorridor, safeSupportingCell } from "../world/block-geometry.js";
import type { BlockPosition, Position3, WorldView } from "../world/world.js";
import {
  type MovementController,
  type MovementSnapshot,
  type MovementTick,
  recenterControls,
} from "./movement-controller.js";

/** Stationary movement, including the landing after an external impulse. */
export class SupportedPositionController implements MovementController {
  #support: BlockPosition | null;
  readonly initialControls = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false,
  };

  constructor(
    private readonly world: WorldView,
    private readonly start: MovementSnapshot,
  ) {
    this.#support = start.onGround ? safeSupportingCell(world, start.position) : null;
  }

  get aim(): Position3 {
    return this.#support
      ? { x: this.#support.x + 0.5, y: this.#support.y, z: this.#support.z + 0.5 }
      : this.start.position;
  }

  cancel(snapshot: MovementSnapshot): "stopped" | "settling" {
    if (!this.#support || snapshot.isInWater || snapshot.climbing) return "stopped";
    return canReleaseOnObservedGround(this.world, snapshot) ? "stopped" : "settling";
  }

  advance(snapshot: MovementSnapshot): MovementTick {
    if (snapshot.onGround) this.#support = safeSupportingCell(this.world, snapshot.position);
    if (!this.#support) return { kind: "failed" };
    // A continuous safe floor needs no cell-centre correction. Preserve the
    // ledge controller when nearby support or the momentum corridor is unsafe.
    if (snapshot.onGround && canReleaseOnObservedGround(this.world, snapshot) &&
      [[0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6]].every(([x, z]) =>
        hasSupportedCorridor(this.world, snapshot.position, { x: x!, y: 0, z: z! })))
      return { kind: "running", controls: this.initialControls };
    // Keep correcting inward even below the original ledge: a lower shelf can
    // still catch the body. Sneaking in air only weakens that corrective input.
    // The correction strafes against the heading the movement left behind;
    // it never turns the head toward the centre.
    const correction = recenterControls(snapshot, this.aim, 0.15);
    const correcting = correction.forward || correction.back || correction.left || correction.right;
    return {
      kind: "running",
      // Crouch only for the short correction toward the cell centre. Once
      // centred there is no walking input to keep away from an edge.
      controls: { ...correction, sneak: snapshot.onGround && correcting },
    };
  }
}
