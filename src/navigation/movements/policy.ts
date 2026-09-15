/**
 * Movement policy: is this transition allowed, and what does it cost?
 *
 * Policy answers about one candidate. It does not enumerate neighbours and it
 * does not press controls.
 */
import type { BlockObservation, BlockPosition, WorldView } from "../world/world.js";
import type { MovementKind } from "./movement.js";
import type { DiveAdmission } from "../world/swimming.js";

export interface ToolSelection {
  readonly itemType: number | null;
  readonly expectedTicks: number;
}

export interface BreakEvaluation {
  readonly decision: PolicyDecision;
  readonly tool: ToolSelection;
}

export interface DigContext {
  readonly submergedAtEyes: boolean;
  readonly onGround: boolean;
  readonly aquaAffinity: boolean;
  readonly effects: Readonly<Record<string, number>>;
}

export interface DigTimeEstimator {
  estimate(block: BlockObservation, tool: ToolSelection, context: DigContext): number;
}

export type PolicyDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "prohibited"; readonly reason: string; readonly cause?: "opens_into_liquid" }
  | { readonly kind: "penalized"; readonly reason: string; readonly cost: number };

/**
 * The one prohibition that answers a route break and not a target break.
 *
 * Baritone's `avoidBreaking` refuses any break that would let liquid into the
 * route, and that stays: a route opening a wall into lava while walking is the
 * failure the rule exists to prevent. A *target* break asks a different
 * question — can the process make this break safe, then make it — and the
 * process seals the cell first. Naming the reason is how the two are told
 * apart without re-deriving the neighbourhood.
 */
export const BREAK_OPENS_INTO_LIQUID = "breaking this block would open the route into liquid";

export interface ScaffoldSelection {
  readonly stateId: number;
  readonly itemType: number;
  /**
   * For a block with an axis, the state each placement face produces: the
   * server aligns basalt with the face it is placed against, so a bridge block
   * set against the last one is axis x, not the default axis y. A route that
   * expected the default state failed its confirmation on every basalt.
   */
  readonly stateIdByAxis?: Readonly<Record<"x" | "y" | "z", number>>;
}

export interface MovementPolicy {
  /** Scoped open-water admission, supplied by the navigation runtime. */
  readonly dive?: DiveAdmission;
  readonly allowDigging: boolean;
  readonly allowPlacing: boolean;
  readonly allowDoors: boolean;
  readonly allowSwimming: boolean;
  readonly allowClimbing: boolean;
  readonly allowParkour: boolean;
  readonly allowDiagonalAscend: boolean;
  readonly allowSprinting: boolean;
  readonly allowDownward: boolean;
  readonly maximumDrop: number;
  readonly maximumBucketDrop?: number;
  /** The block a route places, or null. A run reads it once per search, so a live selection still plans one block per route. */
  readonly scaffold: ScaffoldSelection | null;
  readonly placementPenalty: number;
  readonly movementTicks: Readonly<Record<MovementKind, number>>;
  /**
   * An extra multiplier on the goal estimate, for tuning search aggression.
   *
   * One is the shipped setting and the one every measurement is taken under.
   * Goals already report in tick units, following Baritone, so the directing
   * work is done before this is applied and a value above one is purely
   * additional greediness.
   *
   * This does not bound route cost to a factor of optimal, and must not be
   * described as though it does: that guarantee requires an admissible
   * estimate, and the goal estimate sums its axis components, which one
   * movement can satisfy together.
   *
   * Kept as a knob because search aggression is worth being able to measure
   * separately from the cost model. Formerly this held 2.85, which was not a
   * tuning choice at all but the residue of a unit conversion — the search
   * used to multiply block-valued estimates by the cheapest per-block edge,
   * a nine-tick three-block drop over 3.162 blocks. Once goals report ticks
   * there is nothing left to convert.
   */
  readonly heuristicWeight: number;
  readonly digTimeEstimator: DigTimeEstimator;
  /** Whether this block may be broken at this cell, given its neighbours in `world`, and with what. */
  evaluateBreak(block: BlockObservation, position: BlockPosition, world: WorldView): BreakEvaluation;
  /**
   * The two halves of `evaluateBreak`, for a caller that prices many breaks
   * and keeps few: what the block settles on its own, refused or priced with
   * its tool, and then the rules that read around the cell, which can only
   * refuse. The price is exact, so search compares candidates on it and asks
   * `confirmBreak` only of the digs it keeps. A policy that answers in one
   * step supplies `evaluateBreak` alone: it is then the price, and there is
   * nothing left to confirm.
   */
  priceBreak(block: BlockObservation, x: number, y: number, z: number, world: WorldView): BreakEvaluation;
  confirmBreak(block: BlockObservation, position: BlockPosition, world: WorldView): PolicyDecision;
  /** Whether the route may stand in this cell, and at what penalty. */
  decideStep(x: number, y: number, z: number, world: WorldView): PolicyDecision;
  /** Optional hazard check for the actual transition, such as a jump through an overhead cloud. */
  decideMovement?(kind: MovementKind, from: BlockPosition, to: BlockPosition): PolicyDecision;
  /** Whether the route may place a scaffold in this cell, and at what penalty. */
  decidePlace(x: number, y: number, z: number, world: WorldView): PolicyDecision;
}

const DEFAULT_TICKS: Readonly<Record<MovementKind, number>> = Object.freeze({
  walk: 5,
  sprint: 4,
  step_up: 8,
  pillar: 12,
  jump: 12,
  // Continuous walking is faster than recovering from the observed
  // three-block sprint overshoot. Keep sprint jumps for gaps where they add
  // reach, but do not prefer them over supported ground.
  sprint_jump: 16,
  // Four blocks of sprint gap, above sprint_jump's three.
  parkour: 20,
  downward: 6,
  drop: 6,
  bucket_drop: 46,
  swim: 10,
  climb: 10,
});

const NO_TOOL: ToolSelection = { itemType: null, expectedTicks: 20 };
const ALLOWED: PolicyDecision = { kind: "allowed" };

export function createMovementPolicy(overrides: Partial<MovementPolicy> = {}): MovementPolicy {
  // One answer or two: a policy that supplies only `evaluateBreak` prices
  // with it and confirms nothing; one that supplies the halves has them
  // composed, the cell's refusal carrying the tool the price chose.
  const oneStep = overrides.evaluateBreak;
  const priceBreak =
    overrides.priceBreak ??
    (oneStep &&
      ((block: BlockObservation, x: number, y: number, z: number, world: WorldView) =>
        oneStep(block, { x, y, z }, world)));
  const confirmBreak = overrides.confirmBreak ?? (() => ALLOWED);
  const evaluateBreak =
    oneStep ??
    (priceBreak &&
      ((block: BlockObservation, position: BlockPosition, world: WorldView): BreakEvaluation => {
        const priced = priceBreak(block, position.x, position.y, position.z, world);
        if (priced.decision.kind === "prohibited") return priced;
        const confirmed = confirmBreak(block, position, world);
        return confirmed.kind === "prohibited" ? { decision: confirmed, tool: priced.tool } : priced;
      }));
  const base: MovementPolicy = {
    allowDigging: true,
    // Keep this on. Every placement is already gated on `remainingScaffolds`,
    // which callers recount from the live inventory on each observation, so an
    // empty bot generates no placement edges anyway. Switching it off instead
    // removes bridging and pillaring for the whole run, and the planner's only
    // remaining way up is to mine a staircase — which is why a bot that could
    // pillar home is sometimes seen excavating one instead.
    allowPlacing: true,
    allowDoors: true,
    allowSwimming: true,
    allowClimbing: true,
    // Intentional product difference from Baritone: parkour is useful enough
    // to ship enabled, while still remaining one coherent capability switch.
    allowParkour: true,
    // Intentional product difference from Baritone's conservative default:
    // the movement is useful, its swept volume is validated by the catalogue,
    // and dedicated physical fixtures qualify both valid and blocked rises.
    allowDiagonalAscend: true,
    allowSprinting: true,
    allowDownward: true,
    maximumDrop: 3,
    scaffold: null,
    placementPenalty: 8,
    movementTicks: DEFAULT_TICKS,
    // Goals already price themselves in ticks, so nothing needs scaling here.
    heuristicWeight: 1,
    // Vanilla's multipliers: five times slower submerged without Aqua
    // Affinity, and five times slower again with no ground underfoot.
    digTimeEstimator: {
      estimate: (_block, tool, context) => {
        const waterPenalty = context.submergedAtEyes && !context.aquaAffinity ? 5 : 1;
        const airbornePenalty = context.onGround ? 1 : 5;
        return tool.expectedTicks * waterPenalty * airbornePenalty;
      },
    },
    evaluateBreak: (block) => ({
      decision:
        block.kind === "loaded" && block.traits.safeToBreak
          ? ALLOWED
          : { kind: "prohibited", reason: "block is not safe to break" },
      tool: NO_TOOL,
    }),
    priceBreak: (block, x, y, z, world) => base.evaluateBreak(block, { x, y, z }, world),
    confirmBreak: () => ALLOWED,
    decideStep: () => ALLOWED,
    decidePlace: () => ALLOWED,
  };

  return Object.freeze({
    ...base,
    ...overrides,
    ...(evaluateBreak && priceBreak ? { evaluateBreak, priceBreak, confirmBreak } : {}),
    movementTicks: Object.freeze({ ...DEFAULT_TICKS, ...overrides.movementTicks }),
  });
}
