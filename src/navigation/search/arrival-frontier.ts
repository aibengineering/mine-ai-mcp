/**
 * The best known arrival at each planning state, and the Pareto frontier the
 * search keeps over scaffold counts.
 *
 * The open set cannot lower a queued node's priority, so a cheaper arrival at
 * a state is made as a second node and the earlier one is left queued. When
 * that earlier node pops it is no longer the live arrival and is skipped. A
 * node is also stale when a later arrival at the same feet cell dominated it:
 * no dearer, with at least as many blocks left. Both are one question,
 * `isLive`.
 *
 * Almost every feet cell has one live arrival, so the frontier is a map from
 * feet cell to node index; the few cells reached with several scaffold counts
 * spill into a second map holding the whole frontier as a short list.
 */
import type { NodeStore } from "./node-store.js";

export class ArrivalFrontier {
  readonly #store: NodeStore;
  readonly #live = new Map<number, number>();
  readonly #several = new Map<number, number[]>();

  constructor(store: NodeStore) {
    this.#store = store;
  }

  /** Whether an arrival at this state would be no better than one already on the frontier. */
  dominated(feetKey: number, remaining: number, cost: number): boolean {
    const store = this.#store;
    const several = this.#several.get(feetKey);
    if (several) {
      for (const node of several) if (store.remaining[node]! >= remaining && store.cost[node]! <= cost) return true;
      return false;
    }
    const node = this.#live.get(feetKey);
    return node !== undefined && store.remaining[node]! >= remaining && store.cost[node]! <= cost;
  }

  /** Put a node the caller has found undominated on the frontier, dropping any arrival it dominates. */
  keep(node: number): void {
    const store = this.#store;
    const feetKey = store.key[node]!;
    const remaining = store.remaining[node]!;
    const cost = store.cost[node]!;
    const several = this.#several.get(feetKey);
    if (several) {
      let kept = 0;
      for (const known of several) {
        if (store.remaining[known]! <= remaining && store.cost[known]! >= cost) continue;
        several[kept] = known;
        kept += 1;
      }
      several.length = kept;
      several.push(node);
      if (kept === 0) {
        this.#several.delete(feetKey);
        this.#live.set(feetKey, node);
      }
      return;
    }
    const known = this.#live.get(feetKey);
    if (known === undefined || (store.remaining[known]! <= remaining && store.cost[known]! >= cost)) {
      this.#live.set(feetKey, node);
      return;
    }
    this.#live.delete(feetKey);
    this.#several.set(feetKey, [known, node]);
  }

  /** Whether the node is still the live arrival at its state. */
  isLive(node: number): boolean {
    const feetKey = this.#store.key[node]!;
    const live = this.#live.get(feetKey);
    if (live !== undefined) return live === node;
    return this.#several.get(feetKey)?.includes(node) ?? false;
  }
}
