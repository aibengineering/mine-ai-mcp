import type { Bot } from "mineflayer";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { IncidentReference, IncidentRetention, IncidentTrigger } from "../bot-data/incident-log.js";
import { writeIncidentArtifact } from "../bot-data/incident-log.js";
import type { NavigationRuntime } from "../navigation/index.js";
import { deathMessage } from "../runtime/player-events.js";
import type { ActionRunnerStatus } from "../session/action-runner.js";
import type { CombatExecutionSnapshot, CombatPhase } from "../survival/control/combat/execution.js";
import type { SurvivalStatus } from "../survival/evidence/contract.js";
import type { CombatPerception } from "../survival/perception/combat/observations.js";
import type { CombatPositionPlan } from "../survival/positioning/combat/geometry.js";
import type { FootingRecoverySnapshot } from "../survival/responses/footing.js";
import { airSupplyTicks } from "../world/air-supply.js";
import { damageSourceName } from "../world/damage-registry.js";
import { IncidentRecorder } from "./incident-recorder.js";
import { observeCombatPackets } from "./combat-packets.js";
import { projectileSnapshot } from "./projectile-snapshot.js";

const vectorSchema = z.object({ x: z.number(), y: z.number(), z: z.number() });
const velocityComponent = z.number().int().min(-32768).max(32767);
// 1.21.4 entity_velocity carries vec3i16 in 1/8000 block per tick units.
// Keep the server integers as well as their decoded value, not entity.velocity
// after client physics has already changed it.
const velocitySchema = z
  .object({
    entityId: z.number().int(),
    velocity: z.object({ x: velocityComponent, y: velocityComponent, z: velocityComponent }).nullable().catch(null),
  })
  .transform((value) => ({
    ...value,
    velocityBlocksPerTick:
      value.velocity === null
        ? null
        : {
            x: value.velocity.x / 8000,
            y: value.velocity.y / 8000,
            z: value.velocity.z / 8000,
          },
  }));
const damageSchema = z.object({
  entityId: z.number(),
  sourceTypeId: z.number(),
  sourceCauseId: z.number(),
  sourceDirectId: z.number(),
  sourcePosition: vectorSchema.nullish().transform((value) => value ?? null),
});
const explosionSchema = z.object({
  x: z.number(),
  y: z.number(),
  z: z.number(),
  playerKnockback: vectorSchema.nullish().transform((value) => value ?? null),
});
const correctionSchema = z.object({
  teleportId: z.number(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  dx: z.number(),
  dy: z.number(),
  dz: z.number(),
  yaw: z.number(),
  pitch: z.number(),
  // Protodef's named bit flags also carry the original mask in _value.
  flags: z.union([z.number(), z.object({ _value: z.number() }).transform((value) => value._value)]),
});
const vector = (value: { x: number; y: number; z: number } | undefined) =>
  value ? { x: value.x, y: value.y, z: value.z } : null;
const observedBoolean = (entity: object, field: string): boolean | null => {
  const value: unknown = Reflect.get(entity, field);
  return typeof value === "boolean" ? value : null;
};

export interface IncidentObserverOptions {
  readonly survival?: () => SurvivalStatus;
  readonly directory: string;
  readonly perception?: Pick<CombatPerception, "read">;
  readonly retention?: IncidentRetention;
  readonly identity: object;
  readonly owner: () => {
    requestId: number | null;
    precedingRequestId: number | null;
    session: ActionRunnerStatus;
    combat: {
      targetId: number | null;
      position: CombatPositionPlan | null;
      execution?: CombatExecutionSnapshot | null;
    };
    footing?: FootingRecoverySnapshot | null;
  };
  readonly published: (reference: IncidentReference) => void;
}

/** Passive runtime observations. No debug switch, controls, or raw packet dumps. */
export function observeIncidents(
  bot: Bot,
  navigation: Pick<NavigationRuntime, "world" | "onEvent">,
  options: IncidentObserverOptions,
) {
  using listeners = new DisposableStack();
  const recorder = new IncidentRecorder(
    { ...options.identity, runtimeId: randomUUID(), hostPid: process.pid, minecraftVersion: bot.version },
    ({ trigger, requestId, contents, precedingRequestId }) =>
      writeIncidentArtifact(options.directory, trigger, requestId, contents, precedingRequestId, options.retention),
    options.published,
    undefined,
    () => (options.survival ? { survival: options.survival() } : {}),
  );
  let previous: { atMs: number; dimension: string; position: { x: number; y: number; z: number } } | null = null;
  let health = bot.health;
  let observationMs = 0;
  let physicsSamples = 0;
  let maxObservationMs = 0;
  let disconnected = false;
  let shieldUseTicks = 0;
  const phaseTicks: Partial<Record<CombatPhase, number>> = {};
  const hitCounts: Record<string, number> = {};
  const bearingCounts: Record<string, number> = {};
  const healthLossFollowingSource: Record<string, number> = {};
  let lastHit: { source: string; atMs: number } | null = null;
  const threatSnapshot = () =>
    options.perception
      ?.read()
      .filter((entry) => entry.attack !== "unmodelled" || entry.hasHitUs)
      .map((entry) => ({
        id: entry.id,
        position: vector(entry.position),
        distance: entry.distance,
        bearing: entry.bearing,
        visible: entry.visible,
        lastSeenTick: entry.lastSeenTick,
        windingUp: entry.windingUp,
        lastShotTick: entry.lastShotTick,
        firstShotInTicks: entry.firstShotInTicks,
        phase: entry.phase,
        attack: entry.attack,
        hasHitUs: entry.hasHitUs,
      })) ?? [];
  const useFlagsIndex = bot.registry?.entitiesByName.player?.metadataKeys?.indexOf("living_entity_flags") ?? -1;
  const sharedFlagsIndex = bot.registry?.entitiesByName.player?.metadataKeys?.indexOf("shared_flags") ?? -1;
  const combatPackets = listeners.use(observeCombatPackets(bot, recorder, useFlagsIndex));
  const observedFlags = (index: number): number | null => {
    const flags = index < 0 ? null : bot.entity.metadata?.[index];
    return typeof flags === "number" ? flags : null;
  };
  const attacker = (encodedId: number) => {
    if (encodedId === 0) return null;
    const id = encodedId - 1;
    const entity = bot.entities[id];
    if (!entity) return { id, name: null, position: null, bearingRadians: null };
    const offset = entity.position.minus(bot.entity.position);
    const bearing = Math.atan2(-offset.x, -offset.z) - bot.entity.yaw;
    return {
      id,
      name: entity.name ?? null,
      position: vector(entity.position),
      bearingRadians: Math.atan2(Math.sin(bearing), Math.cos(bearing)),
    };
  };

  const sample = () => {
    const started = performance.now();
    const atMs = Date.now();
    const { position, velocity, onGround, yaw, pitch } = bot.entity;
    const dimension = bot.game.dimension;
    const delta =
      previous && previous.dimension === dimension
        ? {
            elapsedMs: atMs - previous.atMs,
            x: position.x - previous.position.x,
            y: position.y - previous.position.y,
            z: position.z - previous.position.z,
          }
        : null;
    previous = { atMs, dimension, position: { x: position.x, y: position.y, z: position.z } };
    // Read the collision cells touched by the 0.6-wide, 1.8-high player and
    // the layer directly beneath it. A stalagmite must not become a cube here.
    const cells: { x: number; y: number; z: number; block: ReturnType<NavigationRuntime["world"]["blockAt"]> }[] = [];
    for (let x = Math.floor(position.x - 0.3); x <= Math.floor(position.x + 0.3); x++) {
      for (let z = Math.floor(position.z - 0.3); z <= Math.floor(position.z + 0.3); z++) {
        for (let y = Math.floor(position.y) - 1; y <= Math.floor(position.y + 1.8); y++) {
          cells.push({ x, y, z, block: navigation.world.blockAt(x, y, z) });
        }
      }
    }
    const controls = Object.fromEntries(
      (["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const).map((control) => [
        control,
        bot.getControlState(control),
      ]),
    );
    // Thirty-two blocks covers nearby threats and approaching projectiles;
    // entities outside this observation radius are explicitly not captured.
    const entities = Object.values(bot.entities)
      .filter(
        (entity) =>
          Math.hypot(entity.position.x - position.x, entity.position.y - position.y, entity.position.z - position.z) <=
          32,
      )
      .map((entity) => ({
        id: entity.id,
        name: entity.name,
        position: vector(entity.position),
        velocity: vector(entity.velocity),
        projectile: projectileSnapshot(bot, entity),
      }));
    const owner = options.owner();
    const phase = owner.combat.execution?.phase;
    if (phase) phaseTicks[phase] = (phaseTicks[phase] ?? 0) + 1;
    const useFlags = observedFlags(useFlagsIndex);
    const observedShieldUse = bot.inventory.slots?.[45]?.name === "shield" && useFlags !== null && (useFlags & 3) === 3;
    shieldUseTicks = observedShieldUse ? shieldUseTicks + 1 : 0;
    if (physicsSamples % 20 === 0) recorder.record("threats", { threats: threatSnapshot() }, atMs);
    const cost = performance.now() - started;
    observationMs += cost;
    maxObservationMs = Math.max(maxObservationMs, cost);
    physicsSamples++;
    recorder.record(
      "physics",
      {
        ...owner,
        observedShieldUseTicks: shieldUseTicks,
        shieldTelemetry: combatPackets.snapshot(),
        dimension,
        position: vector(position),
        positionDelta: delta,
        mineflayerVelocity: vector(velocity),
        onGround,
        yaw,
        pitch,
        isInWater: observedBoolean(bot.entity, "isInWater"),
        isInLava: observedBoolean(bot.entity, "isInLava"),
        health: bot.health,
        food: bot.food,
        airSupplyTicks: airSupplyTicks(bot),
        controls,
        cells,
        mineflayerUsingHeldItem: bot.usingHeldItem ?? null,
        // Mineflayer's local use flag can clear on a swing while the server
        // still reports off-hand use. Retain both instead of calling either
        // flag proof of a correctly oriented, ready shield.
        serverLivingEntityFlags: observedFlags(useFlagsIndex),
        entityRadius: 32,
        entities,
        observationMs: cost,
      },
      atMs,
    );
  };
  const capture = (trigger: IncidentTrigger, facts: object = {}) => {
    const owner = options.owner();
    recorder.record("trigger", {
      trigger,
      ...owner,
      ...facts,
      combatSummary: { phaseTicks, hitCounts, bearingCounts, healthLossFollowingSource },
      dimension: bot.game.dimension,
      position: vector(bot.entity.position),
      health: bot.health,
      inventory:
        bot.inventory.slots?.flatMap((item, slot) =>
          item ? [{ slot, name: item.name, count: item.count, durabilityUsed: item.durabilityUsed ?? null }] : [],
        ) ?? null,
    });
    return recorder.capture(trigger, owner.requestId, owner.precedingRequestId);
  };
  const onHealth = () => {
    const before = health;
    health = bot.health;
    if (health !== before) recorder.record("health_changed", { before, after: health });
    if (health < before) {
      // Health packets can aggregate several hits. Keep uncorrelated losses
      // explicit instead of assigning them to a stale attacker.
      const source = lastHit && Date.now() - lastHit.atMs < 250 ? lastHit.source : "unattributed";
      healthLossFollowingSource[source] = (healthLossFollowingSource[source] ?? 0) + before - health;
      lastHit = null;
    }
  };
  const onDeath = () => {
    void capture("death");
  };
  const onEnd = (reason: string) => {
    if (disconnected) return;
    disconnected = true;
    capture("disconnect", { reason });
  };
  const onForcedMove = () => {
    recorder.record("server_position_applied", {
      dimension: bot.game.dimension,
      position: vector(bot.entity.position),
    });
    previous = null; // Never label a teleport delta as local movement.
  };
  const onRespawn = () => {
    previous = null;
    shieldUseTicks = 0;
  };
  bot.on("physicsTick", sample);
  listeners.defer(() => bot.off("physicsTick", sample));
  bot.on("health", onHealth);
  listeners.defer(() => bot.off("health", onHealth));
  bot.on("death", onDeath);
  listeners.defer(() => bot.off("death", onDeath));
  bot.on("forcedMove", onForcedMove);
  listeners.defer(() => bot.off("forcedMove", onForcedMove));
  bot.on("respawn", onRespawn);
  listeners.defer(() => bot.off("respawn", onRespawn));

  // These schemas deliberately select only diagnostic fields from 1.21.4.
  // Unsupported packet shapes are recorded as unavailable, never guessed.
  function packet<T>(
    name: string,
    schema: z.ZodType<T>,
    accept: (value: T) => boolean = () => true,
    after?: (value: T) => void,
  ) {
    const receive = (raw: unknown) => {
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        recorder.record("packet_unavailable", { packet: name, reason: "unsupported diagnostic fields" });
      } else if (accept(parsed.data)) {
        recorder.record("packet", { packet: name, botEntityId: bot.entity.id, fields: parsed.data });
        after?.(parsed.data);
      }
    };
    bot._client.on(name, receive);
    listeners.defer(() => bot._client.off(name, receive));
  }
  packet(
    "damage_event",
    damageSchema,
    // Keep all received damage before attribution. A health loss without a
    // matching hit must be distinguishable from an entity-filter mismatch.
    () => true,
    (value) => {
      if (value.entityId === bot.entity.id) {
        const shared = observedFlags(sharedFlagsIndex);
        // Dynamic IDs remain the authoritative key. Names are not guessed
        // from a vanilla registry when a server can install a data pack.
        const source = damageSourceName(bot, value.sourceTypeId) ?? `damage_type:${value.sourceTypeId}`;
        const cause = attacker(value.sourceCauseId);
        const angle = cause?.bearingRadians;
        const bearing = angle == null ? "unknown" : Math.abs(angle) <= Math.PI / 2 ? "front" : "rear";
        hitCounts[source] = (hitCounts[source] ?? 0) + 1;
        bearingCounts[bearing] = (bearingCounts[bearing] ?? 0) + 1;
        lastHit = { source, atMs: Date.now() };
        recorder.record("threats", { threats: threatSnapshot() });
        recorder.record("hit", {
          ...options.owner(),
          sourceTypeId: value.sourceTypeId,
          sourceType: damageSourceName(bot, value.sourceTypeId),
          observedShieldUseTicks: shieldUseTicks,
          shieldTelemetry: combatPackets.snapshot(),
          shieldReadinessBasis: "cached_metadata_tick_estimate_not_server_collision_confirmation",
          shieldReadyFromObservedUse:
            shieldUseTicks >= 5 &&
            observedFlags(useFlagsIndex) !== null &&
            (observedFlags(useFlagsIndex)! & 3) === 3 &&
            bot.inventory.slots?.[45]?.name === "shield",
          bearingBand: bearing,
          cause: attacker(value.sourceCauseId),
          direct: attacker(value.sourceDirectId),
          yaw: bot.entity.yaw,
          mineflayerUsingHeldItem: bot.usingHeldItem ?? null,
          serverLivingEntityFlags: observedFlags(useFlagsIndex),
          offHand: bot.inventory.slots?.[45]?.name ?? null,
          burning: shared === null ? null : (shared & 1) !== 0,
        });
      }
      // Zero means no causing/direct entity in this protocol, not an unknown entity ID.
      // Ordinary mob hits stay in history; a death still freezes them.
      if (value.entityId === bot.entity.id && value.sourceCauseId === 0 && value.sourceDirectId === 0)
        capture("non_entity_damage", { damage: value });
    },
  );
  const onHealthPacket = (raw: unknown) => {
    const parsed = z.object({ health: z.number(), food: z.number(), foodSaturation: z.number() }).safeParse(raw);
    if (parsed.success) recorder.record("packet", { direction: "incoming", packet: "update_health",
      botEntityId: bot.entity.id, fields: parsed.data });
    else recorder.record("packet_unavailable", { packet: "update_health", reason: "unsupported diagnostic fields" });
  };
  // Record before Mineflayer emits health: a scenario may capture immediately.
  bot._client.prependListener("update_health", onHealthPacket);
  listeners.defer(() => bot._client.off("update_health", onHealthPacket));
  const onVelocity = (raw: unknown) => {
    const parsed = velocitySchema.safeParse(raw);
    // Without a supported identity we cannot attribute this packet to our bot.
    if (!parsed.success || parsed.data.entityId !== bot.entity.id) return;
    if (parsed.data.velocity === null)
      recorder.record("packet_unavailable", { packet: "entity_velocity", reason: "unsupported diagnostic fields" });
    else recorder.record("packet", { packet: "entity_velocity", fields: parsed.data });
  };
  bot._client.on("entity_velocity", onVelocity);
  listeners.defer(() => bot._client.off("entity_velocity", onVelocity));
  packet("explosion", explosionSchema);
  packet("position", correctionSchema);
  const onCombatDeath = (raw: unknown) => {
    const packet = z.object({ playerId: z.number().optional(), message: z.unknown() }).safeParse(raw);
    if (packet.success && (packet.data.playerId === undefined || packet.data.playerId === bot.entity.id))
      recorder.record("server_death", { message: deathMessage(bot, packet.data.message) });
  };
  bot._client.on("death_combat_event", onCombatDeath);
  listeners.defer(() => bot._client.off("death_combat_event", onCombatDeath));
  listeners.defer(
    navigation.world.subscribe((change) => {
      const position = bot.entity.position;
      if (
        Math.hypot(change.position.x - position.x, change.position.y - position.y, change.position.z - position.z) <= 8
      )
        recorder.record("nearby_block_change", { dimension: bot.game.dimension, change });
    }),
  );
  listeners.defer(
    navigation.onEvent((event) => {
      if (event.kind === "search_slice" || (event.kind === "world_change" && event.classification === "irrelevant"))
        return;
      if (event.kind === "route_committed") {
        recorder.retainPlan({ ...options.owner(), dimension: bot.game.dimension, event });
        const { plan, ...summary } = event;
        recorder.record("navigation", { ...options.owner(), event: summary });
        return;
      }
      recorder.record("navigation", { ...options.owner(), event });
    }),
  );
  const ownedListeners = listeners.move();
  return {
    recorder,
    capture: () => capture("operator"),
    status: () => ({ ...recorder.status(), physicsSamples, observationMs, maxObservationMs }),
    connectionLost: onEnd,
    async close() {
      ownedListeners.dispose();
      // Successful trials and assertion failures also need their final history.
      // Flush an existing death first so this lifecycle capture cannot coalesce it.
      await recorder.flush();
      await capture("runtime_closed");
      await recorder.flush();
    },
  };
}
