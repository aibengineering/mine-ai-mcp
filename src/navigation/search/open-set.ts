/**
 * The open set: a binary heap of node indices, cheapest estimate first.
 *
 * Ties go to the higher cost, which is the node that has travelled further
 * for the same promise. The heap holds indices in a typed array and reads the
 * estimates and costs it compares straight out of the node store, so a sift
 * touches no objects.
 */
import type { NodeStore } from "./node-store.js";

const INITIAL_CAPACITY = 1024;

export class OpenSet {
  readonly #store: NodeStore;
  #nodes = new Int32Array(INITIAL_CAPACITY);
  #size = 0;

  constructor(store: NodeStore) {
    this.#store = store;
  }

  get size(): number {
    return this.#size;
  }

  push(node: number): void {
    if (this.#size === this.#nodes.length) {
      const wider = new Int32Array(this.#nodes.length * 2);
      wider.set(this.#nodes);
      this.#nodes = wider;
    }
    this.#nodes[this.#size] = node;
    this.#size += 1;
    this.#up(this.#size - 1);
  }

  /** The cheapest node, or -1 when the set is empty. */
  pop(): number {
    if (this.#size === 0) return -1;
    const first = this.#nodes[0]!;
    this.#size -= 1;
    if (this.#size > 0) {
      this.#nodes[0] = this.#nodes[this.#size]!;
      this.#down(0);
    }
    return first;
  }

  #comesBefore(left: number, right: number): boolean {
    const estimate = this.#store.estimate;
    const leftEstimate = estimate[left]!;
    const rightEstimate = estimate[right]!;
    if (leftEstimate !== rightEstimate) return leftEstimate < rightEstimate;
    return this.#store.cost[left]! > this.#store.cost[right]!;
  }

  #up(index: number): void {
    const nodes = this.#nodes;
    const node = nodes[index]!;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      const above = nodes[parent]!;
      if (!this.#comesBefore(node, above)) break;
      nodes[index] = above;
      index = parent;
    }
    nodes[index] = node;
  }

  #down(index: number): void {
    const nodes = this.#nodes;
    const size = this.#size;
    const node = nodes[index]!;
    for (;;) {
      const left = index * 2 + 1;
      if (left >= size) break;
      const right = left + 1;
      let child = left;
      if (right < size && this.#comesBefore(nodes[right]!, nodes[left]!)) child = right;
      if (!this.#comesBefore(nodes[child]!, node)) break;
      nodes[index] = nodes[child]!;
      index = child;
    }
    nodes[index] = node;
  }
}
