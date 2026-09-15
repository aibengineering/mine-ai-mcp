import { huntCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { createMovements, type NavigationResult, type NavigationRuntime } from "../../navigation/index.js";
import {
  hunt,
  type EngagementOutcome,
  type HuntRequest,
  type HuntResult,
} from "../../navigation/processes/hunting/hunt-process.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import type { ObserveRequest } from "../../session/request.js";
import {
  HOSTILE_CONTACT_RANGE,
  isHostileSpecies,
  type CombatController,
  type CombatOutcome,
  type CombatStyle,
} from "../../survival/index.js";
import { Budgets } from "../../survival/state/budgets.js";
import { readCombatItems } from "../../survival/weapons/equipment.js";
import { waitForSignal, type Position3 } from "../../utils/index.js";
import { createDiscardedItems, type DiscardedItems } from "../../world/discarded-items.js";
import { hasInventorySpaceFor } from "../../world/inventory-capacity.js";
import {
  DROPPED_ITEM_OBSERVATION_EVENTS,
  findNewItemEntity,
  pickupObservedItem,
  snapshotEntityIds,
  type ObservedItemEntity,
} from "../../world/item-pickup.js";
import { defineAction, type ActionContext } from "../action.js";
import {
  huntMobAnnotations,
  huntMobOutcomes,
  parseHuntMobRequest,
  COLLECT_MOB_DROP,
  COLLECT_MOB_DROP_DESCRIPTION,
  huntMobInputSchema,
  huntMobResultSchema,
  type HuntEvidence,
  type HuntTargetSighting,
  type HuntTermination,
  type HuntMobRequest,
  type HuntMobResult,
} from "./contract.js";
import { observeHuntDrops } from "./drop-accounting.js";
import { collectionTargetSafetyTier, compareCollectionTargets } from "./target-selection.js";
import { closestLoadedSpawner, SpawnerCamp, spawnerCampGoal } from "./spawner-camp.js";

type Entity = Parameters<Bot["attack"]>[0];

/** A normal entity drop appears immediately; this allows ordinary server delay and late metadata. */
const HUNT_DROP_OBSERVATION_MS = 1_000;
/** How far from the death the sweep looks for the kill's other drops; knockback leaves them within a few blocks. */
const HUNT_SWEEP_RADIUS = 4;
/** How many items besides the requested drop one kill is worth walking for. */
const HUNT_SWEEP_LIMIT = 4;

export interface TargetEngagement {
  readonly outcome: CombatOutcome;
  /** Where the target was when the server announced its death; null unless the outcome is `died`. */
  readonly deathPosition: Position3 | null;
}

export interface HuntDrop {
  readonly name: string;
  readonly id: number;
}

/** What the hunt decides about a pursuit; the walk and the movement policy belong to navigation. */
export type HuntPursuit = Omit<HuntRequest, "route" | "movements">;

export interface HuntMobDependencies {
  readonly createCamp: (waitMs: number) => SpawnerCamp;
  readonly finish: (signal: AbortSignal) => ReturnType<CombatController["finish"]>;
  /**
   * Target selection and the walk to the chosen mob, bound to the runtime's
   * navigation. The hunt owns which mobs count and what happens in contact
   * range; getting there is the navigation process's job.
   */
  readonly pursue: (pursuit: HuntPursuit) => Promise<HuntResult>;
  readonly engageTarget: (target: Entity, context: ActionContext) => Promise<TargetEngagement>;
  readonly collectDropAfterDeath: (
    observation: HuntDropObservation,
    context: ActionContext,
  ) => Promise<HuntDropCollection>;
  readonly sweepDropsAfterDeath: (observation: HuntSweepObservation, context: ActionContext) => Promise<number>;
  readonly gatherLoadedDrops: (drop: HuntDrop, context: ActionContext) => Promise<number>;
  /** Whether the combat policy permits raising a shield at all, which carrying one does not settle. */
  readonly shieldPermitted: () => boolean;
}

export function huntMobDependencies(
  bot: Bot,
  navigation: NavigationRuntime,
  combat: CombatController,
  discarded: DiscardedItems = createDiscardedItems(),
): HuntMobDependencies {
  return {
    createCamp: (waitMs) =>
      new SpawnerCamp(bot, closestLoadedSpawner(bot), waitMs, async (position, signal) => {
        const admitted = combat.policy.combat.terrain;
        const changed = new AbortController();
        let pending: Promise<NavigationResult> | null = null;
        const remove = combat.policy.onChange(async ({ effective: { combat: effective } }) => {
          if (effective.terrain.dig === admitted.dig && effective.terrain.place === admitted.place) return;
          changed.abort("Spawner return terrain permissions changed.");
          await pending?.catch(() => {});
        });
        try {
          pending = navigation.navigate({
            goal: spawnerCampGoal(position),
            movements: createMovements(bot, { allowDigging: admitted.dig, scaffolding: admitted.place }),
            signal,
            stopSignal: changed.signal,
          });
          return await pending;
        } finally {
          remove();
        }
      }),
    finish: (signal) => combat.finish(signal),
    shieldPermitted: () => combat.policy.combat.shield,
    pursue: async (pursuit) => {
      const admitted = combat.policy.combat;
      if (!admitted.melee && !admitted.bow)
        return {
          status: "capability_blocked",
          reason: "[COMBAT_CONSTRAINED] No attack method is permitted for the requested quarry.",
        };
      const stop = new AbortController();
      let pending: Promise<HuntResult> | null = null;
      const remove = combat.policy.onChange(async ({ effective: { combat: effective } }) => {
        if (
          effective.terrain.dig === admitted.terrain.dig &&
          effective.terrain.place === admitted.terrain.place &&
          (effective.melee || effective.bow)
        )
          return;
        stop.abort("Combat approach permissions changed.");
        await pending?.catch(() => {});
      });
      try {
        pending = hunt(bot, {
          ...pursuit,
          signal: AbortSignal.any([stop.signal, ...(pursuit.signal ? [pursuit.signal] : [])]),
          movements: createMovements(bot, {
            allowSprinting: true,
            allowDigging: admitted.terrain.dig,
            scaffolding: admitted.terrain.place,
          }),
          route: navigation.navigate,
          preflight: (target) => pursuit.preflight?.(target) ?? combat.resourceRefusal(target, admitted),
        });
        return await pending;
      } finally {
        remove();
      }
    },
    engageTarget: (target, context) => engageTarget(bot, combat, target, context),
    collectDropAfterDeath: (observation, context) =>
      collectDropAfterDeath(bot, navigation, observation, context, discarded),
    sweepDropsAfterDeath: (observation, context) =>
      sweepDropsAfterDeath(bot, navigation, observation, context, discarded),
    gatherLoadedDrops: (drop, context) => gatherLoadedDrops(bot, navigation, drop, context, discarded),
  };
}

function positionOf(entity: Entity): Position3 {
  return { x: entity.position.x, y: entity.position.y, z: entity.position.z };
}

/**
 * Fight one selected entity through the combat controller, noting where it died.
 *
 * The controller owns the mechanics - its thirty-two block detour approach, the
 * shield toward a volley, the species tactics - so a hunted blaze is fought the
 * way the reflex would fight it. It is handed a target already in contact
 * range, because the walk there belongs to the pursuit. The hunt adds only what
 * the controller does not report: where the target was when it died, which is
 * where its drops are.
 */
export async function engageTarget(
  bot: Bot,
  combat: CombatController,
  target: Entity,
  context: ActionContext,
): Promise<TargetEngagement> {
  let deathPosition: Position3 | null = null;
  const onDeath = (entity: Entity) => {
    if (entity.id === target.id) deathPosition = positionOf(entity);
  };
  bot.on("entityDead", onDeath);
  try {
    const signal = context.signal ?? new AbortController().signal;
    const targetId = target.id;
    const outcome = await combat.engage(targetId, signal, "pursue");
    return { outcome, deathPosition: outcome.kind === "died" ? (deathPosition ?? positionOf(target)) : null };
  } finally {
    bot.removeListener("entityDead", onDeath);
  }
}

export type HuntDropCollection =
  | { readonly kind: "collected" }
  | { readonly kind: "inventory_full"; readonly reason: string }
  | { readonly kind: "not_observed" }
  | { readonly kind: "item_gone" }
  | { readonly kind: "not_collected"; readonly route: NavigationResult };

export interface HuntSweepObservation {
  readonly entityBaseline: ReadonlySet<number>;
  readonly deathPosition: Position3;
}

export interface HuntDropObservation extends HuntSweepObservation {
  readonly dropName: string;
  readonly dropId: number;
  readonly inventoryBefore: number;
}

/** Attribute one requested item to this death, then delegate live pursuit and pickup. */
export async function collectDropAfterDeath(
  bot: Bot,
  navigation: NavigationRuntime,
  observation: HuntDropObservation,
  context: ActionContext,
  discarded: DiscardedItems,
): Promise<HuntDropCollection> {
  const hasArrived = () => bot.inventory.count(observation.dropId, null) > observation.inventoryBefore;
  const sighting = await waitForSignal(
    () => {
      if (hasArrived()) return { kind: "collected" as const };
      // Any new item of the requested name is this kill's drop, wherever it
      // landed: an enderman teleports on the killing blow and dies tens of
      // blocks away, and a four-block bound left four pearls on the ground.
      // The window stays short, so a kill that drops nothing costs a second.
      const entity = findNewItemEntity(bot, {
        baseline: observation.entityBaseline,
        itemName: observation.dropName,
        source: observation.deathPosition,
        maxDistance: Number.POSITIVE_INFINITY,
        ignoreIds: discarded.ignored(),
      });
      return entity ? { kind: "entity" as const, entity } : null;
    },
    [bot, bot.inventory],
    [...DROPPED_ITEM_OBSERVATION_EVENTS, "updateSlot"],
    { timeoutMs: HUNT_DROP_OBSERVATION_MS, context },
  );
  if (!sighting) return { kind: "not_observed" };
  if (sighting.kind === "collected") return sighting;

  return pickupObservedItem(bot, {
    entityId: sighting.entity.id,
    movements: createMovements(bot),
    navigate: navigation.navigate,
    hasArrived,
    signal: context.signal,
  });
}

function carriedItemCount(bot: Bot): number {
  return bot.inventory.items().reduce((total, item) => total + item.count, 0);
}

/**
 * Pick up whatever else the kill dropped near where it died.
 *
 * A kill is worth its whole drop, not only the item the hunt was asked for: a
 * skeleton's bones and arrows, a zombie's iron. Each item is one pickup walk
 * with the inventory's total count as the arrival proof, and the sweep stops
 * at the first route that fails rather than turning a hunt into a search.
 */
export async function sweepDropsAfterDeath(
  bot: Bot,
  navigation: NavigationRuntime,
  observation: HuntSweepObservation,
  context: ActionContext,
  discarded: DiscardedItems,
): Promise<number> {
  const attempted = new Set(observation.entityBaseline);
  const nextItem = (): ObservedItemEntity | null =>
    findNewItemEntity(bot, {
      baseline: attempted,
      source: observation.deathPosition,
      maxDistance: HUNT_SWEEP_RADIUS,
      ignoreIds: discarded.ignored(),
    });
  let collected = 0;
  // The first item may still be arriving from the server; the rest are already there or not at all.
  let item = await waitForSignal(nextItem, [bot], [...DROPPED_ITEM_OBSERVATION_EVENTS], {
    timeoutMs: HUNT_DROP_OBSERVATION_MS,
    context,
  });
  while (item && collected < HUNT_SWEEP_LIMIT) {
    context.signal?.throwIfAborted();
    attempted.add(item.id);
    const before = carriedItemCount(bot);
    const pickup = await pickupObservedItem(bot, {
      entityId: item.id,
      movements: createMovements(bot),
      navigate: navigation.navigate,
      hasArrived: () => carriedItemCount(bot) > before,
      signal: context.signal,
    });
    if (pickup.kind === "collected") collected += 1;
    if (pickup.kind === "not_collected" || pickup.kind === "inventory_full") break;
    item = nextItem();
  }
  return collected;
}

/**
 * Pick up requested drops already lying near the bot before any fight.
 *
 * A hunt resumed after the reflex killed the same species finds that kill's
 * drops on the ground with no death of its own to attribute them to, and a
 * hunt asked for again after being stopped finds its own. Each is one pickup
 * walk with the requested item's count as the arrival proof.
 */
export async function gatherLoadedDrops(
  bot: Bot,
  navigation: NavigationRuntime,
  drop: HuntDrop,
  context: ActionContext,
  discarded: DiscardedItems,
): Promise<number> {
  const attempted = new Set<number>();
  let collected = 0;
  while (collected < HUNT_SWEEP_LIMIT) {
    context.signal?.throwIfAborted();
    const item = findNewItemEntity(bot, {
      baseline: attempted,
      itemName: drop.name,
      source: bot.entity.position,
      // The hunt pursues loaded mobs without a radius; their requested drops
      // deserve the same reach, including a reflex kill on another ledge.
      maxDistance: Number.POSITIVE_INFINITY,
      ignoreIds: discarded.ignored(),
    });
    if (!item) return collected;
    attempted.add(item.id);
    const before = bot.inventory.count(drop.id, null);
    const pickup = await pickupObservedItem(bot, {
      entityId: item.id,
      movements: createMovements(bot),
      navigate: navigation.navigate,
      hasArrived: () => bot.inventory.count(drop.id, null) > before,
      signal: context.signal,
    });
    if (pickup.kind === "collected") collected += 1;
    if (pickup.kind === "not_collected" || pickup.kind === "inventory_full") return collected;
  }
  return collected;
}

interface HuntObservation {
  stopReason: HuntTermination;
  readonly drops: ReturnType<typeof observeHuntDrops>;
  readonly mob: string;
  readonly drop: string;
  readonly requested: number;
  readonly inventoryBefore: number;
  inventoryAfter: number;
  targetsEngaged: number;
  selectedTargetId: number | null;
  readonly targetChanges: HuntEvidence["targetChanges"];
  targetDeathsObserved: number;
  attacks: number;
  readonly combatStyles: Set<CombatStyle>;
  projectileGuards: number;
  otherDropsCollected: number;
  /** The matching mobs the client holds right now, nearest first. */
  readonly loadedTargets: () => HuntTargetSighting[];
}

function huntEvidence(observation: HuntObservation): HuntEvidence {
  return {
    mob: observation.mob,
    drop: observation.drop,
    requested: observation.requested,
    inventoryBefore: observation.inventoryBefore,
    inventoryAfter: observation.inventoryAfter,
    gained: Math.max(0, observation.inventoryAfter - observation.inventoryBefore),
    targetsEngaged: observation.targetsEngaged,
    retargets: observation.targetChanges.length,
    targetChanges: [...observation.targetChanges],
    targetDeathsObserved: observation.targetDeathsObserved,
    attacks: observation.attacks,
    combatStyles: [...observation.combatStyles],
    projectileGuards: observation.projectileGuards,
    otherDropsCollected: observation.otherDropsCollected,
    targets: observation.loadedTargets(),
    // Only what is still lying there is something the caller can go and pick up.
    drops: observation.drops().filter((drop) => drop.state === "loaded"),
  };
}

/** The quarry census as it stands when evidence is taken, not as the pursuit once scanned it. */
function loadedTargets(bot: Bot, species: string, entityType: number | undefined): HuntTargetSighting[] {
  const origin = bot.entity?.position;
  if (!origin || entityType === undefined) return [];
  return Object.values(bot.entities ?? {})
    .filter((entity) => entity.id !== bot.entity.id && entity.isValid && entity.entityType === entityType)
    .map((entity) => ({
      species,
      id: entity.id,
      x: Math.floor(entity.position.x),
      y: Math.floor(entity.position.y),
      z: Math.floor(entity.position.z),
      distance: Number(entity.position.distanceTo(origin).toFixed(1)),
    }))
    .sort((left, right) => left.distance - right.distance);
}

type HuntAttemptResult =
  | { readonly status: "succeeded"; readonly hunt: HuntEvidence; readonly termination: HuntTermination }
  | {
      readonly status: "partial" | "failed";
      readonly error: string;
      readonly hunt: HuntEvidence;
      readonly termination: HuntTermination;
    };

function stoppedResult(
  error: string,
  observation: HuntObservation,
  termination: HuntTermination = observation.stopReason,
): HuntAttemptResult {
  const hunt = huntEvidence(observation);
  const madePhysicalProgress = hunt.gained > 0 || hunt.targetDeathsObserved > 0 || hunt.attacks > 0;
  return { status: madePhysicalProgress ? "partial" : "failed", error, hunt, termination };
}

/** The stop a fight that ended without a verdict on the target owes the caller. */
function fightStop(
  mob: string,
  outcome: Exclude<CombatOutcome, { kind: "died" | "target_lost" }>,
  signal?: AbortSignal,
): string {
  switch (outcome.kind) {
    case "unreachable":
      return huntMobOutcomes.approachStopped(mob, outcome.observation);
    case "capability_blocked":
      return `[HUNT_CAPABILITY_BLOCKED] ${outcome.reason}: ${outcome.observation}`;
    case "defence_required":
      return `[HUNT_DEFENCE_REQUIRED] ${outcome.observation}`;
    case "failed":
      return huntMobOutcomes.attackFailed(mob, outcome.observation);
    case "bot_died":
      return huntMobOutcomes.botDied(mob);
    case "cancelled":
      signal?.throwIfAborted();
      return huntMobOutcomes.combatStopped(mob);
  }
}

/**
 * Why the hunt ended without the requested drop.
 *
 * A fight or a pickup that stopped already said so in its own words, and the
 * pursuit carried that reason out with the target's last position appended, so
 * it is passed through. Only the pursuit's own two verdicts are phrased here.
 */
function pursuitStop(request: HuntMobRequest, result: HuntResult, gained: number): string {
  switch (result.status) {
    case "stopped":
    case "capability_blocked":
      return result.reason ?? huntMobOutcomes.combatStopped(request.mobName);
    case "unreachable":
      return huntMobOutcomes.approachStopped(request.mobName, result.reason ?? "no route reached it");
    default:
      return huntMobOutcomes.noLoadedTarget(request.mobName, request.dropName, gained, request.count);
  }
}

/**
 * Refuse a hostile hunt that has nothing to block with.
 *
 * The gate is the species rather than the fight that follows, because the cost
 * of learning it the other way is paid in the body: a skeleton opens at range
 * and a creeper only has to arrive. Hostility is the registry's own category,
 * so the mobs whose `type` misreads them - hoglins, phantoms, slimes, magma
 * cubes, ghasts - are covered by the same rule that covers skeletons, and a
 * chicken is never asked for a shield it does not need.
 *
 * Carrying one is the test, not wearing one: the loadout moves a carried shield
 * into the off-hand when the fight starts. A policy that forbids shields makes
 * a carried one ornamental, so that is refused on the same terms.
 */
function shieldRefusal(bot: Bot, request: HuntMobRequest, dependencies: HuntMobDependencies): string | null {
  if (request.allowWithoutShield || !isHostileSpecies(bot, request.mobName)) return null;
  if (!readCombatItems(bot).some((item) => item.name === "shield"))
    return huntMobOutcomes.shieldNotCarried(request.mobName);
  return dependencies.shieldPermitted() ? null : huntMobOutcomes.shieldNotPermitted(request.mobName);
}

/** Read the requested drop's count into the observation, and say whether the request is met. */
function settleInventory(bot: Bot, drop: HuntDrop, observation: HuntObservation): boolean {
  observation.inventoryAfter = bot.inventory.count(drop.id, null);
  return observation.inventoryAfter - observation.inventoryBefore >= observation.requested;
}

/** What one engagement in a hunt needs, held for the whole run. */
interface HuntEngagement {
  readonly bot: Bot;
  readonly request: HuntMobRequest;
  readonly drop: HuntDrop;
  readonly observation: HuntObservation;
  readonly dependencies: HuntMobDependencies;
  readonly context: ActionContext;
}

/**
 * The hunt's physical step, from inside contact range: fight one target,
 * attribute its drop, and sweep up the rest.
 *
 * Every way this can end without a kill is a stop the model must be able to
 * read, so each returns the outcome text itself rather than a code the caller
 * has to translate back.
 */
async function fightAndCollect(fight: HuntEngagement, targetId: number): Promise<EngagementOutcome> {
  const { bot, request, drop, observation, dependencies, context } = fight;
  const target = bot.entities[targetId];
  if (!target?.isValid) return { kind: "target_lost" };
  observation.targetsEngaged += 1;
  const dropEntityBaseline = snapshotEntityIds(bot);
  const dropInventoryBefore = observation.inventoryAfter;
  const { outcome, deathPosition } = await dependencies.engageTarget(target, context);
  observation.attacks += outcome.attacks;
  observation.projectileGuards += outcome.projectileGuards;
  for (const style of outcome.stylesUsed) observation.combatStyles.add(style);

  // Incidental pack kills can leave the requested item even when the selected
  // target survives or disappears. Gather that evidence before choosing another mob.
  if (outcome.kind === "target_lost" || outcome.kind === "unreachable") {
    await dependencies.gatherLoadedDrops(drop, context);
    if (settleInventory(bot, drop, observation)) return { kind: "defeated" };
  }

  // A target that vanished without dying - despawned, or killed by the reflex a
  // moment before the hunt reached it - is not a verdict on the hunt. The next
  // loaded one is.
  if (outcome.kind === "target_lost") return { kind: "target_lost" };
  // The pursuit's own stop rule applies: the raw observation is kept so the
  // process can phrase the final verdict once, as it does for a refused route.
  if (outcome.kind === "unreachable") return { kind: "unreachable", reason: outcome.observation };
  if (outcome.kind !== "died") {
    observation.stopReason = outcome.kind === "capability_blocked" ? "capability_blocked" : "execution_failed";
    return { kind: "stopped", reason: fightStop(request.mobName, outcome, context.signal) };
  }
  observation.targetDeathsObserved += 1;
  const died = deathPosition ?? positionOf(target);

  if (!settleInventory(bot, drop, observation)) {
    const pickup = await dependencies.collectDropAfterDeath(
      {
        dropName: drop.name,
        dropId: drop.id,
        inventoryBefore: dropInventoryBefore,
        entityBaseline: dropEntityBaseline,
        deathPosition: died,
      },
      context,
    );
    settleInventory(bot, drop, observation);
    // A lost drop settles this kill, not the requested quantity. Keep its
    // observed position/state in drop accounting and pursue the next quarry.
    if (pickup.kind === "inventory_full") {
      observation.stopReason = "inventory_full";
      return { kind: "stopped", reason: pickup.reason };
    }
    // An inaccessible drop settles this kill, not the collection objective.
    // Its observation remains in drop accounting; later loaded-drop sweeps can
    // revisit it after movement or another engagement changes the situation.
    if (pickup.kind === "not_collected") return { kind: "defeated" };
  }
  observation.otherDropsCollected += await dependencies.sweepDropsAfterDeath(
    { entityBaseline: dropEntityBaseline, deathPosition: died },
    context,
  );
  return { kind: "defeated" };
}

/**
 * Hunt one species until the requested drop is in the inventory.
 *
 * The pursuit owns which mob is next and the walk to it; this owns everything
 * about items and the fight, and reads top to bottom as parse, gather, pursue,
 * settle.
 */
export async function huntMob(
  bot: Bot,
  request: HuntMobRequest,
  context: ActionContext,
  dependencies: HuntMobDependencies,
): Promise<HuntMobResult> {
  const lifetime = new AbortController();
  try {
    return await beginHuntMob(bot, request, dependencies, lifetime.signal)(context);
  } finally {
    lifetime.abort();
  }
}

function beginHuntMob(
  bot: Bot,
  request: HuntMobRequest,
  dependencies: HuntMobDependencies,
  lifetime: AbortSignal,
  observe: ObserveRequest = () => {},
  budgets = new Budgets(),
) {
  const mob = bot.registry.entitiesByName[request.mobName];
  const drop = bot.registry.itemsByName[request.dropName];
  const inventoryBefore = drop ? bot.inventory.count(drop.id, null) : 0;
  const camp = request.campSpawner ? dependencies.createCamp(request.observeForMs) : null;
  const observation: HuntObservation = {
    stopReason: "execution_failed",
    drops: observeHuntDrops(bot, request.dropName, lifetime),
    mob: request.mobName,
    drop: request.dropName,
    requested: request.count,
    inventoryBefore,
    inventoryAfter: inventoryBefore,
    targetsEngaged: 0,
    selectedTargetId: null,
    targetChanges: [],
    targetDeathsObserved: 0,
    attacks: 0,
    combatStyles: new Set(),
    projectileGuards: 0,
    otherDropsCollected: 0,
    loadedTargets: () => loadedTargets(bot, request.mobName, mob?.id),
  };
  // Retain a terminal collection reason while a reflex interrupts its handoff.
  // Resumption finishes making the body safe; it does not restart the failed hunt.
  let phase: { kind: "collecting" | "observing" } | { kind: "finishing"; result: HuntAttemptResult } = {
    kind: "collecting",
  };
  let observationStartedAt: number | null = null;
  let handedOff = false;
  observe(() => {
    const current = drop ? bot.inventory.count(drop.id, null) : 0;
    return {
      baseline: { item: request.dropName, count: inventoryBefore },
      checkpoint: {
        phase: phase.kind,
        selectedTargetId: observation.selectedTargetId,
        attacks: observation.attacks,
        targetDeathsObserved: observation.targetDeathsObserved,
        inventory: current,
        gained: current - inventoryBefore,
        requested: request.count,
        observationStartedAt,
        observationUntil: observationStartedAt === null ? null : observationStartedAt + request.observeForMs,
        camp: camp?.snapshot ?? null,
      },
      completion: {
        kind: "current",
        observed: current - inventoryBefore >= request.count && handedOff,
        owes: `Net gain of ${request.count} ${request.dropName} still carried, followed by an observed safe handoff.`,
      },
    };
  });

  const run = async (context: ActionContext): Promise<HuntAttemptResult> => {
    context.signal?.throwIfAborted();

    if (!mob) return stoppedResult(huntMobOutcomes.unknownMob(request.mobName), observation, "invalid_request");
    if (!drop) return stoppedResult(huntMobOutcomes.unknownDrop(request.dropName), observation, "invalid_request");
    // Check admission, every target approach, and contact after drop collection.
    // One pursuit can fight several loaded targets before this function returns.
    let shieldRequired: string | null = null;
    const checkShield = () => (shieldRequired = shieldRefusal(bot, request, dependencies));
    const unshielded = checkShield();
    if (unshielded) return stoppedResult(unshielded, observation, "shield_required");
    const missingSpawner = camp?.unavailable();
    if (missingSpawner) return stoppedResult(missingSpawner.reason, observation, missingSpawner.termination);

    const quarry: HuntDrop = { name: request.dropName, id: drop.id };
    const fight: HuntEngagement = { bot, request, drop: quarry, observation, dependencies, context };
    const settled = () => settleInventory(bot, quarry, observation);
    const inventoryStop = () =>
      hasInventorySpaceFor(bot.inventory, new Set([quarry.name]))
        ? null
        : `[INVENTORY_FULL] No free slot or matching stack space for ${quarry.name}.`;

    if (!settled()) await dependencies.gatherLoadedDrops(quarry, context);
    const initialInventoryStop = inventoryStop();
    if (!settled() && initialInventoryStop) return stoppedResult(initialInventoryStop, observation, "inventory_full");

    const pursuit = await dependencies.pursue({
      preflight: checkShield,
      matches: (entity) => entity.entityType === mob.id && entity.isValid,
      compareTargets: (left, right) => compareCollectionTargets(bot, left, right),
      isSatisfied: settled,
      contactRange: HOSTILE_CONTACT_RANGE,
      ...(request.mobName === "enderman" && {
        reconsiderApproach: true,
        targetTier: (target: Bot["entities"][number]) => collectionTargetSafetyTier(bot, target),
      }),
      ...(context.signal && { signal: context.signal }),
      onTargetChanged: ({ previous, selected, reason }) => {
        const from = observation.selectedTargetId;
        if (from !== null && from !== selected.id)
          observation.targetChanges.push({
            fromTargetId: from,
            toTargetId: selected.id,
            position: selected.position,
            distance: Number(selected.distance.toFixed(1)),
            reason: previous ? reason : "The hunt resumed after interruption and selected from current observations.",
          });
        observation.selectedTargetId = selected.id;
      },
      engage: async (targetId) => {
        if (!settled()) await dependencies.gatherLoadedDrops(quarry, context);
        if (settled()) return { kind: "defeated" };
        const unshielded = checkShield();
        if (unshielded) return { kind: "stopped", reason: unshielded };
        const full = inventoryStop();
        if (full) observation.stopReason = "inventory_full";
        return full ? { kind: "stopped", reason: full } : fightAndCollect(fight, targetId);
      },
    });

    if (pursuit.status === "no_targets" && !settled()) await dependencies.gatherLoadedDrops(quarry, context);

    const met = settled();
    const evidence = huntEvidence(observation);
    if (met) return { status: "succeeded", hunt: evidence, termination: "quantity_collected" };
    if (shieldRequired) return stoppedResult(pursuit.reason ?? shieldRequired, observation, "shield_required");
    if (pursuit.status === "no_targets") observation.stopReason = "no_loaded_targets";
    if (pursuit.status === "unreachable") observation.stopReason = "targets_unreachable";
    if (pursuit.status === "capability_blocked") observation.stopReason = "capability_blocked";
    return stoppedResult(pursuitStop(request, pursuit, evidence.gained), observation);
  };

  return async (context: ActionContext): Promise<HuntMobResult> => {
    try {
      const available = () =>
        Object.values(bot.entities).some((entity) => entity.isValid && entity.entityType === mob?.id) ||
        (drop !== undefined && settleInventory(bot, { name: request.dropName, id: drop.id }, observation));
      while (phase.kind !== "finishing") {
        phase = { kind: "collecting" };
        if (available()) camp?.hunting();
        const result = await run(context);
        context.signal?.throwIfAborted();
        if (result.termination === "no_loaded_targets" && camp) {
          phase = { kind: "observing" };
          const failure = await camp.waitForQuarry(available, context.signal ?? lifetime);
          if (!failure) continue;
          phase = { kind: "finishing", result: stoppedResult(failure.reason, observation, failure.termination) };
          break;
        }
        if (result.termination === "no_loaded_targets" && request.observeForMs > 0) {
          observationStartedAt ??= Date.now();
          phase = { kind: "observing" };
          using window = budgets.attempt({
            name: "quarry_observation",
            scope: `request:${request.mobName}:${observationStartedAt}`,
            unit: "milliseconds",
            limit: request.observeForMs,
            measure: Date.now,
            startedAt: observationStartedAt,
            exhaustion:
              "Return partial inventory and observation_exhausted after a final observation and safe handoff.",
          });
          // The original absolute window includes time spent suspended or fighting.
          const remaining = window.remaining;
          const appeared =
            remaining > 0 &&
            (await waitForSignal(() => available() || null, bot, ["entitySpawn", "entityUpdate", "physicsTick"], {
              context,
              timeoutMs: remaining,
            }));
          context.signal?.throwIfAborted();
          if (appeared || available()) continue;
          phase = {
            kind: "finishing",
            result: stoppedResult(
              "[HUNT_OBSERVATION_EXHAUSTED] No loaded quarry or requested inventory gain was observed before the requested observation window ended.",
              observation,
              "observation_exhausted",
            ),
          };
          break;
        }
        phase = { kind: "finishing", result };
      }
      const result = phase.result;
      handedOff = false;
      const handoff = await dependencies.finish(context.signal ?? lifetime);
      const quantityStillCarried = drop && settleInventory(bot, { name: request.dropName, id: drop.id }, observation);
      handedOff = handoff.kind === "safe" && Boolean(quantityStillCarried);
      const settledResult: HuntAttemptResult =
        result.status === "succeeded" && !quantityStillCarried
          ? stoppedResult(
              "[HUNT_INVENTORY_CHANGED] The requested net inventory gain is no longer carried after protection.",
              observation,
              "inventory_changed",
            )
          : { ...result, hunt: huntEvidence(observation) };
      if (handoff.kind === "unsafe")
        return {
          ...settledResult,
          handoff,
          status: settledResult.hunt.gained > 0 ? "partial" : "failed",
          error: `${settledResult.status === "succeeded" ? "Requested items collected." : settledResult.error} [HUNT_UNSAFE_HANDOFF] ${handoff.reason}`,
        };
      return { ...settledResult, handoff };
    } catch (cause) {
      if (!context.signal?.aborted) throw cause;
      // The session still decides whether this interrupted attempt resumes.
      // If it ends here, keep the hunt's evidence instead of losing sightings
      // behind an evidence-free runtime cancellation.
      if (drop) settleInventory(bot, { name: request.dropName, id: drop.id }, observation);
      const reason: unknown = context.signal.reason;
      const interruption = reason instanceof Error ? reason.message : String(reason);
      const message =
        phase.kind === "finishing" && phase.result.status !== "succeeded"
          ? `${phase.result.error} [HUNT_HANDOFF_INTERRUPTED] ${interruption}`
          : interruption;
      return {
        ...stoppedResult(message, observation, phase.kind === "finishing" ? phase.result.termination : "interrupted"),
        handoff: { kind: "interrupted", reason: message },
      };
    }
  };
}

/** Loaded quarry beyond this many are counted, not listed; the nearest are the ones worth walking to. */
const MAX_LISTED_TARGETS = 16;

function coordinate(position: { x: number; y: number; z: number }): string {
  const axis = (value: number) => String(Math.round(value * 10) / 10);
  return `${axis(position.x)},${axis(position.y)},${axis(position.z)}`;
}

export function formatHuntMobResult(result: HuntMobResult): string {
  const { hunt } = result;
  const styles = hunt.combatStyles.length > 0 ? hunt.combatStyles.join(", ") : "none";
  const evidence = [
    `- Collection outcome: ${result.termination}.`,
    `- Handoff: ${result.handoff.kind === "safe" ? `observed ${result.handoff.basis} at ${JSON.stringify(result.handoff.position)}` : `${result.handoff.kind}: ${result.handoff.reason}`}.`,
    `Observed **${hunt.drop} ${hunt.gained}/${hunt.requested}** while intentionally hunting loaded \`${hunt.mob}\`.`,
    ...(hunt.drop === "arrow"
      ? ["- Bow policy: bow use was temporarily disabled for this arrow hunt, including defensive interruptions. The hunt restriction is released when the request ends; the survival policy's combat permissions apply again, including any existing bow prohibition."]
      : []),
    `- Inventory: ${hunt.inventoryBefore} → ${hunt.inventoryAfter}`,
    `- Engagement attempts: ${hunt.targetsEngaged}; retargets: ${hunt.retargets}`,
    ...hunt.targetChanges.map((change) => `- Target #${change.fromTargetId} → #${change.toTargetId}: ${change.reason}`),
    `- Target deaths observed: ${hunt.targetDeathsObserved}`,
    `- Attacks: ${hunt.attacks}; combat styles: ${styles}; ranged windups met with the shield: ${hunt.projectileGuards}`,
    `- Other drops picked up: ${hunt.otherDropsCollected}`,
    `- Items still lying loaded at return (not kill attribution): ${
      hunt.drops.length === 0
        ? "none"
        : hunt.drops
            .map(
              (drop) =>
                `#${drop.id} ${drop.item} ×${drop.observedCount} at ${coordinate(drop.position)}` +
                ` (in ${drop.blocks.atPosition ?? "unknown"}, above ${drop.blocks.belowPosition ?? "unknown"}` +
                `${drop.collectedByOther ? "; other collector observed" : ""}; last seen ${drop.observedAt})`,
            )
            .join("; ")
    }`,
    // Where the mobs are is the one thing a count cannot say, and it is what
    // a model needs to walk closer and ask again.
    `- Loaded ${hunt.mob} at return: ${
      hunt.targets.length === 0
        ? "none"
        : hunt.targets
            .slice(0, MAX_LISTED_TARGETS)
            .map((target) => `#${target.id} at ${target.x},${target.y},${target.z} (${target.distance} blocks)`)
            .join("; ") +
          (hunt.targets.length > MAX_LISTED_TARGETS ? `; +${hunt.targets.length - MAX_LISTED_TARGETS} more farther away` : "")
    }`,
  ].join("\n");
  return result.status === "succeeded" ? evidence : `${evidence}\n\n**Observed stop:** ${result.error}`;
}

export function createCollectMobDropAction(
  bot: Bot,
  navigation: NavigationRuntime,
  combat: CombatController,
  discarded: DiscardedItems,
  dependencies: HuntMobDependencies = huntMobDependencies(bot, navigation, combat, discarded),
  budgets = new Budgets(),
) {
  return defineAction({
    checkpointSchema: huntCheckpointSchema,
    name: COLLECT_MOB_DROP,
    description: COLLECT_MOB_DROP_DESCRIPTION,
    inputSchema: huntMobInputSchema,
    resultSchema: huntMobResultSchema,
    formatResult: formatHuntMobResult,
    execution: { kind: "resumable_task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: huntMobAnnotations,
    parse: parseHuntMobRequest,
    begin: (request, lifetime, observe) => {
      if (request.dropName === "arrow") combat.policy.reserveArrows(lifetime);
      combat.policy.declareQuarry(lifetime, request.mobName);
      return beginHuntMob(bot, request, dependencies, lifetime, observe, budgets);
    },
  });
}
