/**
 * The search's node records, kept as columns.
 *
 * A node is an index. The numbers the search compares on every pop, push,
 * and arrival check — the packed feet cell, the cost, the estimate, the
 * scaffolds left — live in typed arrays, so the open set and the arrival
 * frontier read them without chasing a pointer per node, and making a node
 * costs no allocation. What has to stay an object, the planning state the
 * node stands in and the terminal movement it may carry, sits in ordinary
 * arrays alongside, in the same index. This is Baritone's PathNode with
 * primitive fields, laid out the way JavaScript can keep it unboxed.
 */
import type { GeneratedMovement, PlanningState } from "../movements/catalogue.js";

const INITIAL_CAPACITY = 1024;

export class NodeStore {
  #capacity = INITIAL_CAPACITY;
  /** How many nodes have been made; indices below this are live. */
  length = 0;
  /** The packed feet cell; with `remaining` it names the planning state. */
  key = new Float64Array(INITIAL_CAPACITY);
  cost = new Float64Array(INITIAL_CAPACITY);
  /** The goal's estimate from the node, taken once when the node is made. */
  heuristic = new Float64Array(INITIAL_CAPACITY);
  /** What orders the open set: cost plus heuristic, or the cost alone for a terminal node. */
  estimate = new Float64Array(INITIAL_CAPACITY);
  /** Scaffold blocks left on arrival. */
  remaining = new Int32Array(INITIAL_CAPACITY);
  depth = new Int32Array(INITIAL_CAPACITY);
  /** The node this one was reached from, or -1 for the root. */
  parent = new Int32Array(INITIAL_CAPACITY);
  readonly state: PlanningState[] = [];
  /** The terminal movement a node carries when it completes the goal without moving the feet. */
  readonly finish: (GeneratedMovement | null)[] = [];

  /** Make a node and return its index. */
  add(
    key: number,
    state: PlanningState,
    cost: number,
    heuristic: number,
    estimate: number,
    depth: number,
    parent: number,
    finish: GeneratedMovement | null,
  ): number {
    const node = this.length;
    if (node === this.#capacity) this.#grow();
    this.key[node] = key;
    this.cost[node] = cost;
    this.heuristic[node] = heuristic;
    this.estimate[node] = estimate;
    this.remaining[node] = state.node.remainingScaffolds;
    this.depth[node] = depth;
    this.parent[node] = parent;
    this.state[node] = state;
    this.finish[node] = finish;
    this.length = node + 1;
    return node;
  }

  /** The feet cell of a node, from the state it stands in. */
  feet(node: number) {
    return this.state[node]!.node.feet;
  }

  #grow(): void {
    this.#capacity *= 2;
    this.key = grown(this.key, this.#capacity);
    this.cost = grown(this.cost, this.#capacity);
    this.heuristic = grown(this.heuristic, this.#capacity);
    this.estimate = grown(this.estimate, this.#capacity);
    this.remaining = grown(this.remaining, this.#capacity);
    this.depth = grown(this.depth, this.#capacity);
    this.parent = grown(this.parent, this.#capacity);
  }
}

function grown<T extends Float64Array | Int32Array>(column: T, capacity: number): T {
  const wider = new (column.constructor as new (length: number) => T)(capacity);
  wider.set(column);
  return wider;
}
