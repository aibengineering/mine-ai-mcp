/**
 * A positional step cost supplied to the search by whoever knows something the
 * search cannot see for itself.
 *
 * Navigation prices terrain. It has no vocabulary for a mob, a claimed
 * building, or anything else that makes a cell worth avoiding for a reason
 * outside the block model, and it must not grow one: the observation the
 * search reads records an entity as an id, a position and a box, and the
 * classifiers all live in layers that import navigation rather than the other
 * way round. So the classification stays where it belongs and only its answer
 * arrives here, as a number per cell.
 *
 * A field is always a cost and never a prohibition. A zombie standing in the
 * only doorway must not make the room unreachable, and a prohibition that
 * appears and disappears as something moves makes the route oscillate. A price
 * composes with the costs already in the model and lets the search decide.
 */

/** A cost added to standing on a cell, frozen for the life of one search. */
export interface StepField {
  /** Ticks added to entering this cell. Called once per candidate cell, so it stays arithmetic. */
  readonly costAt: (x: number, y: number, z: number) => number;
  /**
   * Distinguishes two snapshots, and joins the identity of the search holding it.
   *
   * A run refuses to repeat a search whose identity it has already seen. Without
   * this the same question asked after the field moved would be read as the run
   * going in circles rather than as a new question.
   */
  readonly fingerprint: string;
}

/**
 * Supplies a fresh snapshot for each search. Registered once on the runtime.
 *
 * `null` means there is nothing to price right now, which is the common answer
 * and leaves the search identical to one with no field registered at all.
 */
export type StepFieldProvider = () => StepField | null;
