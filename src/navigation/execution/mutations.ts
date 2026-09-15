/**
 * The expected-mutation ledger: how a route tells its own effects from the
 * world's.
 *
 * Before the bot breaks, places, or activates a block, the executor
 * registers what it expects to see: the block, its state before, its state
 * after, and a deadline. When the world publishes a change, `classify`
 * settles the matching expectation and names the change for the run:
 * - expected: the change the route was waiting for; the effect is confirmed;
 * - conflicting: the block changed, but not into what was planned;
 * - invalidating: an unrelated change to a block the walked route depends on;
 * - irrelevant: everything else, including no-op updates.
 *
 * Receipts keep an issued expectation alive after the executor has moved on,
 * so a late acknowledgement of the bot's own dig is still recognised as
 * expected rather than mistaken for an invalidating change. The physics tick
 * drives `expire`, so a lost acknowledgement cannot be waited on forever.
 */
import type { BlockMatcher } from "../movements/movement.js";
import { type BlockPosition, type WorldChange, blockKey, blockLabel, samePosition } from "../world/world.js";

export interface AttemptToken {
  readonly runId: string;
  readonly planId: string;
  readonly stepId: string;
  readonly attempt: number;
}
interface Expectation {
  readonly token: AttemptToken;
  readonly position: BlockPosition;
  readonly before: BlockMatcher;
  readonly after: BlockMatcher;
  readonly operation: "break" | "place" | "activate";
  readonly deadlineMs: number;
  /**
   * Cells whose every change belongs to this operation while it is remembered:
   * a break that brings a falling column down watches the blocks above turn
   * to entities, land in the cleared cell, and be broken again there, and none
   * of that is the world contradicting the route.
   */
  readonly owned?: readonly BlockPosition[];
  issued: boolean;
  settle(result: MutationResult): void;
}
export type MutationResult =
  | { readonly kind: "confirmed"; readonly change: WorldChange }
  | { readonly kind: "conflicting"; readonly change: WorldChange }
  | { readonly kind: "expired" };
export type MutationClassification = "expected" | "conflicting" | "invalidating" | "irrelevant";

export class ExpectedMutationLedger {
  readonly #active = new Map<string, Expectation>();
  readonly #receipts = new Map<string, Expectation>();
  expect(input: Omit<Expectation, "issued" | "settle">): {
    readonly result: Promise<MutationResult>;
    markIssued(): void;
    detach(): void;
    cancel(): void;
  } {
    let settle!: (result: MutationResult) => void;
    const result = new Promise<MutationResult>((resolve) => {
      settle = resolve;
    });
    const key = `${input.token.runId}:${input.token.stepId}:${input.token.attempt}:${blockLabel(input.position)}`;
    const expectation: Expectation = { ...input, issued: false, settle };
    this.#active.set(key, expectation);
    const remove = () => this.#active.delete(key);
    return {
      result,
      markIssued: () => {
        expectation.issued = true;
      },
      detach: () => {
        remove();
        if (expectation.issued) this.#receipts.set(key, expectation);
        else settle({ kind: "expired" });
      },
      cancel: () => {
        remove();
        settle({ kind: "expired" });
      },
    };
  }
  classify(change: WorldChange, dependencies: ReadonlySet<number>, now: number): MutationClassification {
    this.expire(now);
    const matches = [...this.#active.entries()].find(([, item]) => samePosition(item.position, change.position));
    if (matches) {
      const [key, item] = matches;
      if (item.before.matches(change.before) && item.after.matches(change.after)) {
        this.#active.delete(key);
        this.#receipts.set(key, item);
        item.settle({ kind: "confirmed", change });
        return "expected";
      }
      if (item.before.matches(change.before) && item.before.matches(change.after)) return "irrelevant";
      this.#active.delete(key);
      item.settle({ kind: "conflicting", change });
      return "conflicting";
    }
    const receipt = [...this.#receipts.entries()].find(
      ([, item]) => samePosition(item.position, change.position) && item.after.matches(change.after),
    );
    if (receipt) {
      receipt[1].settle({ kind: "confirmed", change });
      return "expected";
    }
    for (const collection of [this.#active, this.#receipts])
      for (const item of collection.values())
        if (item.owned?.some((cell) => samePosition(cell, change.position))) return "expected";
    // A block whose state did not change cannot invalidate anything. Mineflayer
    // reports neighbour updates as `blockUpdate` with identical before and
    // after states, and breaking one cell of a one-wide tunnel updates every
    // neighbour — all of which are route dependencies. Without this the bot's
    // own excavation replanned the route several times per block: 44 step
    // starts for 15 completions, 110 seconds to advance seven blocks.
    //
    // It sits after the receipt check on purpose. A duplicate acknowledgement
    // of a break is also a no-op, but it has to settle its receipt rather than
    // be dropped here.
    if (
      change.before.kind === "loaded" &&
      change.after.kind === "loaded" &&
      change.before.stateId === change.after.stateId
    )
      return "irrelevant";
    return dependencies.has(blockKey(change.position)) ? "invalidating" : "irrelevant";
  }
  expire(now: number) {
    for (const collection of [this.#active, this.#receipts])
      for (const [key, item] of collection)
        if (now >= item.deadlineMs) {
          collection.delete(key);
          item.settle({ kind: "expired" });
        }
  }
  get activeCount() {
    return this.#active.size;
  }
  get receiptCount() {
    return this.#receipts.size;
  }
}
