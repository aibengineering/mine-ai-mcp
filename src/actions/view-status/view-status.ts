import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import {
  CARRIED_SLOT_COUNT,
  carriedStacks,
  readLastDeath,
  snapshotBotStatus,
  updateBotStatus,
  type SqlBotData,
} from "../../bot-data/index.js";
import {
  DEFAULT_MAXIMUM_DROP,
  MAXIMUM_BUCKET_DROP,
  preferredScaffoldItem,
} from "../../navigation/mineflayer/movement-policy.js";
import { waterLandingSupply } from "../../navigation/mineflayer/water-landing.js";
import { HOSTILE_OBSERVATION_RANGE, observeHostileContact } from "../../survival/perception/combat/threats.js";
import { readNavigationPolicy } from "../../survival/state/navigation-policy.js";
import type { Position3 } from "../../utils/index.js";
import { airSupplyTicks } from "../../world/air-supply.js";
import { readDragonClouds } from "../../world/dragon-hazards.js";
import {
  dragonPhase,
  entityHealth,
  isDragonPerched,
  perchedDragonHead,
  predictedLandingHeadPosition,
} from "../../world/end-fight.js";
import { dayPhase, ticksToMinutes, ticksUntilDay, ticksUntilNight } from "../../world/index.js";
import { observeMobAge } from "../../world/mob-age.js";
import { defineAction } from "../action.js";
import {
  DRAGON_PHASE_NAMES,
  MOB_KINDS,
  VIEW_STATUS,
  VIEW_STATUS_DESCRIPTION,
  parseViewStatusRequest,
  viewStatusResultSchema,
  viewStatusAnnotations,
  viewStatusInputSchema,
  type LiveSituation,
  type MobilityBlocker,
  type MobKind,
  type ViewStatusResult,
} from "./contract.js";

type LiveNearby = LiveSituation["nearby"];
export type ObserveStatusActivity = () => LiveSituation["activity"];

/** Refresh the queryable status rows, then report the same facts plus what is loaded nearby. */
export function observeLiveSituation(
  bot: Bot,
  data: SqlBotData,
  observeActivity: ObserveStatusActivity,
): LiveSituation {
  const snapshot = snapshotBotStatus(bot);
  updateBotStatus(data, snapshot);
  const air = airSupplyTicks(bot);
  const flags = ownMetadataNumber(bot, "shared_flags");
  const inLava: unknown = Reflect.get(bot.entity ?? {}, "isInLava");
  const phase = snapshot.dimension === "overworld" ? dayPhase(snapshot.timeOfDay) : null;
  const ticksUntilChange =
    phase === null ? null : phase === "night" ? ticksUntilDay(snapshot.timeOfDay) : ticksUntilNight(snapshot.timeOfDay);
  const carried = carriedStacks(snapshot.inventory);
  const lastDeath = readLastDeath(data, bot.username);
  return {
    botId: snapshot.botId,
    observedAt: snapshot.updatedAt ?? new Date().toISOString(),
    dimension: snapshot.dimension,
    gameMode: snapshot.gameMode,
    lastDeath: lastDeath ? {
      dimension: lastDeath.dimension,
      position: roundedPosition(lastDeath.position),
      observedAt: lastDeath.observedAt,
      cause: lastDeath.cause,
    } : null,
    activity: observeActivity(),
    vitals: {
      health: round(snapshot.health, 1),
      food: snapshot.food,
      saturation: round(snapshot.saturation, 1),
      airSupplyTicks: air,
      burning: flags === null ? null : (flags & 1) !== 0,
    },
    mobility: observeMobility(bot),
    clock: {
      timeOfDay: snapshot.timeOfDay,
      phase,
      ticksUntilChange,
      minutesUntilChange: ticksUntilChange === null ? null : round(ticksToMinutes(ticksUntilChange), 1),
      sleeping: snapshot.isSleeping,
      raining: snapshot.isRaining,
    },
    position: {
      x: round(snapshot.x, 2),
      y: round(snapshot.y, 2),
      z: round(snapshot.z, 2),
      chunkX: snapshot.chunkX,
      chunkZ: snapshot.chunkZ,
      headingDegrees: headingDegrees(snapshot.yaw),
      onGround: snapshot.onGround,
      inWater: snapshot.inWater,
      inLava: typeof inLava === "boolean" ? inLava : null,
    },
    inventory: {
      usedSlots: carried.length,
      freeSlots: CARRIED_SLOT_COUNT - carried.length,
      stacks: [...snapshot.inventory],
    },
    tools: snapshot.tools!,
    nearby: observeNearby(bot),
    endFight: {
      dragons: Object.values(bot.entities)
        .filter((e) => e.isValid && e.name === "ender_dragon")
        .map((e) => {
          const observedPhase = dragonPhase(bot, e);
          const head = perchedDragonHead(bot, e);
          const landingHead = predictedLandingHeadPosition(bot, e);
          return {
            entityId: e.id,
            position: roundedPosition(e.position),
            health: entityHealth(bot, e),
            phase: observedPhase,
            phaseName: dragonPhaseName(observedPhase),
            perched: isDragonPerched(observedPhase),
            headEstimate: head ? roundedPosition(head.position) : null,
            landingHeadEstimate: landingHead ? roundedPosition(landingHead) : null,
          };
        }),
      crystals: Object.values(bot.entities)
        .filter((e) => e.isValid && e.name === "end_crystal")
        .map((e) => ({ entityId: e.id, position: roundedPosition(e.position), cage: crystalCage(bot, e.position) })),
      clouds: readDragonClouds(bot),
    },
  };
}

/**
 * What the inventory and the survival policy currently unlock, and why not.
 *
 * The three answers are the ones a model cannot infer from a stack list. A
 * route refuses to fall more than `DEFAULT_MAXIMUM_DROP` blocks unless a water
 * bucket makes the longer drop plannable, and the same bucket is what the
 * footing reflex spends on a fall nobody planned; a scaffold block is what
 * lets a route climb to a cell it cannot walk to. Each is read from the same
 * sources the policy reads, so a blocked movement names the thing to fix
 * rather than leaving the model to guess from an empty slot.
 */
function observeMobility(bot: Bot): LiveSituation["mobility"] {
  const navigation = readNavigationPolicy(bot);
  const { waterBuckets, dimensionHoldsWater } = waterLandingSupply(bot);
  const waterBlockers = (permitted: boolean): MobilityBlocker[] => [
    ...(waterBuckets > 0 ? [] : ["no_water_bucket" as const]),
    ...(dimensionHoldsWater ? [] : ["water_evaporates_here" as const]),
    ...(permitted ? [] : ["policy_disabled" as const]),
  ];
  const bucketDrop = waterBlockers(navigation.bucket_drops);
  const fallSave = waterBlockers(navigation.bucket_fall_save);
  const scaffold = preferredScaffoldItem(bot);
  const scaffoldBlockers: MobilityBlocker[] =
    navigation.scaffold_blocks.length === 0 ? ["policy_disabled"] : scaffold ? [] : ["no_scaffold_block"];
  return {
    maximumDrop: DEFAULT_MAXIMUM_DROP,
    waterBuckets,
    bucketDrop: {
      available: bucketDrop.length === 0,
      maximumBlocks: bucketDrop.length === 0 ? MAXIMUM_BUCKET_DROP : 0,
      blockedBy: bucketDrop,
    },
    fallSave: { available: fallSave.length === 0, blockedBy: fallSave },
    scaffold: {
      available: scaffoldBlockers.length === 0,
      item: scaffold?.name ?? null,
      blocks: scaffold
        ? bot.inventory.items().filter((item) => item.name === scaffold.name).reduce((total, item) => total + item.count, 0)
        : 0,
      blockedBy: scaffoldBlockers,
    },
  };
}

function dragonPhaseName(phase: number | null): (typeof DRAGON_PHASE_NAMES)[number] | null {
  return phase === null ? null : DRAGON_PHASE_NAMES[phase] ?? null;
}

/** Any remaining bar still means caged; absence is known only when the whole native cage probe is loaded. */
function crystalCage(bot: Bot, crystal: { x: number; y: number; z: number }): "present" | "none_observed" | "unknown" {
  const center = new Vec3(Math.floor(crystal.x), Math.floor(crystal.y), Math.floor(crystal.z));
  let unloaded = false;
  for (let x = -2; x <= 2; x++)
    for (let z = -2; z <= 2; z++)
      for (let y = -1; y <= 2; y++) {
        const block = bot.blockAt(center.offset(x, y, z));
        if (!block) unloaded = true;
        else if (block.name === "iron_bars") return "present";
      }
  return unloaded ? "unknown" : "none_observed";
}

/** Read the bot's own metadata, never oxygenLevel (which older Mineflayer versions update from other entities). */
function ownMetadataNumber(bot: Bot, key: "shared_flags"): number | null {
  const index = bot.registry.entitiesByName.player?.metadataKeys?.indexOf(key) ?? -1;
  const value: unknown = index < 0 ? undefined : bot.entity?.metadata?.[index];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** Mineflayer yaw 0 faces south and grows towards the east; a compass heading has north at 0° and east at 90°. */
function headingDegrees(yaw: number): number {
  return round((((-yaw * 180) / Math.PI) % 360) + 360, 1) % 360;
}

function observeNearby(bot: Bot): LiveNearby {
  const origin = bot.entity?.position ?? { x: 0, y: 0, z: 0 };
  return {
    rangeBlocks: HOSTILE_OBSERVATION_RANGE,
    players: observePlayers(bot, origin),
    hostiles: observeHostileContact(bot).map((threat) => ({
      name: threat.name,
      distance: round(threat.distance, 1),
      position: roundedPosition(threat.position),
    })),
    mobs: observeMobs(bot, origin),
    droppedItems: observeDroppedItems(bot, origin),
  };
}

function observePlayers(bot: Bot, origin: Position3): LiveNearby["players"] {
  return Object.values(bot.players ?? {})
    .filter((player) => player.username && player.username !== bot.username)
    .sort((left, right) => left.username.localeCompare(right.username))
    .map((player) => {
      const entity = player.entity as typeof player.entity | null | undefined;
      if (!entity?.position) return { username: player.username, distance: null, position: null };
      return {
        username: player.username,
        distance: distanceBetween(origin, entity.position),
        position: roundedPosition(entity.position),
      };
    });
}

/**
 * Every loaded mob, grouped by species and observed age, nearest first, at any distance.
 *
 * The hostile list beside it answers which threats the combat policy counts and
 * how close they are, within its own range. This answers what is loaded, so a
 * model can pick a species to hunt without listing `bot.entities` by hand. A
 * cow sixty blocks away belongs in exactly one of those two.
 *
 * Membership is the registry's own entity type, which `MOB_KINDS` lists: those
 * types occur only inside minecraft-data's two mob categories, so a player, a
 * dropped item, a projectile, a boat, and the bot's own entity carry none of
 * them and never reach the grouping.
 */
function observeMobs(bot: Bot, origin: Position3): LiveNearby["mobs"] {
  const groups = new Map<string, LiveNearby["mobs"][number]>();
  for (const entity of Object.values(bot.entities ?? {})) {
    const registered = entity?.position ? bot.registry.entities[entity.entityType ?? -1] : undefined;
    const kind = registered?.type;
    if (!registered || !isMobKind(kind)) continue;
    const nearest = {
      entityId: entity.id,
      distance: distanceBetween(origin, entity.position),
      position: roundedPosition(entity.position),
    };
    const age = observeMobAge(bot, entity);
    const group = `${registered.name}:${age}`;
    const seen = groups.get(group);
    if (!seen) {
      groups.set(group, { name: registered.name, kind, age, count: 1, nearest });
      continue;
    }
    seen.count += 1;
    if (nearest.distance < seen.nearest.distance) seen.nearest = nearest;
  }
  return [...groups.values()].sort(
    (left, right) => left.nearest.distance - right.nearest.distance || left.name.localeCompare(right.name),
  );
}

function isMobKind(type: string | undefined): type is MobKind {
  return MOB_KINDS.includes(type as MobKind);
}

/** How many loaded drops the report lists, nearest first; a mined-out quarry can hold far more. */
const DROPPED_ITEM_LIMIT = 16;

/**
 * Every loaded item entity, like the mob census and unlike the contact lists:
 * a pearl lying where an enderman died thirty blocks back is exactly what a
 * model asks this report for, and a sixteen-block bound hid it.
 */
function observeDroppedItems(bot: Bot, origin: Position3): LiveNearby["droppedItems"] {
  return Object.values(bot.entities ?? {})
    .filter((entity) => entity.name === "item" && entity.position)
    .flatMap((entity) => {
      const item = entity.getDroppedItem();
      if (!item) return [];
      const distance = distanceBetween(origin, entity.position);
      return [{ name: item.name, count: item.count, distance, position: roundedPosition(entity.position) }];
    })
    .sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
    .slice(0, DROPPED_ITEM_LIMIT);
}

function distanceBetween(origin: Position3, target: Position3): number {
  return round(Math.hypot(target.x - origin.x, target.y - origin.y, target.z - origin.z), 1);
}

function roundedPosition(position: Position3): Position3 {
  return { x: round(position.x, 2), y: round(position.y, 2), z: round(position.z, 2) };
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function formatViewStatusResult(result: ViewStatusResult): string {
  const { situation } = result;
  const { vitals, mobility, clock, position, inventory, nearby, tools } = situation;
  const yesNo = (value: boolean | null) => (value === null ? "unknown" : value ? "yes" : "no");
  const at = (point: Position3) => `\`${point.x}, ${point.y}, ${point.z}\``;
  const phaseChange =
    clock.phase === "night"
      ? `day breaks in ${clock.ticksUntilChange} ticks (~${clock.minutesUntilChange} min)`
      : `night falls in ${clock.ticksUntilChange} ticks (~${clock.minutesUntilChange} min)`;
  const daylightUnavailable =
    situation.dimension === "the_nether" || situation.dimension === "the_end"
      ? "no daylight cycle in this dimension"
      : "daylight cycle unknown for this dimension";
  const held = inventory.stacks.find((stack) => stack.held);
  const worn = inventory.stacks.filter((stack) => !isCarried(stack));
  const carried = groupCarried(inventory.stacks.filter(isCarried));
  const lines = [
    ...(situation.endFight.dragons.length || situation.endFight.crystals.length || situation.endFight.clouds.length
      ? [
          "### End fight (loaded observations)",
          ...situation.endFight.dragons.map(
            (d) =>
              `- Dragon #${d.entityId}: health ${d.health ?? "unknown"}, phase ${d.phase ?? "unknown"} (${d.phaseName ?? "unknown"}), perched ${d.perched}; at ${at(d.position)}${d.headEstimate ? `; estimated head ${at(d.headEstimate)}` : ""}`,
          ),
          ...situation.endFight.dragons.flatMap((d) =>
            d.landingHeadEstimate
              ? [`- Predicted head after landing: ${at(d.landingHeadEstimate)}; direction may change.`]
              : [],
          ),
          ...(situation.endFight.dragons.length
            ? ["- Perch hint: use `prepare_dragon_perch` before the first landing; it opens a low staging sightline and yields on observed landing. Then use `attack_dragon_perch` to follow the settled head. The head can turn, and breath can enter tunnels. A roofed first scan can leave the dragon treating you as unseen even after the roof is removed, shortening later perches."]
            : []),
          ...situation.endFight.crystals.map((c) => `- Crystal #${c.entityId} at ${at(c.position)}; cage ${c.cage.replaceAll("_", " ")}`),
          ...(situation.endFight.crystals.length
            ? ["- Bow tip: bows can hit caged crystals through gaps, but may waste arrows. Prefer exposed crystals when arrows are scarce."]
            : []),
          ...situation.endFight.clouds.map(
            (c) => `- Dragon breath #${c.id}: radius ${c.radius.toFixed(1)} at ${at(c)}`,
          ),
          "",
        ]
      : []),
    `**${situation.botId}** in \`${situation.dimension}\` (${situation.gameMode}), observed ${situation.observedAt}.`,
    "",
    "### Vitals",
    `- Health ${vitals.health}/20, hunger ${vitals.food}/20, saturation ${vitals.saturation}`,
    `- Air supply: ${vitals.airSupplyTicks === null ? "unknown" : `${vitals.airSupplyTicks} ticks`}; burning: ${yesNo(vitals.burning)}; in lava: ${yesNo(position.inLava)}`,
    `- Physical owner: ${situation.activity.owner}; action: ${situation.activity.activeAction ? `${situation.activity.activeAction.action} since ${situation.activity.activeAction.startedAt}` : "none"}`,
    "",
    "### Mobility",
    waterLine(mobility),
    `- Scaffold placement (pillar up, bridge gaps): ${
      mobility.scaffold.available
        ? `${mobility.scaffold.item} x${mobility.scaffold.blocks}`
        : `unavailable (${blockedBecause(mobility.scaffold.blockedBy)})`
    }`,
    "",
    "### Clock",
    clock.phase === null
      ? `- World clock ${clock.timeOfDay}; ${daylightUnavailable}`
      : `- Time of day ${clock.timeOfDay} (${clock.phase}); ${phaseChange}`,
    `- Sleeping: ${yesNo(clock.sleeping)}; raining: ${yesNo(clock.raining)}`,
    "",
    "### Position",
    `- ${at(position)}, chunk \`${position.chunkX}, ${position.chunkZ}\`, heading ${position.headingDegrees}°`,
    `- ${position.onGround ? "On the ground" : "Not on the ground"}; ${position.inWater ? "in water" : "not in water"}`,
    `- Last death: ${situation.lastDeath ? `${at(situation.lastDeath.position)} in \`${situation.lastDeath.dimension}\` at ${situation.lastDeath.observedAt}${situation.lastDeath.cause ? ` (${situation.lastDeath.cause})` : ""}` : "none recorded"}`,
    "",
    `### Inventory (${inventory.usedSlots} of ${CARRIED_SLOT_COUNT} slots used, ${inventory.freeSlots} free)`,
    `- Held: ${held ? `${held.name} x${held.count}` : "nothing"}`,
    `- Worn: ${worn.length > 0 ? worn.map((stack) => `${stack.location} ${stack.name}`).join(", ") : "nothing"}`,
    ...(carried.length > 0
      ? carried.map(
          (group) =>
            `- ${group.name} x${group.count} (${group.slots.length > 1 ? "slots" : "slot"} ${group.slots.join(", ")})`,
        )
      : ["- Carrying nothing"]),
    ...inventory.stacks.flatMap((stack) =>
      stack.durability === null
        ? []
        : [
            `- Durability: ${stack.name} (slot ${stack.slot}, ${stack.location}) ${stack.durability.remaining}/${stack.durability.maximum} remaining`,
          ],
    ),
    "- Durability is unavailable or not applicable for stacks without a durability entry.",
    "",
    "### Best tools and armour",
    ...[...tools.tools, ...tools.armour].map((entry) => `- ${entry.class}: ${entry.tier}${entry.item ? ` (${entry.item}, slot ${entry.slot}${entry.durabilityLeft === null ? "" : `, ${entry.durabilityLeft}/${entry.maximumDurability} durability`})` : ""}`),
    "",
    `### Nearby (within ${nearby.rangeBlocks} blocks)`,
    `- Players: ${
      nearby.players.length > 0
        ? nearby.players
            .map((player) =>
              player.position && player.distance !== null
                ? `${player.username} ${player.distance} blocks away at ${at(player.position)}`
                : `${player.username} (online, not loaded nearby)`,
            )
            .join("; ")
        : "none online"
    }`,
    `- Hostiles: ${
      nearby.hostiles.length > 0
        ? nearby.hostiles
            .map((hostile) => `${hostile.name} ${hostile.distance} blocks away at ${at(hostile.position)}`)
            .join("; ")
        : "none"
    }`,
    `- Loaded mobs (every loaded chunk, any distance):${nearby.mobs.length > 0 ? "" : " none"}`,
    ...nearby.mobs.map(
      (mob) =>
        `  - ${mob.name} (${mob.kind}${mob.age === "not_applicable" ? "" : `, ${mob.age === "unknown" ? "age unknown" : mob.age}`}) x${mob.count}, nearest #${mob.nearest.entityId} ${mob.nearest.distance} at ${at(mob.nearest.position)}`,
    ),
    `- Dropped items (every loaded chunk, nearest ${DROPPED_ITEM_LIMIT}): ${
      nearby.droppedItems.length > 0
        ? nearby.droppedItems
            .map((drop) => `${drop.name} x${drop.count} ${drop.distance} blocks away at ${at(drop.position)}`)
            .join("; ")
        : "none"
    }`,
    "",
    "Refreshed `main.bot_status` and `main.bot_inventory` for `query_bot_data`; refreshed `main.bot_tools` too.",
  ];
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

/**
 * The water bucket in one line, and the consequence only when there is one.
 *
 * This section renders on every status read, so an available movement says
 * nothing beyond its count: a stocked bot pays no standing text for a capability
 * it already has. What a model cannot infer is the empty case, where a missing
 * bucket quietly caps every route at `maximumDrop` and disarms the fall reflex,
 * so that one names both losses and why. The structured `mobility` field carries
 * the full detail either way.
 */
function waterLine(mobility: LiveSituation["mobility"]): string {
  const carried = `- Water buckets carried: ${mobility.waterBuckets}`;
  const lost: (readonly [string, readonly MobilityBlocker[]])[] = [
    ...(mobility.bucketDrop.available ? [] : [["planned bucket drops", mobility.bucketDrop.blockedBy] as const]),
    ...(mobility.fallSave.available ? [] : [["emergency fall saves", mobility.fallSave.blockedBy] as const]),
  ];
  if (lost.length === 0) return carried;
  // Both lost to the same cause is the ordinary empty-inventory case; only a
  // one-sided policy switch splits them, and then each names its own reason.
  const [first, second] = lost;
  const merged =
    second && blockedBecause(first![1]) === blockedBecause(second[1])
      ? [[`${first![0]} or ${second[0]}`, first![1]] as const]
      : lost;
  return `${carried}; ${merged.map(([what, why]) => `no ${what} (${blockedBecause(why)})`).join("; ")}`;
}

/** One phrase per blocker, each naming the thing to change rather than the check that failed. */
const MOBILITY_BLOCKER_TEXT: Readonly<Record<MobilityBlocker, string>> = {
  no_water_bucket: "no water bucket carried",
  water_evaporates_here: "water evaporates in this dimension",
  policy_disabled: "switched off in the survival policy",
  no_scaffold_block: "no admitted scaffold block carried",
};

function blockedBecause(blockers: readonly MobilityBlocker[]): string {
  return blockers.map((blocker) => MOBILITY_BLOCKER_TEXT[blocker]).join("; ");
}

function isCarried(stack: LiveSituation["inventory"]["stacks"][number]): boolean {
  return stack.location === "main" || stack.location === "hotbar";
}

function groupCarried(
  stacks: LiveSituation["inventory"]["stacks"],
): { name: string; count: number; slots: number[] }[] {
  const groups = new Map<string, { name: string; count: number; slots: number[] }>();
  for (const stack of [...stacks].sort((left, right) => left.slot - right.slot)) {
    const group = groups.get(stack.name) ?? { name: stack.name, count: 0, slots: [] };
    group.count += stack.count;
    group.slots.push(stack.slot);
    groups.set(stack.name, group);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

export function createViewStatusAction(bot: Bot, data: SqlBotData, observeActivity: ObserveStatusActivity) {
  return defineAction({
    name: VIEW_STATUS,
    description: VIEW_STATUS_DESCRIPTION,
    inputSchema: viewStatusInputSchema,
    resultSchema: viewStatusResultSchema,
    formatResult: formatViewStatusResult,
    execution: { kind: "information" },
    annotations: viewStatusAnnotations,
    parse: parseViewStatusRequest,
    execute: async () => ({ status: "succeeded", situation: observeLiveSituation(bot, data, observeActivity) }),
  });
}
