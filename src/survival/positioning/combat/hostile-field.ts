/**
 * What a hostile costs a route that passes near it.
 *
 * Not arriving is the cheapest way to not fight. The route is priced on
 * terrain alone, so it will walk within arm's reach of a mob that has not
 * noticed the bot and hand the outcome to the contact reflex; on 2026-09-04 it
 * routed past two piglins it had no reason to engage. This prices the band
 * around a hostile so the search prefers to go around, and it prices it as a
 * cost rather than a prohibition: a zombie in the only doorway must not make
 * the room unreachable, and a rule that switches off as the mob steps aside
 * makes the route oscillate.
 *
 * Navigation never learns any of this. It takes a `StepField`, a number per
 * cell, and the classification stays here where the threat predicate and the
 * live attacker set already are.
 */
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { packKey, TERRAIN_BREAK_PENALTY, type StepField, type StepFieldProvider } from "../../../navigation/index.js";
import { observedEyeHeight, type BlockRaycaster } from "../../../world/block-visibility.js";
import { entityDimensions } from "../../../world/entity-dimensions.js";
import { exposedBodyFrom, type EntityBody } from "../../../world/entity-geometry.js";
import type { HostileContext } from "../../control/combat/context.js";
import {
  HOSTILE_CONTACT_RANGE,
  HOSTILE_OBSERVATION_RANGE,
  shouldAvoidEntity,
} from "../../perception/combat/threats.js";
import type { HostileResponse } from "../../policy/combat/response.js";
import type { NavigationPolicy } from "../../policy/contract.js";

/** How far one species is worth avoiding, and by how much at its own cell. */
interface Avoidance {
  /** Beyond this the entity contributes nothing. */
  readonly radius: number;
  /** Ticks added to the entity's own cell, falling off linearly to zero at `radius`. */
  readonly penalty: number;
  /**
   * Whether a second one of these is a second fight rather than the same fight.
   *
   * Species where arriving is already the loss, so a group is worth more than
   * the dearest member of it and the proximity cap is allowed to rise with
   * the count. Ranged mobs are deliberately not severe: the cap exists partly
   * because proximity cannot test line of sight, and a wall of skeletons
   * behind rock must not price a route none of them can shoot.
   */
  readonly severe?: boolean;
}

/**
 * Anything unlisted: melee, slow enough to leave, and survivable if it does
 * arrive. Priced at the contact boundary, which is the distance the reflex
 * already treats as "this is now happening".
 */
const DEFAULT_AVOIDANCE: Avoidance = { radius: HOSTILE_CONTACT_RANGE, penalty: 20 };

/**
 * How far a hostile picks the bot up and starts coming, in vanilla's own
 * terms: the follow range most hostiles carry.
 */
const ACQUISITION_RANGE = 16;
/**
 * How far past acquisition the field keeps pricing, so the gradient still has
 * slope where the mob decides to engage.
 *
 * A radius equal to acquisition would be worth nothing at the only distance
 * that matters: the falloff is linear to zero at the radius, so the cell where
 * the mob wakes up is the cell the field has stopped charging for. Priced at
 * twelve against a brute's sixteen, the cheapest route the search believed was
 * safe was one that walked into acquisition range for free, and on 2026-09-13
 * a live run died to the bastion that answered. A margin of one contact range
 * puts real cost across the boundary without moving the peak.
 */
const ACQUISITION_MARGIN = HOSTILE_CONTACT_RANGE;
/** Priced from outside the range in which the mob chooses to start the fight. */
const AVOID_BEFORE_ACQUISITION = ACQUISITION_RANGE + ACQUISITION_MARGIN;

/**
 * What each species costs a route, anchored to the ranges the combat policy
 * already keeps rather than a second vocabulary of distances.
 *
 * Costs here are ticks, the same unit as everything else the search prices:
 * sprinting is four per block and a broken block about twenty-five, so a
 * penalty of 20 at a zombie's cell buys a five-block detour, and four cells
 * priced at ten apiece are worth digging one block to avoid.
 *
 * Radius follows what the mob does about the bot rather than what it does to
 * it: a species whose arrival decides the fight is priced from outside the
 * range in which it takes that decision, and one worth walking away from is
 * priced from the contact boundary.
 */
const AVOIDANCE_BY_SPECIES: ReadonlyMap<string, Avoidance> = new Map([
  // The only one whose mistake is unrecoverable.
  ["creeper", { radius: AVOID_BEFORE_ACQUISITION, penalty: 50, severe: true }],
  // Ignores gold and hits through iron. Thirteen damage a swing on normal,
  // fifty health, and knockback resistance that denies the spacing melee
  // relies on, so the fight is lost at the point it is accepted.
  ["piglin_brute", { radius: AVOID_BEFORE_ACQUISITION, penalty: 50, severe: true }],
  // Hits for eight and leaves a wither drain that separation does not stop;
  // priced like a brute, since a route past one at zombie prices ended in
  // death nineteen at a fortress edge.
  ["wither_skeleton", { radius: AVOID_BEFORE_ACQUISITION, penalty: 50, severe: true }],
  // Ranged: distance is the whole defence, so the field reaches past the
  // distance from which the first arrow comes.
  //
  // Blazes and ghasts acquire far beyond this - a ghast picks a target four
  // times out - but cover is what answers them, not separation, and a field
  // that priced their true reach would blanket the Nether and block routes
  // rather than bend them. They are knowingly priced short.
  ["skeleton", { radius: AVOID_BEFORE_ACQUISITION, penalty: 30 }],
  ["blaze", { radius: AVOID_BEFORE_ACQUISITION, penalty: 30 }],
  ["ghast", { radius: AVOID_BEFORE_ACQUISITION, penalty: 30 }],
  // Melee, slow, survivable: acquisition is not the loss, arrival is, so these
  // keep the contact boundary rather than the wider acquisition radius. A
  // zombie's own follow range is more than twice a brute's, and pricing that
  // would put a cost on most of the map for a mob worth walking away from.
  ["zombie", DEFAULT_AVOIDANCE],
  ["husk", DEFAULT_AVOIDANCE],
  // Melee, fast, individually weak.
  ["spider", { radius: HOSTILE_CONTACT_RANGE, penalty: 15 }],
  ["magma_cube", { radius: HOSTILE_CONTACT_RANGE, penalty: 15 }],
  ["slime", { radius: HOSTILE_CONTACT_RANGE, penalty: 15 }],
]);

/**
 * The base proximity cap before the survival policy multiplier: two terrain
 * breaks, per severe hostile reaching the cell.
 *
 * This bounds the two ways a summed field makes the bot stupid - a pack
 * stacking to an absurd number, and a skeleton behind a cave wall pricing a
 * route it cannot shoot, since proximity does not test line of sight.
 *
 * A flat cap answered both, and erased the one thing a bastion says that a
 * single brute does not. A brute at its own cell contributes exactly the cap
 * by itself, so under a flat bound twelve of them priced a cell identically to
 * one, and the route that walked into the bastion cost what the route past a
 * lone straggler cost. The cap now rises with the number of severe hostiles
 * actually reaching the cell, which is the count that cannot be answered by
 * distance or by a wall: a group of mobs that each win the fight on arrival is
 * worth more detour than the dearest one of them.
 *
 * It rises with the count rather than with the sum so that it stays a cap: a
 * cell is never worth more than a bounded number of dug blocks, and the route
 * bends rather than treating the ground as impassable.
 */
export const HOSTILE_AVOIDANCE_CAP = 2 * TERRAIN_BREAK_PENALTY;
/**
 * How many severe hostiles at one cell still raise the cap.
 *
 * Past a few, the answer stopped being a route: a cell with three brutes
 * reaching it is already worth six dug blocks of detour, and a bastion that
 * priced every further brute would wall off ground the search must still be
 * able to cross to leave.
 */
export const SEVERE_AVOIDANCE_STACK = 3;

/**
 * What a cell the hostile can see costs a bot under the hide bar: twenty
 * terrain breaks, on top of the proximity price.
 *
 * Below `HOSTILE_HIDE_HEALTH` the reflex treats a hostile in sight as contact
 * and answers with a hide, which cancels the route under it. Proximity alone
 * cannot see that coming: on 2026-09-09 a withdrawing bot at two health was
 * walled in seven times in ten minutes, because every resumed route's first
 * step out of the box was back in the sight line of a zombie eleven blocks
 * off, on a ledge it could not leave, that proximity priced at nothing. So
 * under that bar the field prices sight itself, with the same test the reflex
 * uses, from a body standing in the cell to the hostile, read from the live
 * world beyond the body's own cells - a cell inside a planned tunnel has rock
 * on every side, so it stays unseen, which is what makes tunnelling out the
 * cheaper route.
 *
 * Twenty breaks per exposed cell is what makes a hidden way out win: digging
 * down out of a box and along under a cavern floor is a few dozen breaks,
 * and being seen for the few steps that saves is a hide every time. It stays
 * a cost, not a prohibition: a bot with no unseen route still gets a route,
 * and the reflex still answers what happens on it.
 */
export const HIDE_EXPOSURE_PENALTY = 20 * TERRAIN_BREAK_PENALTY;

/** One hostile as the field sees it: where it stands, in blocks, what it costs, and the body a sight line would meet. */
interface FieldThreat {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly radius: number;
  readonly penalty: number;
  /** Whether this one raises the proximity cap for the cells it reaches. */
  readonly severe: boolean;
  readonly body: EntityBody;
}

/** How exposure is judged while the bot is under the hide bar; null while it is not. */
interface Sight {
  readonly world: BlockRaycaster;
  /** The bot's own eye height, which is where a standing body sees from. */
  readonly eyeHeight: number;
}

/**
 * Where in a cell the bot's eye may be: the centre and the four corners.
 *
 * A body sprinting through a cell is anywhere in it, not at its centre, and
 * the reflex judges sight from wherever the eye actually is. The first route
 * priced by this field crept along the edge of its own box's shadow, judged
 * unseen at every cell centre, and was walled in the moment the bot's eye
 * cleared the box by half a block. A cell counts as seen if any of the five
 * can see the hostile.
 */
const EYE_SAMPLES: readonly (readonly [number, number])[] = [
  [0.5, 0.5],
  [0.05, 0.05],
  [0.95, 0.05],
  [0.05, 0.95],
  [0.95, 0.95],
];

/** How far past the body's own cells a sight line starts, so its first block is the neighbour. */
const BEYOND_BODY = 1e-3;

/**
 * Where a ray from inside the bot's two cells leaves them.
 *
 * The body box is the feet cell and the head cell above it. Every term is
 * positive for a point inside, so the smallest is the face the ray exits by.
 */
function bodyExit(from: Vec3, direction: Vec3, x: number, y: number, z: number): number {
  let exit = Number.POSITIVE_INFINITY;
  const axis = (position: number, step: number, min: number, max: number) => {
    if (step > 0) exit = Math.min(exit, (max - position) / step);
    else if (step < 0) exit = Math.min(exit, (min - position) / step);
  };
  axis(from.x, direction.x, x, x + 1);
  axis(from.y, direction.y, y, y + 2);
  axis(from.z, direction.z, z, z + 1);
  return exit;
}

/**
 * The world as seen from a body standing in a cell: sight lines begin where
 * they leave the body's own two cells.
 *
 * The field reads the live world, in which a cell the route means to dig is
 * still rock, and a ray started inside rock ends there. That hid the first
 * priced route's mistake: it dug into the side of a staircase in plain view of
 * the cavern, and the field, starting each ray inside the very block the
 * route would remove, judged the cell unseen. The bot's own cells never block
 * its sight, dug or not; what stands beyond them does, so a cell walled in by
 * rock on every side is still unseen and a cell opened to a cavern is not.
 */
function beyondBody(world: BlockRaycaster, x: number, y: number, z: number): BlockRaycaster {
  return {
    raycast(from, direction, range) {
      const exit = bodyExit(from, direction, x, y, z) + BEYOND_BODY;
      if (exit >= range) return null;
      return world.raycast(from.plus(direction.scaled(exit)), direction, range - exit);
    },
  };
}

/**
 * The frozen snapshot: a distance test and an add per threat, per cell.
 *
 * The search calls this once per candidate cell, tens of thousands of times,
 * which is the only reason its cost is worth a sentence. A snapshot holds a
 * handful of entries and each is a few multiplications. If a benchmark ever
 * shows the loop costing search throughput the known answer is to stamp the
 * field into a map once per snapshot; that is not built until it is asked for.
 *
 * Sight is the one dear question, a handful of rays per threat, so it is
 * asked only under the hide bar, only for cells inside observation range of a
 * threat, and once per cell for the life of the snapshot.
 */
function fieldOver(threats: readonly FieldThreat[], sight: Sight | null, multiplier: number): StepField {
  const seen = new Map<number, boolean>();
  const exposedAt = (x: number, y: number, z: number, from: Sight): boolean => {
    const key = packKey(x, y, z);
    let exposed = seen.get(key);
    if (exposed === undefined) {
      const world = beyondBody(from.world, x, y, z);
      exposed = threats.some((threat) => {
        const dx = x - threat.x;
        const dy = y - threat.y;
        const dz = z - threat.z;
        return (
          dx * dx + dy * dy + dz * dz < HOSTILE_OBSERVATION_RANGE * HOSTILE_OBSERVATION_RANGE &&
          EYE_SAMPLES.some(([ox, oz]) =>
            exposedBodyFrom(world, new Vec3(x + ox, y + from.eyeHeight, z + oz), threat.body),
          )
        );
      });
      seen.set(key, exposed);
    }
    return exposed;
  };
  return {
    costAt: (x, y, z) => {
      let total = 0;
      // Counted here rather than once per snapshot so the cap answers what
      // reaches this cell: a brute across the valley must not raise the price
      // of the ground beside an unrelated zombie.
      let severe = 0;
      for (const threat of threats) {
        const dx = x - threat.x;
        const dy = y - threat.y;
        const dz = z - threat.z;
        // Distance is 3D: a hostile ten blocks below does not price the cell
        // overhead, and a route through a ceiling is not a route past a mob.
        const squared = dx * dx + dy * dy + dz * dz;
        if (squared >= threat.radius * threat.radius) continue;
        // Linear falloff, not a cliff. A hard edge only moves the brush-past
        // one cell further out; a gradient bends the route away smoothly and
        // takes the far side of a corridor without being told to.
        total += threat.penalty * (1 - Math.sqrt(squared) / threat.radius);
        if (threat.severe) severe += 1;
      }
      const cap = HOSTILE_AVOIDANCE_CAP * Math.min(Math.max(severe, 1), SEVERE_AVOIDANCE_STACK);
      const proximity = Math.min(total, cap) * multiplier;
      // Exposure sits outside the proximity cap: the cap exists because
      // proximity cannot test sight, and this term does.
      return sight && exposedAt(x, y, z, sight) ? proximity + HIDE_EXPOSURE_PENALTY : proximity;
    },
    // Which hostiles, and which blocks they stand in. Positions are rounded to
    // blocks because the cost is, so a mob shuffling inside one cell does not
    // invent a new search out of a field that answers identically. Whether
    // sight is priced and the policy multiplier are part of the identity too.
    fingerprint:
      threats.map((threat) => `${threat.id}@${threat.x},${threat.y},${threat.z}`).join(";") +
      `|avoidance:${multiplier}` + (sight ? "|sight" : ""),
  };
}

/**
 * The provider the session registers on the navigation runtime.
 *
 * `context` is the reflex's own live threat state, held rather than copied: the
 * attacker set is what makes an unprovoked piglin free to walk past and a
 * provoked one worth avoiding, and it changes between searches.
 *
 * A snapshot with nothing in it is `null`, which is the common answer and
 * leaves the search exactly as it was before this existed.
 */
export function createHostileStepFieldProvider(
  bot: Bot,
  context: HostileContext & { readonly policy: import("../../policy/combat/contract.js").CombatPolicy },
  activeResponse: () => HostileResponse["kind"] | null,
  navigationPolicy: () => Readonly<NavigationPolicy>,
): StepFieldProvider {
  return () => {
    const threats: FieldThreat[] = [];
    for (const id in bot.entities) {
      const entity = bot.entities[id];
      if (!shouldAvoidEntity(bot, entity, context)) continue;
      const avoidance = AVOIDANCE_BY_SPECIES.get(entity.name ?? "") ?? DEFAULT_AVOIDANCE;
      threats.push({
        id: entity.id,
        x: Math.floor(entity.position.x),
        y: Math.floor(entity.position.y),
        z: Math.floor(entity.position.z),
        radius: avoidance.radius,
        penalty: avoidance.penalty,
        severe: avoidance.severe === true,
        body: { position: entity.position.clone(), ...entityDimensions(bot, entity) },
      });
    }
    if (threats.length === 0) return null;
    // Sorted so the fingerprint says what the field is, not what order the
    // entity table happened to be in.
    threats.sort((left, right) => left.id - right.id);
    // Exposure predicts a new hide interrupting ordinary navigation. An
    // admitted response already owns that decision: an escape must not stop
    // to excavate concealment just because health drops while separating.
    const sight: Sight | null =
      activeResponse() === null && bot.health < context.policy.critical_health
        ? { world: bot.world, eyeHeight: observedEyeHeight(bot.entity) }
        : null;
    return fieldOver(threats, sight, navigationPolicy().hostile_avoidance_multiplier);
  };
}
