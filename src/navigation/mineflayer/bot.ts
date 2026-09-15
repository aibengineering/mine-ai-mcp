import { saveWaterLanding } from "../../navigation/mineflayer/water-landing.js";
import { readNavigationPolicy } from "../../survival/state/navigation-policy.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { SupportedPositionController } from "../execution/supported-position-controller.js";
import { holdWaterPosition } from "../steering/hold-water-position.js";
import { holdSwimDepth } from "../world/swimming.js";
import { horizontalControlsToward } from "../steering/local-steering.js";
/**
 * Mineflayer's implementation of the bot port.
 *
 * Observing the bot (position, stance, inventory, entities), and acting on it:
 * controls, physics ticks, digging, placing, activating, tool equipping, and
 * physical stabilization. Everything Minecraft-shaped about the bot is here,
 * at the integration edge, and nowhere else in navigation.
 */
import type { Bot } from "mineflayer";
import { recordCombatResourceReceipt } from "../../runtime/combat-resource-receipts.js";
import { appendFileSync } from "node:fs";
import { Vec3 } from "vec3";
import { STANDING_EYE_HEIGHT, visibleBlockAim } from "../../world/block-visibility.js";
import { occupiedCell, placeWithoutLooking, type WorldBlock } from "../../world/placement.js";
import { AIR_COAST_TICKS, COAST_TICKS, PLAYER_HALF_WIDTH } from "../../world/player-physics.js";
import type { EffectHandle, MovementPreparation, NavigationBot } from "../bot.js";
import {
  createMovementController,
  recenterControls,
  releasedControls,
  type MovementControl,
  type MovementControlIntent,
  type MovementExecution,
  type MovementSnapshot,
} from "../execution/movement-controller.js";
import type { AttemptToken } from "../execution/mutations.js";
import { DIG_REACH } from "../movements/excavation.js";
import type { PlannedOperation, PlannedStep } from "../movements/movement.js";
import {
  centerOnCell,
  driveHorizontalSteering,
  steeringPortFor,
  type HorizontalSteeringOutcome,
  type HorizontalSteeringPort,
  type HorizontalSteeringRequest,
} from "../steering/local-steering.js";
import { navigationFeet } from "../world/block-geometry.js";
import {
  blockLabel,
  blockPosition,
  type BlockPosition,
  type EntityObservation,
  type NavigationObservation,
  type Position3,
  type WorldView,
} from "../world/world.js";
import { CLIMBABLES, observeMineflayerBlock, type MineflayerBlock } from "./world.js";

const NETHER_VINES = new Set(["weeping_vines", "weeping_vines_plant", "twisting_vines", "twisting_vines_plant"]);
// Prismarine applies gravity and drag after assigning its 0.2 climb impulse;
// physicsTick observers therefore see this value and carry it into the next move.
const NETHER_VINE_CLIMB_VELOCITY = (0.2 - 0.08) * 0.98;
const NETHER_VINE_HORIZONTAL_VELOCITY = 0.15 * 0.91;

/** Temporary dig timing trace, appended as JSON lines to the file named by MINE_AI_DIG_TRACE. */
function traceDig(record: Record<string, unknown>): void {
  const file = process.env.MINE_AI_DIG_TRACE;
  if (!file) return;
  try {
    appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
  } catch {
    // A trace that cannot be written is not a navigation failure.
  }
}

export interface MineflayerBotSurface {
  readonly entity: {
    readonly position: Position3;
    readonly velocity?: { x: number; y: number; z: number };
    /** Set by Prismarine Physics after resolving this tick's horizontal movement. */
    readonly isCollidedHorizontally?: boolean;
    readonly onGround: boolean;
    readonly isInWater: boolean;
    /** Optional so existing fakes need no change; reported in failures when present. */
    readonly yaw?: number;
    readonly pitch?: number;
    /** Mineflayer types these as an array; both shapes are read with `Object.values`. */
    readonly effects?:
      | readonly { readonly id?: number; readonly amplifier?: number }[]
      | Readonly<Record<string, { readonly id?: number; readonly amplifier?: number } | undefined>>;
  };
  readonly game: { readonly dimension: string };
  readonly inventory: { items(): readonly { readonly type: number; readonly count: number }[] };
  readonly entities: Readonly<
    Record<
      string,
      { readonly id: number; readonly position: Position3; readonly width: number; readonly height: number }
    >
  >;
  /** Undefined until the bot has spawned. */
  readonly food?: number;
  setControlState(control: "forward" | "back" | "left" | "right" | "jump" | "sprint" | "sneak", state: boolean): void;
  getControlState?(control: "jump" | "sneak"): boolean;
  waitForTicks(ticks: number): Promise<void>;
  lookAt(position: Position3, force?: boolean): Promise<void>;
  equip(item: { readonly type: number }, destination: "hand"): Promise<void>;
  /** Registry name of an item type, for failures about an item no longer carried. Optional so fakes need no change. */
  itemName?(type: number): string | null;
  blockAt(position: Position3): unknown;
  /**
   * `forceLook: "ignore"` suppresses Mineflayer's own aim so the caller can own
   * the rotation using the observed aim point.
   */
  dig(block: unknown, forceLook?: boolean | "ignore"): Promise<void>;
  /**
   * The point to aim at within dig reach, or null when the block is occluded.
   * Required so a planned dig cannot silently skip live visibility checking.
   */
  visibleDigAim(position: Position3): Position3 | null;
  /** Absolute rotation in radians. Optional; falls back to `lookAt` when absent. */
  look?(yaw: number, pitch: number, force?: boolean): Promise<void>;
  bucketDrop?(target: BlockPosition, signal: AbortSignal): Promise<boolean>;
  stopDigging(): void;
  /** Place against a face. The port has already aimed; the surface must not re-aim. */
  placementObstacle(position: Position3): string | null;
  placeBlock(support: unknown, face: Position3): Promise<void>;
  activateBlock(block: unknown): Promise<void>;
  combatResourceReceipt?(): void;
  on(event: "physicsTick", listener: () => void): void;
  off(event: "physicsTick", listener: () => void): void;
  /** Observe a velocity packet for this player after Mineflayer applies it. */
  onSelfVelocity?(listener: () => void): () => void;
}

type InventoryItem = ReturnType<Bot["inventory"]["items"]>[number];

/**
 * Present one connected bot through the port.
 *
 * Blocks and items travel through the port opaquely so a test fake need not
 * construct Prismarine objects; the only values `dig`, `placeBlock`,
 * `activateBlock`, and `equip` ever receive are ones `blockAt` and
 * `inventory.items()` returned, which is what the two narrowing helpers rely on.
 */
export function mineflayerBotSurface(bot: Bot): MineflayerBotSurface {
  const block = (value: unknown) => value as MineflayerBlock;
  const item = (value: { readonly type: number }) => value as InventoryItem;
  return {
    get entity() {
      // prismarine-physics writes `isInWater` onto the entity every tick;
      // Mineflayer's Entity type does not declare it.
      return bot.entity as Bot["entity"] & { readonly isInWater: boolean };
    },
    get game() {
      return bot.game;
    },
    get inventory() {
      return bot.inventory;
    },
    get entities() {
      return bot.entities;
    },
    get food() {
      return bot.food;
    },
    setControlState: (control, state) => bot.setControlState(control, state),
    bucketDrop: async (target, signal) => {
      const result = await saveWaterLanding(bot, { target, signal, permitted: () => readNavigationPolicy(bot).bucket_drops });
      const at = bot.entity.position;
      return result.waterRecovered && Math.floor(at.x) === target.x && at.y === target.y && Math.floor(at.z) === target.z;
    },
    getControlState: (control) => bot.getControlState(control),
    itemName: (type) => bot.registry.items[type]?.name ?? null,
    waitForTicks: (ticks) => bot.waitForTicks(ticks),
    lookAt: (position, force) => bot.lookAt(new Vec3(position.x, position.y, position.z), force),
    look: (yaw, pitch, force) => bot.look(yaw, pitch, force),
    equip: (value, destination) => bot.equip(item(value), destination),
    blockAt: (position) => bot.blockAt(new Vec3(position.x, position.y, position.z)),
    dig: (target, forceLook) => bot.dig(block(target), forceLook ?? false),
    visibleDigAim: (position) => {
      const eyeHeight = (bot.entity as { readonly eyeHeight?: number }).eyeHeight ?? STANDING_EYE_HEIGHT;
      const target = bot.blockAt(new Vec3(position.x, position.y, position.z));
      if (!target) return null;
      return visibleBlockAim(
        bot.world,
        bot.entity.position.offset(0, eyeHeight, 0),
        position,
        DIG_REACH,
        observeMineflayerBlock(target).collisionShapes,
      );
    },
    stopDigging: () => bot.stopDigging(),
    placementObstacle: (position) => occupiedCell(bot, position),
    placeBlock: (support, face) => placeWithoutLooking(bot, support as WorldBlock, new Vec3(face.x, face.y, face.z)),
    activateBlock: (target) => bot.activateBlock(block(target)),
    combatResourceReceipt: () => recordCombatResourceReceipt(bot, { kind: "scaffold_placed" }),
    on: (event, listener) => {
      bot.on(event, listener);
    },
    off: (event, listener) => {
      bot.off(event, listener);
    },
    onSelfVelocity: (listener) => {
      const client = (bot as Bot & { _client?: Bot["_client"] })._client;
      if (!client) return () => undefined;
      const receive = (packet: { readonly entityId: number }) => {
        if (packet.entityId === bot.entity.id) listener();
      };
      client.on("entity_velocity", receive);
      return () => client.off("entity_velocity", receive);
    },
  };
}

/** The name of a block the surface returned, or null when it returned nothing or something nameless. */
function blockName(value: unknown): string | null {
  return typeof value === "object" && value !== null && "name" in value && typeof value.name === "string"
    ? value.name
    : null;
}

/** Restore vanilla climb response omitted by the pinned Prismarine Physics, for this connection's lifetime. */
export function installNetherVinePhysics(bot: MineflayerBotSurface): () => void {
  const tick = () => {
    const velocity = bot.entity.velocity;
    const controls = bot.getControlState;
    if (!velocity || !controls) return;
    const name = blockName(bot.blockAt(blockPosition(bot.entity.position)));
    if (!name || !NETHER_VINES.has(name)) return;
    velocity.x = Math.max(-NETHER_VINE_HORIZONTAL_VELOCITY, Math.min(NETHER_VINE_HORIZONTAL_VELOCITY, velocity.x));
    velocity.z = Math.max(-NETHER_VINE_HORIZONTAL_VELOCITY, Math.min(NETHER_VINE_HORIZONTAL_VELOCITY, velocity.z));
    velocity.y = Math.max(velocity.y, controls("sneak") ? 0 : -0.15);
    // Match the pinned ladder branch after movement resolution: collision
    // climbs even without jump; climbUsingJump makes jump an alternative.
    if (bot.entity.isCollidedHorizontally || controls("jump")) velocity.y = NETHER_VINE_CLIMB_VELOCITY;
  };
  bot.on("physicsTick", tick);
  const releaseVelocity = bot.onSelfVelocity?.(tick);
  return () => {
    bot.off("physicsTick", tick);
    releaseVelocity?.();
  };
}

export class MineflayerBot implements NavigationBot {
  readonly #controls = new Set<MovementControl>();
  constructor(
    readonly bot: MineflayerBotSurface,
    /** Only its revision is read, so an observation can say how old the world it saw is. */
    readonly world: Pick<WorldView, "revision">,
    readonly ownsDive: () => boolean = () => false,
    readonly selectedTool: () => ((itemType: number | null) => void) | undefined = () => undefined,
  ) {}
  /** One reading of the bot: where it is and how it stands, the player, every stack, and every entity. */
  observe(): NavigationObservation {
    const { entity } = this.bot;
    const feet = blockPosition(entity.position);
    const feetBlock = blockName(this.bot.blockAt(feet));
    // Physics checks the whole body. Its edge can touch flowing water while
    // both centre cells are air; calling that airborne restarts every search
    // as stationary buoyancy lifts the bot off its support.
    const stance = entity.onGround
      ? "supported"
      : entity.isInWater
        ? "swimming"
        : feetBlock !== null && CLIMBABLES.has(feetBlock)
          ? "climbing"
          : "airborne";
    const inventory = new Map<number, number>();
    for (const item of this.bot.inventory.items()) {
      inventory.set(item.type, (inventory.get(item.type) ?? 0) + item.count);
    }
    return {
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      dimension: this.bot.game.dimension,
      stance,
      worldRevision: this.world.revision,
      // Every stack in hand, in one string. The blocks and tools carried decide
      // which routes exist and what they cost, so any change is a new question.
      resourceRevision: [...inventory]
        .sort(([left], [right]) => left - right)
        .map(([type, count]) => `${type}:${count}`)
        .join(","),
      inventory,
      entities: new Map(
        Object.values(this.bot.entities).map((observed): [number, EntityObservation] => [
          observed.id,
          {
            id: observed.id,
            position: { x: observed.position.x, y: observed.position.y, z: observed.position.z },
            width: observed.width,
            height: observed.height,
          },
        ]),
      ),
      player: {
        food: this.bot.food ?? 20,
        effects: Object.fromEntries(
          Object.values(entity.effects ?? {}).flatMap((effect) =>
            typeof effect?.id === "number" ? [[String(effect.id), (effect.amplifier ?? 0) + 1] as const] : [],
          ),
        ),
        aquaAffinity: false,
      },
    };
  }
  #sampledPosition: Position3 | null = null;

  /** Lift toward air without putting the 1.8-block body into a ceiling edge. */
  #waterRise(step: PlannedStep): number {
    const ceiling = this.bot.blockAt({ ...step.to, y: step.to.y + 2 }) as MineflayerBlock | null;
    if (!ceiling) return 0;
    // Retain the two-block passage's 0.2 clearance for upward momentum after
    // releasing jump. A full ceiling therefore requires swimming at feet level.
    return observeMineflayerBlock(ceiling).collisionShapes.reduce((rise, box) => Math.min(rise, box.minY), 0.6);
  }

  #stepUpHeadBonkClear(step: PlannedStep): boolean {
    const y = step.from.y + 2;
    // A continuous diagonal approach can still overlap a corner of the
    // previous cell. Checking only the four cardinal neighbours allowed an
    // early jump into that corner's ceiling, then a slide off the takeoff ledge
    // while Minecraft's jump cooldown ran. Any nearby ceiling requires the
    // controller's existing aligned takeoff, including diagonal neighbours.
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dz = -1; dz <= 1; dz += 1) {
        const block = this.bot.blockAt(new Vec3(step.from.x + dx, y, step.from.z + dz)) as {
          readonly boundingBox?: string;
          readonly name?: string;
        } | null;
        if (!block) return false;
        if (block.boundingBox === "empty" || block.name === "water" || block.name === "ladder" || block.name === "vine")
          continue;
        return false;
      }
    }
    return true;
  }

  #gapTakeoff(step: PlannedStep): Pick<MovementExecution, "gapTakeoffPosition"> {
    if (!["jump", "sprint_jump", "parkour"].includes(step.kind)) return {};
    const x = step.from.x + Math.sign(step.to.x - step.from.x);
    const z = step.from.z + Math.sign(step.to.z - step.from.z);
    const block = this.bot.blockAt(new Vec3(x, step.from.y - 1, z)) as MineflayerBlock | null;
    if (!block) return {};
    const observed = observeMineflayerBlock(block);
    const support = this.bot.blockAt(new Vec3(step.from.x, step.from.y - 1, step.from.z)) as MineflayerBlock | null;
    const lowSupport = support && observeMineflayerBlock(support).collisionShapes.every((box) => box.maxY < 1);
    if (
      observed.traits.damaging &&
      ((observed.traits.liquid !== null && lowSupport) || observed.collisionShapes.some((box) => box.maxY === 1))
    ) {
      // Launch from the source centre. Waiting for the 0.6-wide body's lip
      // crosses into the hazard on the physics tick before jump takes effect;
      // on a low floor that contact includes adjacent lava.
      return { gapTakeoffPosition: 0 };
    }
    return {};
  }

  movementSnapshot(): MovementSnapshot {
    const position = { ...this.bot.entity.position };
    // Velocity is the displacement since this was last sampled, not
    // `bot.entity.velocity`.
    //
    // Reading the entity field looks obviously better and measured worse:
    // prismarine-physics stores the post-friction value there, the base for
    // the next tick rather than the distance just covered, so it runs about
    // half the observed step. Braking distances derived from it under-braked,
    // and `deep-vertical-ore-return` failed with "could not center over its
    // pillar cell". Observed displacement is what the coast has to cancel, and
    // it is the unit every braking figure here was tuned in.
    const previous = this.#sampledPosition;
    this.#sampledPosition = position;
    const feetBlock = blockName(this.bot.blockAt(blockPosition(position)));
    return {
      position,
      velocity: previous
        ? { x: position.x - previous.x, y: position.y - previous.y, z: position.z - previous.z }
        : { x: 0, y: 0, z: 0 },
      onGround: this.bot.entity.onGround,
      isInWater: this.bot.entity.isInWater,
      climbing: feetBlock !== null && CLIMBABLES.has(feetBlock),
      yaw: this.bot.entity.yaw ?? 0,
    };
  }
  get ownedControlCount() {
    return this.#controls.size;
  }
  #control(control: MovementControl, state: boolean) {
    this.bot.setControlState(control, state);
    if (state) this.#controls.add(control);
    else this.#controls.delete(control);
  }
  applyMovementControls(intent: MovementControlIntent) {
    for (const control of ["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const) {
      if (this.#controls.has(control) !== intent[control]) this.#control(control, intent[control]);
    }
  }
  applyMovementSteering(target: Position3) {
    const position = this.bot.entity.position;
    const dx = target.x - position.x;
    const dz = target.z - position.z;
    if (Math.hypot(dx, dz) <= 0.001) return;
    const yaw = Math.atan2(-dx, -dz);
    const pitch = this.bot.entity.pitch ?? 0;
    // `force=true` applies the rotation immediately; Mineflayer retains a
    // Promise-shaped API because an unforced look can be spread across ticks.
    // This is intentionally issued without awaiting inside the physics tick.
    // Connected Mineflayer bots provide `look`. Test ports may omit it; their
    // preparation-time `lookAt` remains the only heading effect in that case.
    if (this.bot.look) void this.bot.look(yaw, pitch, true);
  }
  subscribePhysicsTick(listener: () => void): () => void {
    this.bot.on("physicsTick", listener);
    return () => this.bot.off("physicsTick", listener);
  }
  clearOwnedControls() {
    for (const control of this.#controls) this.bot.setControlState(control, false);
    this.#controls.clear();
  }
  holdPosition(world: WorldView): () => void {
    const start = this.movementSnapshot();
    const footing = new SupportedPositionController(world, start);
    const hold = () => {
      const snapshot = this.movementSnapshot();
      if (snapshot.isInWater) {
          // An admitted dive holds depth through search; ordinary water holds rise.
        const correction = horizontalControlsToward(
          { position: snapshot.position, yaw: snapshot.yaw },
          start.position,
          0.05,
        );
        for (const control of ["forward", "back", "left", "right"] as const)
          this.#control(control, correction[control]);
        this.#control("sneak", false);
        this.#control("jump", this.ownsDive()
          ? (start.onGround && snapshot.position.y >= start.position.y - 0.05 ? false :
            holdSwimDepth(snapshot.position.y, snapshot.velocity.y, start.position.y))
          : true);
        return;
      }
      // On dry footing the controller resolves its own correction into
      // strafing inputs against the current heading.
      const step = footing.advance(snapshot);
      const controls = step.kind === "running" ? step.controls : releasedControls;
      for (const control of ["forward", "back", "left", "right", "sneak"] as const)
        this.#control(control, controls[control]);
      this.#control("jump", false);
    };
    // Search can outlive a knockback arc. Its hold must own dry footing too,
    // not only water, while preserving the caller's look direction. Release
    // ends this ownership; cancellation may still need a controlled landing.
    this.bot.on("physicsTick", hold);
    return () => {
      this.bot.off("physicsTick", hold);
      for (const control of ["forward", "back", "left", "right", "sneak", "jump"] as const)
        this.#control(control, false);
    };
  }
  /** Run navigation's local steering driver without exposing Mineflayer control mechanics. */
  steer(request: HorizontalSteeringRequest): Promise<HorizontalSteeringOutcome> {
    return driveHorizontalSteering(this.#steeringPort(), request);
  }
  #steeringPort(): HorizontalSteeringPort {
    return steeringPortFor(this.bot, (control, state) => this.#control(control, state));
  }
  async centerOnCell(position: Position3, signal: AbortSignal): Promise<boolean> {
    return centerOnCell(this.#steeringPort(), position, signal);
  }
  async #moveClearOfCell(position: Position3, signal: AbortSignal): Promise<boolean> {
    const overlaps = () => {
      const current = this.bot.entity.position;
      return (
        current.x + PLAYER_HALF_WIDTH > position.x &&
        current.x - PLAYER_HALF_WIDTH < position.x + 1 &&
        current.z + PLAYER_HALF_WIDTH > position.z &&
        current.z - PLAYER_HALF_WIDTH < position.z + 1
      );
    };
    if (!overlaps()) return true;
    const feet = blockPosition(this.bot.entity.position);
    const center = { x: feet.x + 0.5, y: this.bot.entity.position.y, z: feet.z + 0.5 };
    return (
      (
        await this.steer({
          target: () => center,
          arrived: () => !overlaps(),
          maximumTicks: 20,
          signal,
        })
      ).kind === "arrived"
    );
  }
  async prepareMovement(
    step: PlannedStep,
    _token: AttemptToken,
    signal: AbortSignal,
    execution: MovementExecution,
    snapshot: () => MovementSnapshot,
  ): Promise<MovementPreparation> {
    if (step.kind === "bucket_drop") {
      const completed = await this.bot.bucketDrop?.(step.to, signal);
      return completed ? { kind: "completed", arrival: step.to } : { kind: "failed", observation: "The planned bucket drop did not confirm landing and water recovery." };
    }
    if (this.ownsDive() && (this.bot.blockAt({ ...step.to, y: step.to.y + 1 }) as MineflayerBlock | null)?.name === "water") {
      const support = this.bot.blockAt({ ...step.to, y: step.to.y - 1 }) as MineflayerBlock | null;
      execution = { ...execution, swimDepth: step.to.y + (support?.boundingBox === "block" ? 0 : 0.2),
        swimGrounded: support?.boundingBox === "block" };
    }
    const targetCell = step.to;
    const initialCell = navigationFeet(this.bot.entity.position, this.bot.entity.onGround);
    if (
      (step.kind === "pillar" || step.kind === "downward") &&
      initialCell.x === targetCell.x &&
      initialCell.y === targetCell.y &&
      initialCell.z === targetCell.z &&
      (this.bot.entity.onGround || (this.bot.entity.isInWater && execution.swimDepth === undefined))
    ) {
      return { kind: "completed", arrival: targetCell } as const;
    }
    const observedBeforeAlignment = this.bot.entity.position;
    const startCell = blockPosition(observedBeforeAlignment);
    const startCenter = { x: startCell.x + 0.5, y: observedBeforeAlignment.y, z: startCell.z + 0.5 };
    const incoming = snapshot();
    const dx = step.to.x - step.from.x;
    const dz = step.to.z - step.from.z;
    const length = Math.hypot(dx, dz);
    const lateralCoast =
      length === 0
        ? 0
        : ((incoming.position.x - startCenter.x + incoming.velocity.x * AIR_COAST_TICKS) * -dz +
            (incoming.position.z - startCenter.z + incoming.velocity.z * AIR_COAST_TICKS) * dx) /
          length;
    if (
      step.kind === "step_up" &&
      length > 0 &&
      incoming.onGround &&
      (Math.abs(lateralCoast) > 0.5 - PLAYER_HALF_WIDTH ||
        (execution.end === "settled" &&
          Math.hypot(observedBeforeAlignment.x - startCenter.x, observedBeforeAlignment.z - startCenter.z) > 0.2))
    ) {
      // Jumping removes ground friction. Request 205 turned west with residual
      // northward speed and brushed lava on its very first airborne tick.
      // Cancel cross-corridor momentum on the tread before committing the jump;
      // forward momentum can still pass through a continuous straight ascent.
      const aligned = () => {
        const now = snapshot();
        return (
          now.onGround &&
          Math.hypot(
            now.position.x + now.velocity.x * COAST_TICKS - startCenter.x,
            now.position.z + now.velocity.z * COAST_TICKS - startCenter.z,
          ) <=
            0.5 - PLAYER_HALF_WIDTH &&
          Math.hypot(now.velocity.x, now.velocity.z) <= 0.03
        );
      };
      // Use the route's existing velocity sample even on the first tick. The
      // generic centering loop starts with no displacement history; releasing
      // input for that tick let the recorded body coast into the stream.
      // One second detects a blocked correction before this preparation can
      // retain the route indefinitely; failure asks navigation to reassess.
      try {
        for (let tick = 0; tick < 20 && !aligned(); tick++) {
          this.applyMovementControls(recenterControls(snapshot(), startCenter, 0.5 - PLAYER_HALF_WIDTH));
          await waitForPhysicsTicks(this.bot, 1, signal);
        }
      } finally {
        this.clearOwnedControls();
      }
      if (!aligned())
        return {
          kind: "failed",
          observation: "Could not settle the step-up's lateral momentum inside its takeoff cell.",
        };
    }
    // The route samples movement once per physics tick. Reuse that observation
    // at a controller handoff: taking a second displacement sample in the same
    // tick reports zero and makes inherited momentum look like rest.
    const controller = createMovementController(
      step,
      snapshot(),
      {
        ...execution,
        ...this.#gapTakeoff(step),
        ...(step.kind === "step_up" ? { stepUpHeadBonkClear: this.#stepUpHeadBonkClear(step) } : {}),
      },
      this.#waterRise(step),
    );
    // A movement that stays in its own column has no heading to face. Its aim
    // sits directly above or below the bot, so `lookAt` resolves a yaw from a
    // near-zero horizontal vector and snaps to an arbitrary one — once per
    // block of a shaft, which is the spin. Baritone holds the current yaw
    // through `MovementDownward` for the same reason. A centre the body has
    // already reached or passed has no heading to offer either: looking at it
    // from behind turned the bot around at every overshot handoff. Keep
    // whatever heading the last movement left behind in both cases.
    const headingX = step.to.x - step.from.x;
    const headingZ = step.to.z - step.from.z;
    const headingLength = Math.hypot(headingX, headingZ);
    if (headingLength > 0) {
      const { position } = this.bot.entity;
      const ahead =
        ((controller.aim.x - position.x) * headingX + (controller.aim.z - position.z) * headingZ) / headingLength;
      if (ahead > PLAYER_HALF_WIDTH)
        await this.bot.lookAt(new Vec3(controller.aim.x, controller.aim.y, controller.aim.z), true);
    }
    if (step.kind === "drop") this.#control("sneak", false);
    return { kind: "ready", controller } as const;
  }
  /**
   * Aim at a block directly beneath the feet: keep the current yaw and pitch
   * straight down.
   *
   * Mineflayer's own aim cannot work there. It looks at the block centre, and
   * for a cell directly below the bot the horizontal component of that vector
   * is ~0, so the yaw it derives is whatever sub-block residue happens to
   * exist — a different arbitrary heading on every dig and every pillar
   * block, which reads as the bot spinning on the spot. Centring the bot
   * better makes it worse, because the residue gets smaller.
   *
   * Baritone's MovementDownward answers this with
   * `new Rotation(ctx.player().getYaw(), 90.0F)`: keep the current yaw, force
   * the pitch straight down, never recompute a yaw that has no meaning.
   * Mineflayer's pitch is `atan2(dy, horizontal)`, so straight down is
   * negative. False when the surface cannot set an absolute rotation.
   *
   * The same aim, straight up, breaks the block a held body is under: its eye
   * is inside that block's box, so no face of it is in view (see
   * `overhead-pin.ts`), and `visibleDigAim` would report nothing to aim at.
   */
  async #aimVertical(pitch: number, yaw = this.bot.entity.yaw): Promise<boolean> {
    if (!this.bot.look || yaw === undefined) return false;
    await this.bot.look(yaw, pitch, true);
    return true;
  }
  describeMovementFailure(step: PlannedStep): string {
    const target = step.operations.find(
      (operation): operation is Extract<PlannedOperation, { kind: "move" }> => operation.kind === "move",
    )!.target;
    const final = this.bot.entity.position;
    const { yaw, pitch } = this.bot.entity;
    const feetBlock = this.bot.blockAt(new Vec3(step.to.x, step.to.y, step.to.z)) as {
      readonly name?: string;
      readonly stateId?: number;
    } | null;
    const headBlock = this.bot.blockAt(new Vec3(step.to.x, step.to.y + 1, step.to.z)) as {
      readonly name?: string;
      readonly stateId?: number;
    } | null;
    const observedBlock = (block: { readonly name?: string; readonly stateId?: number } | null) =>
      block ? `${block.name ?? "unknown"}#${block.stateId ?? "unknown"}` : "unloaded";
    return (
      `No observed settled arrival at ${target.x},${target.y},${target.z}; ` +
      `last position ${final.x.toFixed(2)},${final.y.toFixed(2)},${final.z.toFixed(2)}, ` +
      `onGround=${this.bot.entity.onGround}, inWater=${this.bot.entity.isInWater}; ` +
      // Facing is the difference between "did not arrive" and "arrived facing
      // the wrong way after crossing the target and turning back".
      `${yaw === undefined ? "" : `yaw=${((yaw * 180) / Math.PI).toFixed(0)}deg, `}` +
      `${pitch === undefined ? "" : `pitch=${((pitch * 180) / Math.PI).toFixed(0)}deg, `}` +
      `target feet=${observedBlock(feetBlock)}, head=${observedBlock(headBlock)}.`
    );
  }
  /** The block that lands in `position` within two seconds of a break, or null when nothing does. */
  async #awaitRefill(position: BlockPosition, signal: AbortSignal): Promise<{ readonly block: unknown } | null> {
    for (let tick = 0; tick < 40; tick += 1) {
      signal.throwIfAborted();
      await this.bot.waitForTicks(1);
      const block = this.bot.blockAt(position);
      const name = blockName(block);
      if (name !== null && !name.endsWith("air")) return { block };
    }
    return null;
  }

  startEffect(
    operation: Exclude<PlannedOperation, { kind: "move" }>,
    _token: AttemptToken,
    signal: AbortSignal,
  ): EffectHandle {
    let issued = false;
    let cancelled = false;
    const completion = (async () => {
      try {
        signal.throwIfAborted();
        if (operation.kind === "break") {
          const feet = navigationFeet(this.bot.entity.position, this.bot.entity.onGround);
          const directlyBelowFeet =
            operation.position.x === feet.x && operation.position.y === feet.y - 1 && operation.position.z === feet.z;
          // Baritone centres before downward excavation, but begins digging
          // after its centring window even if the exact tolerance was not met.
          // The observed landing, not this steering hint, decides success.
          const body = blockPosition(this.bot.entity.position);
          const directlyAboveHead =
            operation.position.x === body.x && operation.position.z === body.z && operation.position.y > body.y;
          if (directlyBelowFeet) await this.centerOnCell(feet, signal);
          const block = this.bot.blockAt(new Vec3(operation.position.x, operation.position.y, operation.position.z));
          if (!block) return { kind: "failed", observation: "Break target was not loaded." } as const;
          if (operation.toolType !== null) {
            const item = this.bot.inventory.items().find((candidate) => candidate.type === operation.toolType);
            // The route was priced at tool speed. Hand-digging it instead is
            // several times slower, so the confirmation window elapses and the
            // failure is reported as a timeout — blaming the clock for an
            // inventory fact. Say what is actually missing.
            if (!item)
              return {
                kind: "failed",
                observation: `The route planned to break with ${this.bot.itemName?.(operation.toolType) ?? `item type ${operation.toolType}`}, which is not in the inventory.`,
              } as const;
            await this.bot.equip(item, "hand");
          }
          signal.throwIfAborted();
          this.selectedTool()?.(operation.toolType);
          issued = true;
          // Read before the hold so the dig aims where the route left the head.
          const yaw = this.bot.entity.yaw;
          const digStartedAt = Date.now();
          const airborne = !this.bot.entity.onGround;
          const inWater = this.bot.entity.isInWater;
          const releaseStance = holdWaterPosition(this.bot, signal, (control, active) =>
            this.#control(control, active),
          );
          try {
            const swing = async (target: unknown) => {
              if (
                (directlyBelowFeet || directlyAboveHead) &&
                (await this.#aimVertical(directlyBelowFeet ? -Math.PI / 2 : Math.PI / 2, yaw))
              ) {
                await this.bot.dig(target, "ignore");
                return null;
              }
              const aim = this.bot.visibleDigAim(operation.position);
              if (aim === null) {
                const { x, y, z } = this.bot.entity.position;
                return {
                  kind: "failed",
                  observation:
                    `No face of the block at ${blockLabel(operation.position)} is in view from ` +
                    `${x.toFixed(2)},${y.toFixed(2)},${z.toFixed(2)}.`,
                } as const;
              }
              await this.bot.lookAt(new Vec3(aim.x, aim.y, aim.z), true);
              await this.bot.dig(target, "ignore");
              return null;
            };
            const first = await swing(block);
            if (first) return first;
            // The falling column above lands in the cell once the block is
            // gone. Baritone's `pauseMiningForFallingBlocks` waits for the
            // entities and breaks what they leave. Moving on before they land
            // walked the sand-curtain bot through the cell as the sand fell in
            // behind it, and a tick slower would have buried it.
            for (let landed = 0; landed < operation.brings.length; landed += 1) {
              const refilled = await this.#awaitRefill(operation.position, signal);
              if (refilled === null) break;
              const again = await swing(refilled.block);
              if (again) return again;
            }
          } finally {
            releaseStance();
            traceDig({
              position: operation.position,
              belowFeet: directlyBelowFeet,
              airborne,
              inWater,
              toolType: operation.toolType,
              elapsedMs: Date.now() - digStartedAt,
            });
          }
        } else if (operation.kind === "place") {
          const item = this.bot.inventory.items().find((candidate) => candidate.type === operation.placement.itemType);
          const support = this.bot.blockAt(
            new Vec3(operation.placement.support.x, operation.placement.support.y, operation.placement.support.z),
          );
          if (!item) return { kind: "failed", observation: "The planned placement item was unavailable." } as const;
          if (!support)
            return { kind: "failed", observation: "The planned placement support was unavailable." } as const;
          await this.bot.equip(item, "hand");
          signal.throwIfAborted();
          const feet = navigationFeet(this.bot.entity.position, this.bot.entity.onGround);
          const pillar =
            feet.x === operation.placement.position.x &&
            feet.y === operation.placement.position.y &&
            feet.z === operation.placement.position.z;
          const placementTarget = new Vec3(
            operation.placement.support.x + 0.5 + operation.placement.face.x * 0.5,
            operation.placement.support.y + 0.5 + operation.placement.face.y * 0.5,
            operation.placement.support.z + 0.5 + operation.placement.face.z * 0.5,
          );
          if (pillar) {
            if (!(await this.centerOnCell(operation.placement.position, signal)))
              return { kind: "failed", observation: "The bot could not center over its pillar cell." } as const;
            let roseAbovePlacement = false;
            let highestY = this.bot.entity.position.y;
            this.#control("sneak", true);
            try {
              await this.bot.waitForTicks(1);
              // The support's top face is directly beneath the feet, so its
              // yaw is as meaningless as a straight-down dig's.
              if (!(await this.#aimVertical(-Math.PI / 2))) await this.bot.lookAt(placementTarget, true);
              this.#control("jump", true);
              for (let tick = 0; tick < 20; tick += 1) {
                signal.throwIfAborted();
                await this.bot.waitForTicks(1);
                highestY = Math.max(highestY, this.bot.entity.position.y);
                if (this.bot.entity.position.y > operation.placement.position.y + 1.1) {
                  roseAbovePlacement = true;
                  break;
                }
              }
              if (!roseAbovePlacement)
                return {
                  kind: "failed",
                  observation: `The bot did not rise far enough to place beneath itself; peak y=${highestY.toFixed(2)}.`,
                } as const;
              const obstacle = this.bot.placementObstacle(operation.placement.position);
              if (obstacle) return { kind: "failed", observation: obstacle } as const;
              issued = true;
              await this.bot.placeBlock(
                support,
                new Vec3(operation.placement.face.x, operation.placement.face.y, operation.placement.face.z),
              );
            } finally {
              this.#control("jump", false);
              this.#control("sneak", false);
            }
          } else {
            const adjacentFeetPlacement =
              feet.y === operation.placement.position.y &&
              (feet.x !== operation.placement.position.x || feet.z !== operation.placement.position.z);
            if (adjacentFeetPlacement && !(await this.#moveClearOfCell(operation.placement.position, signal)))
              return {
                kind: "failed",
                observation: "The bot could not move clear of the adjacent placement cell.",
              } as const;
            await this.bot.lookAt(placementTarget, true);
            const obstacle = this.bot.placementObstacle(operation.placement.position);
            if (obstacle) return { kind: "failed", observation: obstacle } as const;
            issued = true;
            await this.bot.placeBlock(
              support,
              new Vec3(operation.placement.face.x, operation.placement.face.y, operation.placement.face.z),
            );
          }
        } else {
          const block = this.bot.blockAt(new Vec3(operation.position.x, operation.position.y, operation.position.z));
          if (!block) return { kind: "failed", observation: "Activation target was not loaded." } as const;
          issued = true;
          await this.bot.activateBlock(block);
        }
        if (!cancelled && operation.kind === "place") this.bot.combatResourceReceipt?.();
        return cancelled
          ? ({ kind: "failed", observation: "Completion arrived after cancellation." } as const)
          : ({ kind: "accepted" } as const);
      } catch (cause) {
        return { kind: "failed", observation: cause instanceof Error ? cause.message : String(cause) } as const;
      }
    })();
    return {
      completion,
      get issued() {
        return issued;
      },
      cancel: () => {
        cancelled = true;
        if (operation.kind === "break" && issued) this.bot.stopDigging();
      },
    };
  }
  async stabilize(signal: AbortSignal) {
    for (let tick = 0; tick < 20; tick += 1) {
      signal.throwIfAborted();
      await waitForPhysicsTicks(this.bot, 1, signal);
      const observation = this.observe();
      if (observation.stance !== "airborne") return { kind: "stable" } as const;
    }
    const observation = this.observe();
    return {
      kind: "failed",
      observation:
        `No stable stance was observed; last position ` +
        `${observation.position.x.toFixed(2)},${observation.position.y.toFixed(2)},${observation.position.z.toFixed(2)}, ` +
        `stance=${observation.stance}.`,
    } as const;
  }
}
