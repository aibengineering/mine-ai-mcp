/**
 * The goal constructors: what a route may be asked to satisfy.
 *
 * Every goal here answers two questions about a planning node — is it
 * satisfied, and how many ticks away does it look — and reports a revision
 * string so the run can tell a goal that moved from one that did not. The
 * static goals (exact block, near, near in the plane, occupy) resolve to
 * themselves. `anyGoal` composes several so the nearest wins. The entity goals
 * re-read the entity on every resolution, which is what lets a run follow a
 * dropped item that is still tumbling.
 *
 * Heuristics are priced in ticks per axis, following Baritone, because a
 * block upward costs twice a block sideways; the constants below say why.
 */
import type { GeneratedMovement } from "../movements/catalogue.js";
import { navigationFeet } from "../world/block-geometry.js";
import { withinItemPickupReach } from "../world/item-geometry.js";
import {
  samePosition,
  type BlockPosition,
  type EntityObservation,
  type NavigationObservation,
} from "../world/world.js";
import type { Goal, GoalEndPredicate, PlanningNode, ResolvedGoal } from "./goal.js";
type Distance = (position: BlockPosition) => number;
type Satisfaction = (position: BlockPosition) => boolean;

function staticGoal(name: string, distance: Distance, isSatisfied: Satisfaction): Goal {
  return {
    resolve: () => ({
      kind: "active",
      revision: name,
      heuristic: (node) => distance(node.feet),
      isSatisfied: (node) => isSatisfied(node.feet),
    }),
  };
}

// `Math.sqrt` of a sum of squares rather than `Math.hypot`: hypot guards
// against overflow that block coordinates cannot reach, and it is several
// times slower for it in every engine, on the search's hottest path.
function horizontalDistance(left: BlockPosition, right: BlockPosition): number {
  const dx = left.x - right.x;
  const dz = left.z - right.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/**
 * The cheapest any movement can cover one block along each axis, in ticks.
 *
 * These follow Baritone, whose `GoalBlock.heuristic()` returns cost units
 * scaled by `SPRINT_ONE_BLOCK_COST` so the estimate is priced in the same
 * units as the movements. Ours are the equivalent figures for this policy: a
 * sprint covers a horizontal block in four ticks, a step up climbs one in
 * eight, and a three-block drop descends at three ticks a block.
 *
 * Axis awareness is the point. Blocks are not interchangeable — a block upward
 * costs twice a block sideways — so a scalar Euclidean distance under-promises
 * badly on anything vertical and A* spreads out instead of committing. The
 * repo's own measurement of the alternatives, at 30 blocks: an estimate in
 * blocks visited 1,587 nodes, the same estimate scaled by 3.56 visited 276,
 * and scaled by 4.0 visited 87 — for an identical route cost of 120.0. Scaling
 * into cost units removes search waste rather than trading route quality away.
 *
 * Descent costs more per block than horizontal travel, not less. Baritone's
 * `GoalYLevel.calculate()` charges `FALL_N_BLOCKS_COST[2] / 2` — about four
 * ticks — for every block of descent, against a `SPRINT_ONE_BLOCK_COST` of
 * about 3.56, so falling is the pricier axis by roughly an eighth. Pricing it
 * below horizontal inverts that and makes the column directly above a lower
 * target the cheapest-looking place in the world to stand:
 *
 *     descent 3 / horizontal 4   one across and two down = 10, straight above three down =  9  ← climb
 *     descent 4.5 / horizontal 4 one across and two down = 13, straight above three down = 13.5 ← stay
 *
 * Collection mined a trunk from the top down and followed that inverted
 * gradient one step up onto the canopy for a single tick of estimate, where
 * `maximumDrop` left it with no legal way back down and it abandoned the drop
 * and the rest of the trunk. Hovering over a target is never satisfying — no
 * goal here accepts it — so an estimate that recommends it is simply wrong.
 */
export const HORIZONTAL_TICKS_PER_BLOCK = 4;
export const ASCENT_TICKS_PER_BLOCK = 8;
export const DESCENT_TICKS_PER_BLOCK = 4.5;

/**
 * What reaching within `range` blocks of `to` is estimated to cost, in ticks.
 *
 * The axis components are summed, as Baritone's `GoalBlock` sums `GoalXZ` and
 * `GoalYLevel`. This is deliberately not a strict lower bound: one movement
 * can cover horizontal and vertical displacement at once — a drop travels a
 * block sideways while falling three — so summing charges for both and can
 * exceed the true remaining cost. That makes the search greedy rather than
 * optimal, which is the trade Baritone makes and the one measured above.
 *
 * Do not describe this as bounding route cost to some factor of optimal. That
 * guarantee needs an admissible estimate, and this is not one.
 *
 * Returns zero once the target is already within range. An estimate that stays
 * positive at a node satisfying the goal lets A* defer a destination it has
 * already reached: an earlier version charged the whole vertical delta whatever
 * the remaining distance, so standing two blocks above a target with 4.5 blocks
 * of reach scored twelve while being a perfectly good answer.
 */
function ticksToReach(from: BlockPosition, to: BlockPosition, range = 0): number {
  const distance = spatialDistance(from, to);
  if (distance <= range) return 0;
  // Shrink the displacement by the slack the goal allows before splitting it
  // by axis, so the bound describes reaching the region rather than the point.
  const scale = (distance - range) / distance;
  const ascent = Math.max(0, (to.y - from.y) * scale);
  const descent = Math.max(0, (from.y - to.y) * scale);
  const horizontal = horizontalDistance(to, from) * scale;
  return horizontal * HORIZONTAL_TICKS_PER_BLOCK + ascent * ASCENT_TICKS_PER_BLOCK + descent * DESCENT_TICKS_PER_BLOCK;
}

function spatialDistance(left: BlockPosition, right: BlockPosition): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function targetName(kind: string, target: BlockPosition, range?: number): string {
  const suffix = range === undefined ? "" : `:${range}`;
  return `${kind}:${target.x},${target.y},${target.z}${suffix}`;
}

export function exactBlockGoal(target: BlockPosition): Goal {
  const name = targetName("block", target);
  return staticGoal(
    name,
    (position) => ticksToReach(position, target),
    (position) => spatialDistance(position, target) === 0,
  );
}

export function nearGoal(target: BlockPosition, range: number): Goal {
  const name = targetName("near", target, range);
  return staticGoal(
    name,
    (position) => ticksToReach(position, target, range),
    (position) => spatialDistance(position, target) <= range,
  );
}

export function nearXzGoal(target: Pick<BlockPosition, "x" | "z">, range: number): Goal {
  const point = { x: target.x, y: 0, z: target.z };
  const name = targetName("near-xz", point, range);
  return staticGoal(
    name,
    (position) => Math.max(0, horizontalDistance(position, point) - range) * HORIZONTAL_TICKS_PER_BLOCK,
    (position) => horizontalDistance(position, point) <= range,
  );
}

/**
 * Advance at least `distance` blocks along `heading` from `start`, wherever
 * that lands.
 *
 * A point goal turns exploration into a beeline: a hop target over lava is
 * bridged rather than walked around, and one inside rock spends the whole
 * search budget failing to reach it. Any node past the line counts here, so
 * the cost model decides between a bridge and a detour along the shore, and
 * the estimate — the shortfall to the line at sprint pace — credits every route
 * that gains ground in the requested direction. Progress is measured from the
 * centre of the feet cell, which is where the bot stands once settled.
 */
export function advanceGoal(
  start: Readonly<{ x: number; z: number }>,
  heading: Readonly<{ x: number; z: number }>,
  distance: number,
): Goal {
  const name = `advance:${start.x.toFixed(1)},${start.z.toFixed(1)}>${heading.x.toFixed(3)},${heading.z.toFixed(3)}:${distance}`;
  const advanced = (position: BlockPosition) =>
    (position.x + 0.5 - start.x) * heading.x + (position.z + 0.5 - start.z) * heading.z;
  return staticGoal(
    name,
    (position) => Math.max(0, distance - advanced(position)) * HORIZONTAL_TICKS_PER_BLOCK,
    (position) => advanced(position) >= distance,
  );
}

/**
 * The cells that satisfy standing "at" a target: its own, and the ones below it
 * that put the bot's head or body inside it.
 */
function occupancyCells(target: BlockPosition, levels: number): readonly BlockPosition[] {
  return Array.from({ length: levels }, (_unused, below) => ({ x: target.x, y: target.y - below, z: target.z }));
}

function occupies(position: BlockPosition, target: BlockPosition, levels: number): boolean {
  return position.x === target.x && position.z === target.z && position.y <= target.y && position.y > target.y - levels;
}

/**
 * Stand in the target's own cell, or in one of the cells below it.
 *
 * This is Baritone's `GoalTwoBlocks` and `GoalThreeBlocks`, and it is how
 * Baritone mines. `MineProcess` never asks for a stance beside an ore — it asks
 * to occupy the ore's cell, and the route breaks the block on the way in.
 * Reaching the goal and mining the block are the same act, so there is no
 * separate approach, aim, and swing to keep in agreement.
 *
 * A player is two blocks tall, so standing one below a target already puts its
 * head inside it; `levels` of three is Baritone's vertical-shaft case, where
 * the column below the target is coming out anyway.
 */
export function occupyGoal(target: BlockPosition, levels: 2 | 3): Goal {
  const cells = occupancyCells(target, levels);
  const name = targetName(`occupy-${levels}`, target);
  return staticGoal(
    name,
    (position) => {
      let closest = Number.POSITIVE_INFINITY;
      for (const cell of cells) closest = Math.min(closest, ticksToReach(position, cell));
      return closest;
    },
    (position) => occupies(position, target, levels),
  );
}

/**
 * Satisfied by whichever branch the route reaches first.
 *
 * One stale branch cannot invalidate the goal while another is still usable.
 * Mining item entities disappear independently as they are collected; the
 * remaining live entities are still valid destinations.
 */
export function anyGoal(goals: readonly Goal[]): Goal {
  return {
    resolve(observation) {
      const resolved = goals.map((goal) => goal.resolve(observation));
      const invalid = resolved.find((candidate) => candidate.kind === "invalid");
      const active = resolved.filter(
        (candidate): candidate is Extract<ResolvedGoal, { kind: "active" }> => candidate.kind === "active",
      );
      if (invalid?.kind === "invalid" && active.length === 0) return invalid;
      const revision = `any(${active.map((candidate) => candidate.revision).join("|")})`;
      return {
        kind: "active",
        revision,
        heuristic: (node) => {
          let closest = Number.POSITIVE_INFINITY;
          for (const candidate of active) closest = Math.min(closest, candidate.heuristic(node));
          return closest;
        },
        isSatisfied: (node, world) => active.some((candidate) => candidate.isSatisfied(node, world)),
        ...(active.some((candidate) => candidate.finish) &&
          ({
            finish: (state, context, digContext) => {
              let cheapest: GeneratedMovement | null = null;
              for (const candidate of active) {
                const finish = candidate.finish?.(state, context, digContext);
                if (finish && (cheapest === null || finish.cost < cheapest.cost)) cheapest = finish;
              }
              return cheapest;
            },
          } satisfies Partial<Extract<ResolvedGoal, { kind: "active" }>>)),
      };
    },
  };
}

export function customGoal(
  revision: string,
  isSatisfied: GoalEndPredicate,
  heuristic: (node: PlanningNode, observation: NavigationObservation) => number = () => 0,
): Goal {
  return {
    resolve(observation) {
      return {
        kind: "active",
        revision,
        heuristic: (node) => heuristic(node, observation),
        isSatisfied: (node) => isSatisfied(node, observation),
      };
    },
  };
}

export interface EntityReference {
  readonly id: number;
}

/** An entity's id and cell: the goal toward it changes only when the entity crosses a cell boundary. */
function entityRevision(entity: Pick<EntityObservation, "id" | "position">): string {
  const cell = `${Math.floor(entity.position.x)},${Math.floor(entity.position.y)},${Math.floor(entity.position.z)}`;
  return `entity:${entity.id}:${cell}`;
}

/** Reach an actual body position within range of a live entity, planning other cells at their centres. */
export function nearEntityGoal(entity: EntityReference, range: number): Goal {
  return {
    resolve(observation) {
      const target = observation.entities.get(entity.id);
      if (!target) return { kind: "invalid", observation: `Entity ${entity.id} is not currently observed.` };
      const current = navigationFeet(observation.position, observation.stance === "supported");
      const positionAt = (feet: BlockPosition) =>
        samePosition(feet, current) ? observation.position : { x: feet.x + 0.5, y: feet.y, z: feet.z + 0.5 };
      const distanceAt = (feet: BlockPosition) => {
        const position = positionAt(feet);
        return Math.hypot(
          position.x - target.position.x,
          position.y - target.position.y,
          position.z - target.position.z,
        );
      };
      return {
        kind: "active",
        // The current cell is judged at the actual body position, so an already
        // satisfied coarse cell cannot repeatedly return outside the requested range.
        revision: `near:${range}:entity:${entity.id}:${target.position.x},${target.position.y},${target.position.z}:${current.x},${current.y},${current.z}:${distanceAt(current) <= range}`,
        isSatisfied: (node) => distanceAt(node.feet) <= range,
        // Contact is three-dimensional; its estimate must credit climbing too.
        // A horizontal-only estimate is zero beneath a surface mob in a cave,
        // so even a useful ascent cannot qualify as partial-route progress.
        heuristic: (node) => ticksToReach(positionAt(node.feet), target.position, range),
      };
    },
  };
}

/**
 * Reach a stance at least `range` from every supplied threat, using its current
 * position when observed and the caller's last observation otherwise.
 *
 * Unlike composing inverted near-entity goals, this gives A* a gradient: the
 * largest remaining distance shortfall. Entity positions are re-read whenever
 * the goal is resolved, so an approaching threat revises the active route.
 * If an entity disappears, separation is still owed from its last observation.
 * The caller removes confirmed-dead threats; absence alone does not establish safety.
 */
export function safeFromEntitiesGoal(
  entities: readonly Pick<EntityObservation, "id" | "position">[],
  range: number,
): Goal {
  if (range < 0 || !Number.isFinite(range))
    throw new RangeError("Safe entity range must be a finite non-negative number.");
  const known = [...new Map(entities.map((entity) => [entity.id, entity])).values()].sort((a, b) => a.id - b.id);
  return {
    resolve(observation) {
      const threats = known.map((lastSeen) => observation.entities.get(lastSeen.id) ?? lastSeen);
      const revision = `safe-from:${range}:${threats.map(entityRevision).join("|")}`;
      const shortfall = (position: BlockPosition): number => {
        let largest = 0;
        for (const threat of threats) {
          largest = Math.max(largest, range - spatialDistance(position, threat.position));
        }
        return Math.max(0, largest);
      };
      return {
        kind: "active",
        revision,
        heuristic: (node) => shortfall(node.feet) * HORIZONTAL_TICKS_PER_BLOCK,
        isSatisfied: (node) => shortfall(node.feet) === 0,
      };
    },
  };
}

/**
 * Stand where the server will hand over a live dropped item.
 *
 * Plan toward the item's cell or the one below it. If the actual body already
 * overlaps pickup reach, stop moving and let the collection process observe
 * inventory. Planning into a chest beneath an already reachable drop broke
 * the chest; enlarging every planned arrival cell instead stalled a coal run
 * with the body still outside pickup reach.
 */
export function itemPickupGoal(entity: EntityReference): Goal {
  return {
    resolve(observation) {
      const target = observation.entities.get(entity.id);
      if (!target) return { kind: "invalid", observation: `Entity ${entity.id} is not currently observed.` };
      const cell = {
        x: Math.floor(target.position.x),
        y: Math.floor(target.position.y),
        z: Math.floor(target.position.z),
      };
      // Already overlapping vanilla's pickup box: wait for the inventory
      // packet instead of routing into the item's column and breaking a chest
      // beneath it. Use the actual body position, not the centre of its node;
      // extending every node's arrival range left a coal run just out of reach.
      const touching = withinItemPickupReach(observation.position, target);
      return {
        kind: "active",
        revision: `item:${entityRevision(target)}:${touching}`,
        heuristic: (node) =>
          touching ? 0 : Math.min(...occupancyCells(cell, 2).map((level) => ticksToReach(node.feet, level))),
        isSatisfied: (node) => touching || occupies(node.feet, cell, 2),
      };
    },
  };
}
