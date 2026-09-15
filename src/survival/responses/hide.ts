import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { centerOnCell, steeringPortFor } from "../../navigation/index.js";
import { selectHarvestTool } from "../../navigation/mineflayer/movement-policy.js";
import { navigationFeet } from "../../navigation/world/block-geometry.js";
import { cellIntersectsBody } from "../../utils/geometry.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { findPlacementSupport, type WorldBlock } from "../../world/index.js";
import type { ResponseContext } from "../control/combat/context.js";
import { recoveryAvailable } from "../perception/combat/recovery.js";
import { isThreat } from "../perception/combat/threats.js";
import { permitsHide, permittedCombatItems } from "../policy/combat/permissions.js";
import { buildProtection, fullProtectionBlock } from "../positioning/combat/build-protection.js";
import { countCapBlocks } from "../positioning/combat/hide-blocks.js";
import { PROTECTION_SIDES, protectionShell } from "../positioning/combat/planner.js";
import { equipCombatLoadout, selectMeleeLoadout } from "../weapons/equipment.js";
import { CombatItemUse } from "../weapons/item-use.js";
import { canMeleeTarget, combatItemsForTarget, hasSweepBystander } from "../weapons/melee.js";
import { shieldFacing } from "../weapons/shield-facing.js";
import { recoverUnderCover, type CoveredRecovery } from "./recover.js";

function shelterFeet(bot: Bot): Vec3 {
  const cell = navigationFeet(bot.entity.position, bot.entity.onGround);
  return new Vec3(cell.x, cell.y, cell.z);
}

type Entity = Parameters<Bot["attack"]>[0];

/** How far down the bot digs: three cells put its head below anything that walks, and out of a skeleton's line. */
export const HIDE_DEPTH = 3;
/**
 * Blocks for walling in where the bot stands: four sides at feet height, four
 * at head height, an eave, and the cap. With that many carried the ring is
 * built instead of the shaft; with fewer, the shaft is dug and the ring is
 * the fallback for ground that will not take one.
 */
export const WALL_IN_BLOCKS = 10;
const SIDES = PROTECTION_SIDES;
/** Existing observed-fall budget: a descent must reach a grounded position before construction continues. */
const DESCENT_TICKS = 20;
/** A mob this close is in the shaft with the bot, and the only fight left is the one at arm's length. */
const SHAFT_REACH = 2;

interface HideEvidence {
  readonly recovery: CoveredRecovery | null;
  /** `recovered` or `held` only inside a closed shelter; `failed` when the shelter could not be completed. */

  readonly dug: number;
  /** Blocks placed around the bot: cover toward the threats, and the ring when the ground could not be dug. */
  readonly walled: number;
  /** Whether this hide placed the block over the bot's head. */
  readonly capped: boolean;
  /** The bot was already in a closed cell, so nothing was dug or placed and nothing needed to be. */
  readonly enclosed: boolean;
  readonly ate: string | null;
  /** Swings at authorized threats occupying the body or shelter shell. */
  readonly swings: number;
  readonly healthAfter: number;
  readonly hungerAfter: number;
}

type HideConclusion =
  | {
      readonly kind: "recovered";
      readonly recovery: Extract<CoveredRecovery, { kind: "recovered" }>;
      readonly error?: never;
    }
  | { readonly kind: "held" | "failed"; readonly error: string };
export type HideResult = HideEvidence & HideConclusion;

export interface HideOptions {
  readonly signal: AbortSignal;
  readonly threatContext: ResponseContext;
  /** Health at which the hole has done its job and the body is handed back. */
  readonly recoverTo: number;
  readonly maximumMs: number;
  /** Restrict both carried materials and existing cover for destructive hazards. */
  readonly blockNames?: readonly string[];
  /** The response owner can invalidate construction and recovery as its hazard changes. */
  readonly unsafe?: () => string | null;
  /** Healing alone must not hand the body back into an ongoing attack. */
  readonly holdWhile?: () => boolean;
  /** Establish this side first when the caller knows the direction of knockback. */
  readonly firstWallDirection?: Vec3;
}

function solid(block: WorldBlock | null): block is WorldBlock {
  return block?.boundingBox === "block";
}

function diggable(block: WorldBlock | null): block is WorldBlock {
  return solid(block) && block.name !== "bedrock" && block.hardness !== null && block.hardness >= 0;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The cells that make a closed box around a bot standing at `feet`: four sides at each level, and the cap. */
function shell(feet: Vec3): readonly Vec3[] {
  return protectionShell(feet, [feet]);
}

export function enclosedInPlace(bot: Bot, blockNames?: readonly string[]): boolean {
  return shell(shelterFeet(bot)).every((cell) => {
    const block = bot.blockAt(cell);
    return fullProtectionBlock(block) && (!blockNames || blockNames.includes(block!.name));
  });
}

/** An authorized threat occupying the body or shelter shell; never chase beyond construction space. */
function shelterIntruder(bot: Bot, context: ResponseContext): Entity | null {
  for (const id in bot.entities) {
    const entity = bot.entities[id];
    // Multipart dragon contact belongs to the End owner, not shaft melee.
    if (entity?.name === "ender_dragon") continue;
    if (!isThreat(bot, entity, context)) continue;
    const delta = entity.position.minus(bot.entity.position);
    const feet = shelterFeet(bot);
    if (
      delta.y >= -1 &&
      delta.y <= SHAFT_REACH &&
      [feet, feet.offset(0, 1, 0), ...shell(feet)].some((cell) => cellIntersectsBody(cell, entity))
    )
      return entity;
  }
  return null;
}

/** The four sides, the one facing the nearest hostile first, so cover goes up where the arrows come from. */
function sidesByThreat(bot: Bot, context: ResponseContext): readonly Vec3[] {
  let nearest: Entity | null = null;
  for (const id in bot.entities) {
    const entity = bot.entities[id];
    if (!isThreat(bot, entity, context)) continue;
    if (
      !nearest ||
      entity.position.distanceTo(bot.entity.position) < nearest.position.distanceTo(bot.entity.position)
    ) {
      nearest = entity;
    }
  }
  if (!nearest) return SIDES;
  const toward = nearest.position.minus(bot.entity.position);
  return [...SIDES].sort((left, right) => right.dot(toward) - left.dot(toward));
}

/**
 * Dig in, or wall in, then eat and wait for health.
 *
 * The first playthrough died six times the same way: the evade could not
 * reach safe separation from three or more mobs in open ground, and the pack
 * finished the bot in the seconds after. A hole is what a player does with
 * two hearts left. Head-height blocks go up toward the nearest threats first,
 * as cover for what follows; then the shaft, each dig checked for solid
 * ground under the next so it never opens into a cave, capped once it has
 * walls; and when the ground will not take a shaft, the ring is finished
 * where the bot stands, with an eave so the cap has something to hold. No
 * placement is allowed to abort the hide: a refused block is a block skipped.
 *
 * A bot already standing in a closed cell is hidden and goes straight to the
 * hold. Without that, every successful hide guaranteed a failing one thirty
 * seconds later: each side already solid, nothing to place, and the runtime
 * reporting its safety net broken from inside a working shelter.
 */
export async function hideInPlace(bot: Bot, options: HideOptions): Promise<HideResult> {
  const { signal, threatContext } = options;
  const policy = threatContext.policy;
  const waitForTicks = (ticks: number) => waitForPhysicsTicks(bot, ticks, signal);
  const holdGuard = async (ticks: number) => {
    for (let tick = 0; tick < ticks; tick++) {
      signal.throwIfAborted();
      const intruder = shelterIntruder(bot, threatContext);
      if (intruder) await bot.lookAt(shieldFacing(bot, intruder, threatContext.resolvedIds), true);
      await waitForTicks(1);
    }
  };
  const itemUse = new CombatItemUse(bot, holdGuard);
  using _releaseGuard = { [Symbol.dispose]: () => itemUse.lowerShield() };
  const centerShelterCell = async (cell: Vec3): Promise<boolean> => {
    const interrupted = new AbortController();
    const observe = () => {
      if (shelterIntruder(bot, threatContext)) interrupted.abort();
    };
    bot.on("physicsTick", observe);
    try {
      return await centerOnCell(
        {
          ...steeringPortFor(bot, (control, state) => bot.setControlState(control, state)),
          waitForTick: () => waitForTicks(1),
        },
        cell,
        AbortSignal.any([signal, interrupted.signal]),
      );
    } catch (cause) {
      signal.throwIfAborted();
      if (!interrupted.signal.aborted) throw cause;
      return false;
    } finally {
      bot.off("physicsTick", observe);
    }
  };
  bot.clearControlStates();
  bot.deactivateItem();
  const enclosed = enclosedInPlace(bot, options.blockNames);
  const blocks = () => countCapBlocks(bot, options.blockNames);
  const unsafe = () => options.unsafe?.() ?? null;
  const constructionDeadline = Date.now() + options.maximumMs;
  let dug = 0;
  let walled = 0;
  let capped = false;
  let ate: string | null = null;
  let swings = 0;
  let recovery: CoveredRecovery | null = null;
  /** Why the first placement that could have closed the box did not, for the record. */
  let refusal: string | null = null;
  const done = (conclusion: HideConclusion): HideResult => ({
    recovery,
    dug,
    walled,
    capped,
    enclosed,
    ate,
    swings,
    healthAfter: bot.health,
    hungerAfter: bot.food,
    ...conclusion,
  });

  /**
   * Put a carried block into `cell` against any solid neighbour; false when it
   * cannot, never a throw.
   *
   * The first refusal is kept rather than dropped. On 2026-09-04 a hide on
   * ordinary ground placed nothing while carrying forty-seven blocks, and the
   * record said only that nothing could be placed, which names no cause. A
   * cell that is already solid is the box being finished, not a refusal.
   */
  const seal = async (cell: Vec3): Promise<boolean> => {
    try {
      if (!policy.terrain.place) {
        refusal ??= "Combat placement prohibited by policy";
        return false;
      }
      itemUse.lowerShield();
      const built = await buildProtection(bot, [cell], {
        signal, mayContinue: unsafe, terrain: policy.terrain, blockNames: options.blockNames,
      });
      if (built.kind === "blocked") refusal ??= `${cell.x},${cell.y},${cell.z}: ${built.reason}`;
      return built.placed.length > 0;
    } catch (cause) {
      signal.throwIfAborted();
      refusal ??= `${cell.x},${cell.y},${cell.z}: ${message(cause)}`;
      return false;
    }
  };

  const repelIntruder = async (intruder: Entity): Promise<void> => {
    signal.throwIfAborted();
    if (!policy.melee) throw new Error("[COMBAT_CONSTRAINED] Shelter contact defence requires prohibited melee.");
    const loadout = selectMeleeLoadout(permittedCombatItems(combatItemsForTarget(bot, intruder), policy));
    const changedWeapon = bot.heldItem?.name !== loadout.weapon?.name;
    await equipCombatLoadout(bot, loadout);
    signal.throwIfAborted();
    if (changedWeapon || !bot.usingHeldItem) itemUse.invalidateShield();
    if (loadout.shield) await itemUse.raiseShield();
    if (changedWeapon) await holdGuard(loadout.cooldownTicks);
    await bot.lookAt(intruder.position.offset(0, intruder.height / 2, 0), true);
    signal.throwIfAborted();
    if (
      !isThreat(bot, intruder, threatContext) ||
      shelterIntruder(bot, threatContext)?.id !== intruder.id ||
      !canMeleeTarget(bot, intruder)
    )
      return;
    if (bot.heldItem?.name.endsWith("_sword") && hasSweepBystander(bot, intruder)) return;
    bot.attack(intruder);
    swings += 1;
    if (loadout.shield) itemUse.activateShield();
    await holdGuard(loadout.cooldownTicks);
  };

  const constructionChanged = (origin: Vec3): boolean =>
    !bot.entity.onGround ||
    !shelterFeet(bot).equals(origin) ||
    (blocks() > 0 &&
      (Math.abs(bot.entity.position.x - origin.x - 0.5) + bot.entity.width / 2 > 0.5 ||
        Math.abs(bot.entity.position.z - origin.z - 0.5) + bot.entity.width / 2 > 0.5)) ||
    shelterIntruder(bot, threatContext) !== null;

  construction: while (!enclosed) {
    signal.throwIfAborted();
    const hazard = unsafe();
    if (hazard) return done({ kind: "failed", error: hazard });
    if (!permitsHide(policy, recoveryAvailable(bot, threatContext.food)))
      return done({ kind: "failed", error: "[COMBAT_CONSTRAINED] Hiding is no longer permitted." });
    const intruder = shelterIntruder(bot, threatContext);
    if (intruder) {
      await repelIntruder(intruder);
      continue;
    }
    // Knockback can change both the occupied cell and its floor. Pick the
    // construction origin only after the body has landed, then recheck it.
    if (!bot.entity.onGround) {
      await waitForTicks(1);
      continue;
    }
    let descended = 0;
    const sides = options.firstWallDirection
      ? [...SIDES].sort((a, b) => b.dot(options.firstWallDirection!) - a.dot(options.firstWallDirection!))
      : sidesByThreat(bot, threatContext);
    // With blocks enough for the whole box, the ring goes up instead of the
    // shaft: ten placements close it in under three seconds and each blocks a
    // direction as it lands, while three digs leave the head exposed for
    // longer than a walking pack needs to cross twelve blocks.
    const wallFirst = blocks() >= WALL_IN_BLOCKS || walled > 0 || capped;
    for (let step = 0; step < HIDE_DEPTH && !wallFirst && policy.terrain.dig; step += 1) {
      signal.throwIfAborted();
      const standing = shelterFeet(bot);
      const below = bot.blockAt(standing.offset(0, -1, 0));
      const under = bot.blockAt(standing.offset(0, -2, 0));
      if (!diggable(below) || !solid(under)) break;
      const centered = await centerShelterCell(standing);
      if (shelterIntruder(bot, threatContext)) continue construction;
      if (!centered) return done({ kind: "failed", error: "The bot could not centre over the shelter shaft" });
      const tool = selectHarvestTool(bot, below);
      itemUse.lowerShield();
      if (tool && bot.heldItem?.name !== tool.name) await bot.equip(tool, "hand");
      signal.throwIfAborted();
      if (constructionChanged(standing)) continue construction;
      try {
        await bot.dig(below, true);
      } catch {
        signal.throwIfAborted();
        break;
      }
      const landedBelow = () => bot.entity.onGround && bot.entity.position.y <= standing.y - 0.5;
      for (let waited = 0; waited < DESCENT_TICKS && !landedBelow(); waited += 1) {
        await waitForTicks(1);
      }
      dug += 1;
      descended += 1;
      if (!landedBelow()) {
        return done({
          kind: "failed",
          error: `Dug at ${below.position}, but the bot did not land below the shaft opening`,
        });
      }
    }

    const feet = shelterFeet(bot);
    if (descended === 0) {
      // A body straddling a cell edge occupies the wall's destination. The
      // server refuses that block even though the target itself is air.
      const floor = bot.blockAt(feet.offset(0, -1, 0));
      const supportedCenter = floor?.shapes.some(
        ([minX, , minZ, maxX, maxY, maxZ]) =>
          minX <= 0.5 &&
          maxX >= 0.5 &&
          minZ <= 0.5 &&
          maxZ >= 0.5 &&
          Math.abs(feet.y - 1 + maxY - bot.entity.position.y) < 0.001,
      );
      if (blocks() > 0 && !supportedCenter) {
        return done({ kind: "failed", error: "The shelter cell has no solid floor to centre on" });
      }
      const centered = blocks() === 0 || (await centerShelterCell(feet));
      if (!bot.entity.onGround || !shelterFeet(bot).equals(feet) || shelterIntruder(bot, threatContext))
        continue construction;
      if (!centered) return done({ kind: "failed", error: "The bot could not centre inside the shelter walls" });
      if (constructionChanged(feet)) continue construction;
      // The ring where the bot stands, the side facing the nearest threat
      // first. Feet height before head height on each side: the head block has
      // nothing to be placed against until the one beneath it exists, which is
      // how a first version raised half a ring and no roof.
      for (const side of sides) {
        const lower = feet.plus(side);
        signal.throwIfAborted();
        if (constructionChanged(feet)) continue construction;
        // Over a drop the wall cell has no neighbour to hold it, but the
        // block the bot stands on has a free side face there. Extend the
        // floor by one block first and build the side up from it. On
        // 2026-09-07 a fortress-bridge hide refused its first wall for this
        // reason, stood down, and the bot was knocked off the walkway.
        if (!solid(bot.blockAt(lower)) && !findPlacementSupport(bot, lower)) {
          if (await seal(lower.offset(0, -1, 0))) walled += 1;
        }
        for (const level of [0, 1]) {
          signal.throwIfAborted();
          if (constructionChanged(feet)) continue construction;
          if (await seal(lower.offset(0, level, 0))) walled += 1;
        }
        // Close upward knockback as soon as the first wall can support a cap.
        // Waiting for all four walls left the last eave inside an approaching
        // dragon before the roof existed. This is still the same ten-block box.
        if (!capped && solid(bot.blockAt(lower.offset(0, 1, 0)))) {
          if (constructionChanged(feet)) continue construction;
          if (await seal(lower.offset(0, 2, 0))) walled += 1;
          if (constructionChanged(feet)) continue construction;
          capped = await seal(feet.offset(0, 2, 0));
        }
      }
    }
    if (descended >= 2 || walled > 0) {
      // In a shaft the cap rests against the shaft's walls. Above ground the
      // cell over the head touches nothing solid, so one eave goes on top of a
      // head-height wall first and the cap is placed against its side.
      const cap = feet.offset(0, 2, 0);
      if (descended < 2) {
        for (const side of sides) {
          signal.throwIfAborted();
          if (constructionChanged(feet)) continue construction;
          const eave = cap.plus(side);
          if (solid(bot.blockAt(eave))) break;
          if (await seal(eave)) {
            walled += 1;
            break;
          }
        }
      }
      if (constructionChanged(feet)) continue construction;
      capped = (await seal(cap)) || capped;
      if (descended === 0 && solid(bot.blockAt(cap))) {
        // Over a drop, the floor cannot support the first wall block. The
        // finished roof can: extend its eave, then build that side downward.
        for (const side of sides) {
          if (constructionChanged(feet)) continue construction;
          const lower = feet.plus(side);
          const upper = lower.offset(0, 1, 0);
          if (solid(bot.blockAt(lower)) && solid(bot.blockAt(upper))) continue;
          signal.throwIfAborted();
          if (!solid(bot.blockAt(upper)) && !findPlacementSupport(bot, upper)) {
            if (await seal(cap.plus(side))) walled += 1;
          }
          if (constructionChanged(feet)) continue construction;
          if (!solid(bot.blockAt(upper)) && (await seal(upper))) walled += 1;
          if (constructionChanged(feet)) continue construction;
          if (!solid(bot.blockAt(lower)) && (await seal(lower))) walled += 1;
        }
      }
    }
    if (descended === 0 && walled === 0 && !capped) {
      return done({
        kind: "failed",
        error: refusal
          ? `Nothing below the bot could be dug, and the first placement was refused at ${refusal}`
          : "Nothing below the bot could be dug and no block could be placed around it",
      });
    }
    // A flying body can temporarily occupy the last wall cell. Keep the
    // observed partial shell and retry after a tick within the same attempt,
    // instead of opening it to escape or digging a new shaft underneath it.
    if (options.holdWhile && (walled > 0 || capped) && !enclosedInPlace(bot, options.blockNames) &&
      unsafe() === null && Date.now() < constructionDeadline) {
      await waitForTicks(1);
      continue construction;
    }
    break;
  }

  if (!enclosedInPlace(bot, options.blockNames)) {
    return done({ kind: "failed", error: `The shelter is still open${refusal ? `: ${refusal}` : ""}` });
  }

  itemUse.lowerShield();
  recovery = await recoverUnderCover(bot, {
    signal,
    recoverTo: options.recoverTo,
    maximumMs: options.maximumMs,
    survival: threatContext.survival,
    policy: () => ({ combat: threatContext.policy, food: threatContext.food }),
    isProtected: () => enclosedInPlace(bot, options.blockNames) && unsafe() === null,
    holdWhile: options.holdWhile,
    defendIntruder: async () => {
      const intruder = shelterIntruder(bot, threatContext);
      if (intruder) await repelIntruder(intruder);
    },
    releaseItemUse: () => itemUse.lowerShield(),
    wait: waitForTicks,
  });
  ate = recovery.ate;
  switch (recovery.kind) {
    case "exposed":
      return done({ kind: "failed", error: "The shelter became exposed or unsafe during recovery." });
    case "held":
      return done({ kind: "held", error: recovery.reason });
    case "recovered":
      return done({ kind: "recovered", recovery });
  }
}
