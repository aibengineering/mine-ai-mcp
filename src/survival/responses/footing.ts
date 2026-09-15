import { bucketAvailable, predictWaterLanding, saveWaterLanding, waterLandingActive, type WaterLandingEvidence } from "../../navigation/mineflayer/water-landing.js";
import { readNavigationPolicy } from "../state/navigation-policy.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { z } from "zod";
import { horizontalControlsToward } from "../../navigation/index.js";
import { preferredScaffoldItem } from "../../navigation/mineflayer/movement-policy.js";
import {
  canReleaseOnObservedGround,
  isSafeSupport,
  safeSupportingCell,
} from "../../navigation/world/block-geometry.js";
import type { BlockPosition, Position3, WorldView } from "../../navigation/world/world.js";
import { isReplaceableForPlacement } from "../../world/block-classification.js";
import { observedEyeHeight } from "../../world/block-visibility.js";
import { findPlacementSupport, occupiedCell, placeBlock, type BlockPlacementResult } from "../../world/placement.js";
import { lowerImpulseLanding, projectedFooting } from "../positioning/footing.js";

const impulseSchema = z.object({
  entityId: z.number(),
  velocity: z.object({
    x: z.number().int().min(-32768).max(32767),
    y: z.number().int().min(-32768).max(32767),
    z: z.number().int().min(-32768).max(32767),
  }),
});

export interface FootingRecoverySnapshot {
  readonly phase: "pending" | "steering" | "placing" | "landed" | "failed" | "cancelled";
  readonly support: BlockPosition;
  readonly impulse: Position3;
  readonly startedAt: number;
  readonly placement: {
    readonly cell: BlockPosition;
    readonly result: BlockPlacementResult["kind"] | "pending";
    readonly error?: string;
  } | null;
  readonly water?: WaterLandingEvidence;
  readonly reason?: string;
}

/** Remembers support across owners; only recover() is allowed to drive the body. */
export class FootingRecovery implements Disposable {
  #support: BlockPosition | null = null;
  #state: FootingRecoverySnapshot | null = null;
  #running = false;
  #peakY = -Infinity;
  #body = new AbortController();

  constructor(
    private readonly bot: Bot,
    private readonly world: WorldView,
  ) {
    this.#observe();
    bot.on("physicsTick", this.#observe);
    bot.on("respawn", this.#reset);
    bot.on("death", this.#reset);
    bot._client.on("entity_velocity", this.#impulse);
  }

  get needed(): boolean {
    return !waterLandingActive(this.bot) && (this.#state?.phase === "pending" || this.bucketNeeded);
  }

  get bucketNeeded(): boolean {
    if (
      waterLandingActive(this.bot) || !readNavigationPolicy(this.bot).bucket_fall_save || !bucketAvailable(this.bot) ||
      this.bot.entity.onGround || this.bot.entity.velocity.y >= -0.1 ||
      Reflect.get(this.bot.entity, "isInWater") || Reflect.get(this.bot.entity, "isInLava")
    ) return false;
    const landing = predictWaterLanding(this.bot.entity.position, this.bot.entity.velocity, this.world);
    return landing !== null && Math.max(this.#peakY, this.bot.entity.position.y) - landing.cell.y > 3;
  }

  get active(): boolean {
    return this.#running;
  }

  snapshot(): FootingRecoverySnapshot | null {
    return this.#state;
  }

  readonly #reset = () => {
    this.#body.abort("The body died or respawned during footing recovery.");
    this.#body = new AbortController();
    this.#support = null;
    this.#peakY = -Infinity;
    if (!this.#running) this.#state = null;
  };

  readonly #observe = () => {
    if (!this.bot.entity.onGround) {
      this.#peakY = Math.max(this.#peakY, this.bot.entity.position.y);
      return;
    }
    this.#peakY = this.bot.entity.position.y;
    const support = safeSupportingCell(this.world, this.bot.entity.position);
    // A grounded body can overlap the lava beside its last scaffold. That
    // unsafe observation must not erase the last known landing to recover to.
    if (support) this.#support = support;
  };

  readonly #impulse = (packet: unknown) => {
    const parsed = impulseSchema.safeParse(packet);
    if (!parsed.success || parsed.data.entityId !== this.bot.entity.id || !this.#support || this.bot.health <= 0)
      return;
    if (
      this.#running ||
      this.needed ||
      Reflect.get(this.bot.entity, "isInWater") ||
      Reflect.get(this.bot.entity, "isInLava")
    )
      return;
    if (this.bot.entity.position.y < this.#support.y) return;
    const raw = parsed.data.velocity;
    const impulse = { x: raw.x / 8000, y: raw.y / 8000, z: raw.z / 8000 };
    if (Math.hypot(impulse.x, impulse.z) === 0) return;
    const landing = projectedFooting(this.bot.entity.position, impulse, this.#support.y);
    if (canReleaseOnObservedGround(this.world, { position: landing, velocity: impulse, onGround: true })) return;
    this.#state = { phase: "pending", support: { ...this.#support }, impulse, startedAt: Date.now(), placement: null };
  };

  /** One exclusive owner corrects movement and, if needed, extends the nearby floor. */
  async recover(parentSignal: AbortSignal, protect?: () => Promise<void>): Promise<"landed" | "failed"> {
    if (this.bucketNeeded && !this.#running) return this.#recoverWater(parentSignal);
    const initial = this.#state;
    if (!initial || !this.needed || this.#running)
      throw new Error("Footing recovery requires one pending impulse and one body owner.");
    const signal = AbortSignal.any([parentSignal, this.#body.signal]);
    signal.throwIfAborted();
    const heldItemName = this.bot.heldItem?.name;
    this.#running = true;
    this.#state = { ...initial, phase: "steering" };
    const attempted = new Set<string>();
    let landingSupport = initial.support;
    const steer = () => {
      const target = { x: landingSupport.x + 0.5, y: landingSupport.y, z: landingSupport.z + 0.5 };
      const controls = horizontalControlsToward(this.bot.entity, target, 0.05);
      for (const control of ["forward", "back", "left", "right"] as const)
        this.bot.setControlState(control, controls[control]);
      this.bot.setControlState("jump", false);
      this.bot.setControlState("sprint", false);
      this.bot.setControlState("sneak", false);
    };
    this.bot.on("physicsTick", steer);
    try {
      if (protect) await protect();
      else this.bot.deactivateItem();
      steer();
      // The velocity packet can precede the physics tick that leaves the floor.
      await this.bot.waitForTicks(1);
      while (this.bot.health > 0) {
        signal.throwIfAborted();
        if (canReleaseOnObservedGround(this.world, this.bot.entity)) {
          this.#state = { ...this.#state!, phase: "landed" };
          return "landed";
        }
        if (this.bucketNeeded) {
          this.bot.off("physicsTick", steer);
          return await this.#recoverWater(signal);
        }
        const position = this.bot.entity.position;
        if (
          Reflect.get(this.bot.entity, "isInLava") ||
          Reflect.get(this.bot.entity, "isInWater")
        )
          break;
        if (position.y < landingSupport.y) {
          const lower = lowerImpulseLanding(this.world, position, this.bot.entity.velocity, initial.support.y);
          if (!lower) break;
          landingSupport = lower;
        }
        if (protect) await protect();
        const landing = projectedFooting(position, this.bot.entity.velocity, landingSupport.y);
        const cell = { x: Math.floor(landing.x), y: landingSupport.y - 1, z: Math.floor(landing.z) };
        // Place the first missing cell along the outgoing flight, so each new
        // block has a real attachment face even when the landing is two cells out.
        const distance = Math.hypot(landing.x - position.x, landing.z - position.z);
        const samples = Math.max(1, Math.ceil(distance * 4));
        for (let step = 0; step <= samples; step++) {
          cell.x = Math.floor(position.x + ((landing.x - position.x) * step) / samples);
          cell.z = Math.floor(position.z + ((landing.z - position.z) * step) / samples);
          if (isSafeSupport(this.world.blockAt(cell.x, cell.y, cell.z))) continue;
          const key = `${cell.x},${cell.y},${cell.z}`;
          if (attempted.has(key)) continue;
          const block = this.bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
          const support = findPlacementSupport(this.bot, cell);
          const item = preferredScaffoldItem(this.bot);
          if (!block || !isReplaceableForPlacement(block) || !support || !item || occupiedCell(this.bot, cell))
            continue;
          const face = support.support.position.offset(
            0.5 + support.face.x / 2,
            0.5 + support.face.y / 2,
            0.5 + support.face.z / 2,
          );
          if (face.distanceTo(position.offset(0, observedEyeHeight(this.bot.entity), 0)) > 4.5) continue;
          attempted.add(key);
          this.#state = { ...this.#state!, phase: "placing", placement: { cell: { ...cell }, result: "pending" } };
          const result = await placeBlock(this.bot, {
            item,
            ...support,
            expectedCells: [{ ...cell }],
            signal,
            matches: (placed) => placed.name === item.name,
          });
          this.#state = {
            ...this.#state!,
            phase: "steering",
            placement: {
              cell: { ...cell },
              result: result.kind,
              ...(result.kind === "failed" && { error: result.error }),
            },
          };
          break;
        }
        await this.bot.waitForTicks(1);
      }
      this.#state = {
        ...this.#state!,
        phase: "failed",
        reason: "No observed catching floor near the original support, or the body entered fluid.",
      };
      return "failed";
    } catch (cause) {
      this.#state = {
        ...this.#state!,
        phase: signal.aborted ? "cancelled" : "failed",
        reason: String(signal.aborted ? signal.reason : cause),
      };
      throw cause;
    } finally {
      this.bot.off("physicsTick", steer);
      this.#running = false;
      this.bot.clearControlStates();
      if (!signal.aborted && this.bot.health > 0 && heldItemName && this.bot.heldItem?.name !== heldItemName) {
        const item = this.bot.inventory.items().find((item) => item.name === heldItemName);
        if (item) await this.bot.equip(item, "hand");
      }
    }
  }

  async #recoverWater(signal: AbortSignal): Promise<"landed" | "failed"> {
    const support = this.#support ?? { x: Math.floor(this.bot.entity.position.x), y: Math.floor(this.bot.entity.position.y), z: Math.floor(this.bot.entity.position.z) };
    this.#state = { phase: "steering", support, impulse: { ...this.bot.entity.velocity }, startedAt: Date.now(), placement: null };
    this.#running = true;
    try {
      const result = await saveWaterLanding(this.bot, {
        signal: AbortSignal.any([signal, this.#body.signal]),
        permitted: () => readNavigationPolicy(this.bot).bucket_fall_save,
        observe: water => { this.#state = { ...this.#state!, water }; },
      });
      this.#state = { ...this.#state!, phase: result.waterRecovered ? "landed" : "failed", water: result };
      return result.waterRecovered ? "landed" : "failed";
    } catch (cause) {
      this.#state = { ...this.#state!, phase: signal.aborted ? "cancelled" : "failed", reason: String(cause) };
      throw cause;
    } finally {
      this.#running = false;
    }
  }

  [Symbol.dispose](): void {
    this.#body.abort("Footing recovery closed");
    this.bot.off("physicsTick", this.#observe);
    this.bot.off("respawn", this.#reset);
    this.bot.off("death", this.#reset);
    this.bot._client.off("entity_velocity", this.#impulse);
  }
}
