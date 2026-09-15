import type { Bot } from "mineflayer";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { SupportedPositionController } from "../execution/supported-position-controller.js";
import { setSneaking } from "../mineflayer/sneak.js";
import type { WorldView } from "../world/world.js";

/** Apply navigation's stationary controller while another action owns looking. */
export class SupportedPositionHold {
  readonly #controller: SupportedPositionController;
  #active = true;
  #driving = false;
  /** Null until the first tick writes, so the hold's first word to the server clears whatever it believed. */
  #sneaking: boolean | null = null;

  constructor(
    private readonly bot: Bot,
    world: WorldView,
  ) {
    this.#controller = new SupportedPositionController(world, this.#snapshot());
  }

  get active(): boolean {
    return this.#active;
  }

  #snapshot() {
    return {
      position: this.bot.entity.position,
      velocity: this.bot.entity.velocity,
      onGround: this.bot.entity.onGround,
      isInWater: Reflect.get(this.bot.entity, "isInWater") === true,
      climbing: Reflect.get(this.bot.entity, "isOnLadder") === true,
      yaw: this.bot.entity.yaw,
    };
  }

  start(): void {
    this.#active = true;
  }

  tick(): void {
    // Observe support even while a route owns the controls. A search can fail
    // during knockback before it creates a movement controller of its own.
    const step = this.#controller.advance(this.#snapshot());
    if (!this.#active) return;
    if (step.kind !== "running") {
      this.#clearControls();
      return;
    }
    this.#driving = true;
    // The controller resolves its own correction into strafing inputs against
    // the heading the other action holds; nothing here turns the head.
    for (const control of ["forward", "back", "left", "right"] as const)
      this.bot.setControlState(control, step.controls[control]);
    this.bot.setControlState("sprint", false);
    // The crouch reaches the server too, so an attack landed during the
    // correction does not leave the body crouched once it is centred.
    if (step.controls.sneak !== this.#sneaking) {
      this.#sneaking = step.controls.sneak;
      setSneaking(this.bot, this.#sneaking);
    }
  }

  /** Relinquish only once the movement controller accepts the physical handoff. */
  async stop(signal?: AbortSignal): Promise<void> {
    try {
      while (this.#active && this.bot.health > 0 && !Reflect.get(this.bot.entity, "isInLava")) {
        if (signal?.aborted) return;
        if (this.#controller.cancel(this.#snapshot()) === "stopped") return;
        const step = this.#controller.advance(this.#snapshot());
        if (step.kind !== "running") return;
        this.tick();
        if (signal) {
          try {
            await waitForPhysicsTicks(this.bot, 1, signal);
          } catch (cause) {
            if (!signal.aborted) throw cause;
          }
        } else await this.bot.waitForTicks(1);
      }
    } finally {
      this.release();
    }
  }

  /** Connection teardown can invalidate the body instead of landing it. */
  release(): void {
    this.#active = false;
    this.#clearControls();
  }

  #clearControls(): void {
    if (!this.#driving) return;
    this.#driving = false;
    this.#sneaking = null;
    for (const control of ["forward", "back", "left", "right"] as const) this.bot.setControlState(control, false);
    // Always sent: the server may believe the body crouched whatever this hold last wrote.
    setSneaking(this.bot, false);
  }
}
