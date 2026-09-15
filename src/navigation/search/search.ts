/**
 * Incremental A* over planning states.
 *
 * A planning state is where the bot's feet are, how many scaffold blocks it
 * has left, and the overlay of edits its route so far has predicted. Search
 * asks the catalogue for the edges out of each state, prices them with the
 * goal's heuristic (in ticks, the same unit as costs), and expands the
 * cheapest estimate first.
 *
 * It runs in slices. `advance` spends a small compute budget and returns a
 * `SearchUpdate`: progress, a complete route, a partial segment worth walking,
 * no path, a limit reached, stale, or cancelled. The run yields to the event
 * loop between slices so physics keeps running, and only compute time counts
 * against the search's timeouts.
 *
 * Nodes are indices into a `NodeStore` of columns; the `OpenSet` and the
 * `ArrivalFrontier` read the numbers they compare straight out of it. Partial
 * routes follow Baritone. `PartialRouteCandidates` keeps, for each of several
 * appetites for spending, the node the search would walk to if it had to
 * stop now; once one of them has travelled far enough the short primary
 * timeout applies, and on expiry a segment toward the strictest travelled
 * candidate is cut and returned. The frontier keeps the Pareto set of ways to
 * reach a cell with different scaffold counts, so scaffolds do not multiply
 * the graph. A route's own preconditions name the blocks a change to which
 * invalidates it; the run watches those.
 */
import type { ResolvedGoal } from "../goals/goal.js";
import type { PlannedStep, RoutePlan } from "../movements/movement.js";
import type { ClosestNodeEvidence, SearchLimitEvidence } from "../orchestration/outcome.js";
import type { PartialRouteCheckpoint, SearchLimits, SearchEvidence } from "./search-result.js";
import { blockKey, packKey } from "../world/world.js";
import type { GenerationContext, MovementCatalogue, PlanningState } from "../movements/catalogue.js";
import { ArrivalFrontier } from "./arrival-frontier.js";
import { NodeStore } from "./node-store.js";
import { OpenSet } from "./open-set.js";

export type { SearchEvidence } from "./search-result.js";
export type SearchUpdate =
  | { readonly kind: "progress"; readonly evidence: SearchEvidence; readonly checkpoint?: PartialRouteCheckpoint }
  | {
      readonly kind: "segment_ready" | "complete";
      readonly plan: RoutePlan;
      readonly evidence: SearchEvidence;
      readonly checkpoint?: PartialRouteCheckpoint;
    }
  | {
      readonly kind: "no_path";
      readonly closest: ClosestNodeEvidence;
      readonly evidence: SearchEvidence;
      readonly checkpoint?: PartialRouteCheckpoint;
    }
  | {
      readonly kind: "limit";
      readonly limit: SearchLimitEvidence;
      readonly evidence: SearchEvidence;
      readonly checkpoint?: PartialRouteCheckpoint;
    }
  | { readonly kind: "stale"; readonly evidence: SearchEvidence }
  | { readonly kind: "cancelled"; readonly evidence: SearchEvidence };
export interface PlanningBudget {
  readonly maximumMilliseconds?: number;
  readonly maximumExpansions?: number;
}

/** A node index that names no node: the root has no parent, and a search may have no goal node yet. */
const NO_NODE = -1;

const PROGRESS_COEFFICIENTS = [1.5, 2, 2.5, 3, 4, 5, 10] as const;
/**
 * How far a partial route must carry the bot before it is worth committing.
 *
 * Baritone's `AbstractNodeCostSearch.MIN_DIST_PATH`, also five. Its `bestSoFar`
 * walks the coefficient family and returns the first node that has travelled
 * this far, giving up entirely rather than hand back a path that barely moves.
 * The lowest-heuristic node is where that matters here: it is regularly one
 * step toward a target it cannot actually reach, and committing to it spends a
 * movement to arrive somewhere no better.
 */
const MINIMUM_PARTIAL_ROUTE_BLOCKS = 5;

interface ProgressSelection {
  readonly node: number;
  readonly selectedBy: PartialRouteCheckpoint["selectedBy"];
  /** Whether the node cleared `MINIMUM_PARTIAL_ROUTE_BLOCKS` of displacement. */
  readonly travelled: boolean;
}

/**
 * The best node seen for one appetite for spending.
 *
 * A node scores `heuristic + cost / coefficient`. A small coefficient charges
 * the cost nearly in full, so the slot holds a node that got nearer the goal
 * cheaply; a large one barely charges it, so the slot holds whatever is
 * nearest the goal at almost any price.
 */
interface Candidate {
  readonly coefficient: number;
  node: number;
  score: number;
}

/**
 * Where the search would walk if it had to stop now.
 *
 * One candidate per coefficient, strict to permissive, plus the nearest node
 * at any price for the diagnostics. Selection prefers the strictest candidate
 * that has actually gone somewhere: at least `MINIMUM_PARTIAL_ROUTE_BLOCKS`
 * from the start. The first time any candidate has, the search has a
 * fallback and stays that way; that is Baritone's `failing` flag turning off,
 * and it is what lets the short primary timeout apply.
 */
class PartialRouteCandidates {
  readonly #store: NodeStore;
  readonly #candidates: readonly Candidate[];
  /** The nearest node seen by heuristic alone, whatever it cost: the limit of the family. */
  #nearest = NO_NODE;
  #nearestHeuristic = Number.POSITIVE_INFINITY;
  /** The best node by the most permissive score, kept even when it never beat the root, so a checkpoint can say how far short it fell. */
  #mostPermissive: { readonly node: number; readonly score: number } | null = null;
  #hasTravelled = false;

  constructor(
    store: NodeStore,
    readonly root: number,
  ) {
    this.#store = store;
    const estimate = store.estimate[root]!;
    this.#candidates = PROGRESS_COEFFICIENTS.map((coefficient) => ({ coefficient, node: root, score: estimate }));
  }

  consider(node: number): void {
    const heuristic = this.#store.heuristic[node]!;
    const cost = this.#store.cost[node]!;
    if (heuristic < this.#nearestHeuristic) {
      this.#nearest = node;
      this.#nearestHeuristic = heuristic;
    }
    const permissiveScore = heuristic + cost / this.#candidates[this.#candidates.length - 1]!.coefficient;
    if (permissiveScore < (this.#mostPermissive?.score ?? Number.POSITIVE_INFINITY)) {
      this.#mostPermissive = { node, score: permissiveScore };
    }
    for (const candidate of this.#candidates) {
      const score = heuristic + cost / candidate.coefficient;
      if (score >= candidate.score) continue;
      candidate.score = score;
      candidate.node = node;
      if (!this.#hasTravelled && this.travelled(node)) this.#hasTravelled = true;
    }
  }

  /** Whether some candidate has ever gone far enough to be worth walking to. */
  get hasTravelled(): boolean {
    return this.#hasTravelled;
  }

  /** Whether the node is at least `MINIMUM_PARTIAL_ROUTE_BLOCKS` from where the search started. */
  travelled(node: number): boolean {
    const from = this.#store.feet(this.root);
    const to = this.#store.feet(node);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    return dx * dx + dy * dy + dz * dz >= MINIMUM_PARTIAL_ROUTE_BLOCKS ** 2;
  }

  /** The goal if reached; else the strictest travelled candidate; else the strictest that moved; else `closest`. */
  select(goal: number, closest: number): ProgressSelection {
    if (goal !== NO_NODE) return { node: goal, selectedBy: "goal", travelled: true };
    const moved = (candidate: Candidate) => this.#store.parent[candidate.node] !== NO_NODE;
    const travelled = this.#candidates.find((candidate) => moved(candidate) && this.travelled(candidate.node));
    if (travelled) return { node: travelled.node, selectedBy: "long_progress", travelled: true };
    const first = this.#candidates.find(moved);
    if (first) return { node: first.node, selectedBy: "progress", travelled: this.travelled(first.node) };
    return { node: closest, selectedBy: "closest", travelled: this.travelled(closest) };
  }

  get nearest(): number {
    return this.#nearest;
  }

  /** The best node by the most permissive score, and the coefficient it was scored with. */
  get mostPermissive(): Candidate | null {
    const seen = this.#mostPermissive;
    return seen && { coefficient: this.#candidates[this.#candidates.length - 1]!.coefficient, ...seen };
  }
}

/** What is true for the whole of one search: what the catalogue needs, and the catalogue itself. */
export interface SearchContext extends GenerationContext {
  readonly catalogue: MovementCatalogue;
}

interface SearchOptions {
  readonly id: string;
  readonly start: PlanningState;
  readonly goal: Extract<ResolvedGoal, { kind: "active" }>;
  readonly context: SearchContext;
  readonly limits?: SearchLimits;
  readonly now?: () => number;
}

/**
 * Where the bot will be standing when it swings, not where it is now.
 *
 * Digging underwater without Aqua Affinity is five times slower and digging
 * mid-air is five times slower again, and the estimator already models both.
 * Hardcoding "dry and grounded" at every call site made the planner price an
 * underwater excavation as if it were on land, so it chose routes it then had
 * to pay far more for.
 */
function digContextAt(options: SearchOptions, state: PlanningState) {
  const { x, y, z } = state.node.feet;
  const head = state.overlay.blockAt(options.context.world, x, y + 1, z);
  const below = state.overlay.blockAt(options.context.world, x, y - 1, z);
  return {
    submergedAtEyes: head.kind === "loaded" && head.traits.liquid === "water",
    onGround: below.kind === "loaded" && !below.traits.empty && below.traits.liquid === null,
    // Mining Fatigue is the dangerous direction: it makes a dig slower than
    // the route priced it, so confirmation windows and progress checks fire on
    // a movement that was always going to take longer.
    aquaAffinity: options.context.player.aquaAffinity,
    effects: options.context.player.effects,
  };
}

/** The nodes from the first step out of the root to `node`, in walking order. */
function routeNodes(store: NodeStore, node: number): readonly number[] {
  const nodes: number[] = [];
  let cursor = node;
  while (store.parent[cursor] !== NO_NODE) {
    nodes.push(cursor);
    cursor = store.parent[cursor]!;
  }
  nodes.reverse();
  return nodes;
}

function reconstructStep(options: SearchOptions, store: NodeStore, node: number): PlannedStep | null {
  const finish = store.finish[node];
  if (finish) return finish.step;
  const parent = store.parent[node]!;
  if (parent === NO_NODE) throw new Error("A route node has no incoming movement.");
  const state = store.state[parent]!;
  const key = store.key[node]!;
  const remaining = store.remaining[node]!;
  const movements = options.context.catalogue.generate(state, options.context, digContextAt(options, state));
  for (let index = 0; index < movements.length; index += 1) {
    if (movements.remainingScaffolds[index] !== remaining) continue;
    if (packKey(movements.toX[index]!, movements.toY[index]!, movements.toZ[index]!) !== key) continue;
    if (!movements.settle(index)) continue;
    return movements.movement(index).step;
  }
  return null;
}

function buildPlan(
  options: SearchOptions,
  store: NodeStore,
  node: number,
  visited: number,
  complete: boolean,
): RoutePlan | null {
  const route = routeNodes(store, node);
  const steps: PlannedStep[] = [];
  let endpoint = route.length > 0 ? store.parent[route[0]!]! : node;
  for (const item of route) {
    const step = reconstructStep(options, store, item);
    // Baritone's Path.postProcess cuts a path at the first movement that
    // became impossible while calculation was running. The executor will
    // replan from this valid prefix instead of trusting stale search state.
    if (step === null) break;
    steps.push(step);
    endpoint = item;
  }
  if (route.length > 0 && steps.length === 0) return null;
  const dependencies = new Set<number>();
  for (const step of steps) {
    for (const condition of step.preconditions) {
      const { x, y, z } = condition.position;
      if (options.context.world.blockAt(x, y, z).kind === "loaded") {
        dependencies.add(blockKey(condition.position));
      }
    }
  }
  const endState = store.state[endpoint]!;
  return Object.freeze({
    id: `${options.id}:route:${visited}`,
    goalRevision: options.goal.revision,
    start: options.start.node.feet,
    end: endState.node.feet,
    endNode: endState.node,
    steps: Object.freeze(steps),
    dependencies,
    totalCost: steps.reduce((total, step) => total + step.cost.total, 0),
    complete: complete && steps.length === route.length,
  });
}

/** What one attempt to cut a partial route yielded. */
type SegmentAttempt =
  | { readonly kind: "segment"; readonly plan: RoutePlan }
  /** A node was worth walking toward, but the movements to it no longer hold in the world. */
  | { readonly kind: "stale" }
  /** Nothing has travelled far enough to be worth walking. */
  | { readonly kind: "none" };

/**
 * Turn a partial-route selection into a committed segment, or refuse it.
 *
 * Baritone gives up rather than hand back a path that barely moves, and the
 * lowest-heuristic node is where that matters here. It is not a member of the
 * coefficient family, and with a target below it is reliably the node one step
 * up the column above that target — a tick of estimate bought with a movement
 * `maximumDrop` will not undo. Collection walked onto a canopy that way and
 * abandoned a drop and half a trunk. A `closest` that has genuinely travelled
 * is still worth committing; one that has not is refused.
 */
function attemptSegment(
  options: SearchOptions,
  store: NodeStore,
  selection: ProgressSelection,
  visited: number,
): SegmentAttempt {
  if (store.parent[selection.node] === NO_NODE) return { kind: "none" };
  if (selection.selectedBy === "closest" && !selection.travelled) return { kind: "none" };
  // Keep the useful endpoint that earned this selection. A fixed prefix can
  // end during a detour's initial retreat, where the next search cheaply walks
  // straight back and repeats the same detour forever.
  const plan = buildPlan(options, store, selection.node, visited, false);
  return plan ? { kind: "segment", plan } : { kind: "stale" };
}

/**
 * One incremental A* search, advanced a slice at a time.
 *
 * Construction seeds the open set with the start state; `advance` expands
 * until the slice's budget is spent or something terminal is known, and
 * reports it as a `SearchUpdate`. The search owns its node store, its open
 * set, its arrival frontier, its progress selector, and its evidence
 * counters, and nothing outside it touches them.
 */
export class IncrementalSearch {
  readonly #options: SearchOptions;
  readonly #now: () => number;
  /** The goal with its heuristic scaled by the policy's weight; nothing reads `options.goal` after construction. */
  readonly #goal: SearchOptions["goal"];
  readonly #store = new NodeStore();
  readonly #open = new OpenSet(this.#store);
  readonly #arrivals = new ArrivalFrontier(this.#store);
  readonly #root: number;
  readonly #candidates: PartialRouteCandidates;
  /** The lowest-estimate node expanded so far, ties to the cheaper route; what a failure points at. */
  #closest: number;
  /** The cheapest goal-satisfying node generated so far, offered first when a partial route is cut. */
  #bestGoal = NO_NODE;
  #visited = 0;
  #generated = 1;
  #slices = 0;
  #computeMs = 0;
  #outsideRadius: number | null = null;
  #cancelled = false;
  /** Set the first time a timeout finds nothing worth walking, so that checkpoint is reported once. */
  #unavailablePartialRouteReported = false;
  /** When the current slice began, and the checkpoint it will report if a timeout found no candidate. */
  #slice: { began: number; checkpoint: PartialRouteCheckpoint | undefined } = { began: 0, checkpoint: undefined };

  constructor(options: SearchOptions) {
    this.#options = options;
    this.#now = options.now ?? performance.now.bind(performance);
    // Goals report ticks, the same unit as costs, so nothing is converted here.
    // They used to report blocks and be scaled by the cheapest per-block edge,
    // which is admissible and far too weak: the cheapest edge is a deep drop at
    // about 2.85 ticks a block while ordinary travel costs four or five, so the
    // estimate under-promised on nearly every real route. Worse, it flattened
    // the axes — ten blocks up scored the same as ten blocks along, when it
    // costs more than twice as much — and `cavern-ore-return` went from 13
    // visited nodes to 6,230 and failed.
    this.#goal = {
      ...options.goal,
      heuristic: (node) => options.goal.heuristic(node) * options.context.policy.heuristicWeight,
    };
    const heuristic = this.#goal.heuristic(options.start.node);
    this.#root = this.#store.add(
      blockKey(options.start.node.feet),
      options.start,
      0,
      heuristic,
      heuristic,
      0,
      NO_NODE,
      null,
    );
    this.#open.push(this.#root);
    this.#arrivals.keep(this.#root);
    this.#closest = this.#root;
    this.#candidates = new PartialRouteCandidates(this.#store, this.#root);
  }

  cancel(): void {
    this.#cancelled = true;
  }

  /** Expand until this slice's budget is spent or something terminal is known. */
  advance(budget: PlanningBudget = {}): SearchUpdate {
    this.#slices += 1;
    this.#slice = { began: this.#now(), checkpoint: undefined };
    const maxMs = budget.maximumMilliseconds ?? 8;
    const maxExpansions = budget.maximumExpansions ?? Number.POSITIVE_INFINITY;
    const store = this.#store;
    let expanded = 0;
    while (this.#open.size && expanded < maxExpansions && this.#now() - this.#slice.began < maxMs) {
      if (this.#cancelled) return { kind: "cancelled", evidence: this.#evidence() };
      const current = this.#open.pop();
      // A queued node that a cheaper arrival has since superseded, or that
      // the scaffold frontier has dominated, is skipped rather than deleted.
      if (store.finish[current] === null && !this.#arrivals.isLive(current)) continue;
      this.#visited += 1;
      expanded += 1;
      this.#noteClosest(current);
      if (
        store.finish[current] ||
        this.#goal.isSatisfied(
          store.state[current]!.node,
          store.state[current]!.overlay.view(this.#options.context.world),
        )
      ) {
        return this.#finish(() => {
          const plan = buildPlan(this.#options, store, current, this.#visited, true);
          if (plan === null) return { kind: "stale", evidence: this.#evidence() };
          return {
            kind: plan.complete ? "complete" : "segment_ready",
            plan,
            evidence: this.#evidence(),
            checkpoint: this.#slice.checkpoint,
          };
        });
      }
      const limit = this.#limitReached();
      if (limit) return limit;
      this.#expand(current);
    }
    return this.#finish(() =>
      this.#open.size
        ? { kind: "progress", evidence: this.#evidence(), checkpoint: this.#slice.checkpoint }
        : this.#exhausted(),
    );
  }

  /** Every exit charges this slice's compute time to the search before the update is built. */
  #finish(build: () => SearchUpdate): SearchUpdate {
    this.#computeMs += this.#now() - this.#slice.began;
    return build();
  }

  #exhausted(): SearchUpdate {
    const maximumRadius = this.#options.limits?.maximumRadius;
    if (maximumRadius !== undefined && this.#outsideRadius !== null) {
      const selection = this.#candidates.select(this.#bestGoal, this.#closest);
      const attempt = attemptSegment(this.#options, this.#store, selection, this.#visited);
      if (attempt.kind === "stale") return { kind: "stale", evidence: this.#evidence() };
      if (attempt.kind === "segment")
        return {
          kind: "segment_ready",
          plan: attempt.plan,
          evidence: this.#evidence(),
          checkpoint: this.#slice.checkpoint,
        };
      return {
        kind: "limit",
        limit: {
          kind: "radius",
          limit: maximumRadius,
          observed: this.#outsideRadius,
          closest: this.#closestEvidence(),
        },
        evidence: this.#evidence(),
      };
    }
    return {
      kind: "no_path",
      closest: this.#closestEvidence(),
      evidence: this.#evidence(),
      checkpoint: this.#slice.checkpoint,
    };
  }

  /**
   * The short budget applies once a segment is worth walking; the long
   * budget applies while nothing is. The radius clips the frontier separately.
   */
  #limitReached(): SearchUpdate | undefined {
    const limits = this.#options.limits;
    if (!limits) return undefined;
    const spent = this.#computeMs + (this.#now() - this.#slice.began);
    const primary = limits.primaryTimeoutMs;
    if (this.#candidates.hasTravelled && primary !== undefined && spent >= primary) {
      const selection = this.#candidates.select(this.#bestGoal, this.#closest);
      const attempt = attemptSegment(this.#options, this.#store, selection, this.#visited);
      if (attempt.kind === "segment") {
        return this.#finish(() => ({
          kind: "segment_ready",
          plan: attempt.plan,
          evidence: this.#evidence(),
          checkpoint: this.#partialRouteCheckpoint(primary, selection, "segment_ready"),
        }));
      }
      if (attempt.kind === "stale") return this.#finish(() => ({ kind: "stale", evidence: this.#evidence() }));
      if (!this.#unavailablePartialRouteReported) {
        this.#unavailablePartialRouteReported = true;
        this.#slice.checkpoint = this.#partialRouteCheckpoint(primary, selection, "no_progress_candidate");
      }
    }
    const failure = limits.failureTimeoutMs;
    if (failure !== undefined && spent >= failure) {
      const selection = this.#candidates.select(this.#bestGoal, this.#closest);
      const attempt = attemptSegment(this.#options, this.#store, selection, this.#visited);
      if (attempt.kind === "stale") return this.#finish(() => ({ kind: "stale", evidence: this.#evidence() }));
      const checkpoint = this.#partialRouteCheckpoint(
        failure,
        selection,
        attempt.kind === "segment" ? "segment_ready" : "no_progress_candidate",
      );
      if (attempt.kind === "segment") {
        return this.#finish(() => ({
          kind: "segment_ready",
          plan: attempt.plan,
          evidence: this.#evidence(),
          checkpoint,
        }));
      }
      return this.#finish(() => ({
        kind: "limit",
        limit: { kind: "search_time", limit: failure, observed: Math.round(spent), closest: this.#closestEvidence() },
        evidence: this.#evidence(),
        checkpoint,
      }));
    }
    return undefined;
  }

  #noteClosest(current: number): void {
    const store = this.#store;
    const closest = this.#closest;
    const heuristic = store.heuristic[current]!;
    const closestHeuristic = store.heuristic[closest]!;
    if (
      heuristic < closestHeuristic ||
      (heuristic === closestHeuristic && store.cost[current]! < store.cost[closest]!)
    ) {
      this.#closest = current;
    }
  }

  /** Clip generated nodes before they can enter either the open set or a partial plan. */
  #withinRadius(x: number, y: number, z: number): boolean {
    const maximum = this.#options.limits?.maximumRadius;
    if (maximum === undefined) return true;
    const start = this.#options.start.node.feet;
    const radius = Math.max(Math.abs(x - start.x), Math.abs(y - start.y), Math.abs(z - start.z));
    if (radius <= maximum) return true;
    this.#outsideRadius = Math.max(this.#outsideRadius ?? 0, radius);
    return false;
  }

  /** Ask the catalogue for every transition out of `current`; queue the ones that improve on a known arrival. */
  #expand(current: number): void {
    const { context } = this.#options;
    const store = this.#store;
    const state = store.state[current]!;
    const depth = store.depth[current]! + 1;
    const digContext = digContextAt(this.#options, state);
    const finish = this.#goal.finish?.(state, context, digContext);
    if (finish && this.#withinRadius(finish.to.x, finish.to.y, finish.to.z)) {
      const cost = store.cost[current]! + finish.cost;
      // A terminal excavation changes the world without changing feet. It
      // competes in the queue, but is not another arrival at that feet cell.
      const terminal = store.add(
        blockKey(finish.to),
        finish.state,
        cost,
        this.#goal.heuristic(finish.state.node),
        cost,
        depth,
        current,
        finish,
      );
      if (this.#bestGoal === NO_NODE || cost < store.cost[this.#bestGoal]!) this.#bestGoal = terminal;
      this.#open.push(terminal);
      this.#generated += 1;
    }
    // The catalogue's rows are read by index, and a movement is only made for
    // a row that improves on a known arrival; about half of them do not.
    const movements = context.catalogue.generate(state, context, digContext);
    for (let index = 0; index < movements.length; index += 1) {
      const x = movements.toX[index]!;
      const y = movements.toY[index]!;
      const z = movements.toZ[index]!;
      if (!this.#withinRadius(x, y, z)) continue;
      const key = packKey(x, y, z);
      const cost = store.cost[current]! + movements.cost[index]!;
      if (this.#arrivals.dominated(key, movements.remainingScaffolds[index]!, cost)) continue;
      // Only now is the row's sight settled: whether its digs can be seen is
      // the dear part of a dig and can only refuse the row, never reprice it,
      // so the rows a known arrival beats are never asked.
      if (!movements.settle(index)) continue;
      this.#generated += 1;
      const arrival = movements.movement(index).state;
      const heuristic = this.#goal.heuristic(arrival.node);
      const node = store.add(key, arrival, cost, heuristic, cost + heuristic, depth, current, null);
      this.#arrivals.keep(node);
      if (
        this.#goal.isSatisfied(arrival.node, arrival.overlay.view(this.#options.context.world)) &&
        (this.#bestGoal === NO_NODE || cost < store.cost[this.#bestGoal]!)
      ) {
        this.#bestGoal = node;
      }
      this.#candidates.consider(node);
      this.#open.push(node);
    }
  }

  #evidence(): SearchEvidence {
    return { queued: this.#open.size, visited: this.#visited, generated: this.#generated, slices: this.#slices, computeMs: this.#computeMs };
  }

  #nodeEvidence(node: number) {
    const store = this.#store;
    return {
      position: store.feet(node),
      heuristic: store.heuristic[node]!,
      routeCost: store.cost[node]!,
      depth: store.depth[node]!,
    };
  }

  #partialRouteCheckpoint(
    threshold: number,
    selection: ProgressSelection,
    outcome: PartialRouteCheckpoint["outcome"],
  ): PartialRouteCheckpoint {
    const nearest = this.#candidates.nearest;
    const permissive = this.#candidates.mostPermissive;
    return {
      threshold,
      outcome,
      selectedBy: selection.selectedBy,
      openNodes: this.#open.size,
      start: this.#nodeEvidence(this.#root),
      closest: this.#nodeEvidence(this.#closest),
      selected: this.#nodeEvidence(selection.node),
      ...(nearest !== NO_NODE && { closestGenerated: this.#nodeEvidence(nearest) }),
      ...(permissive && {
        mostPermissiveProgress: {
          coefficient: permissive.coefficient,
          score: permissive.score,
          requiredBelow: this.#store.estimate[this.#root]!,
          node: this.#nodeEvidence(permissive.node),
        },
      }),
    };
  }

  #closestEvidence(): ClosestNodeEvidence {
    return {
      position: this.#store.feet(this.#closest),
      heuristic: this.#store.heuristic[this.#closest]!,
      routeCost: this.#store.cost[this.#closest]!,
      basis: "best_heuristic_search_node",
    };
  }
}
