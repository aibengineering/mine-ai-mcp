import type { Bot } from "mineflayer";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { recordCombatResourceReceipt } from "../../runtime/combat-resource-receipts.js";

/** A vanilla shield blocks only after five ticks of use. */
export const SHIELD_READY_TICKS = 5;

interface BowDraw extends Disposable {
  release(): void;
}

/** One engagement's commanded item use. Target and weapon decisions stay with the controller. */
export class CombatItemUse {
  #posture: "idle" | "shield" | "drawing" = "idle";
  readonly #bot: Bot;
  readonly #holdFacing: (ticks: number) => Promise<void>;

  constructor(bot: Bot, holdFacing: (ticks: number) => Promise<void>,
    private readonly trace: (event: { stage: string; posture: string; usingHeldItem: boolean }) => void = () => {}) {
    this.#bot = bot;
    this.#holdFacing = holdFacing;
  }
  private record(stage: string): void {
    this.trace({ stage, posture: this.#posture, usingHeldItem: this.#bot.usingHeldItem });
  }

  get shieldRaised(): boolean {
    return this.#posture === "shield";
  }
  get drawingBow(): boolean { return this.#posture === "drawing"; }

  /** Navigation can change slots or use an item; its return does not prove our old guard survived. */
  invalidateShield(): void {
    if (this.#posture === "shield") this.#posture = "idle";
    this.record("shield_invalidated");
  }

  async raiseShield(): Promise<void> {
    if (this.shieldRaised) { this.record("shield_activation_skipped"); return; }
    this.#cancelDraw();
    this.activateShield();
    await this.#holdFacing(SHIELD_READY_TICKS);
  }

  /** One owner for shield readiness and waiting; the caller assesses geometry and its own lifecycle. */
  async guardUntil<Outcome>(assess: () => Outcome | null): Promise<Outcome> {
    await this.raiseShield();
    for (;;) {
      const outcome = assess();
      if (outcome !== null) return outcome;
      await this.#holdFacing(1);
    }
  }

  /** Reassert off-hand use after a swing without paying readiness again. */
  activateShield(): void {
    this.#bot.activateItem(true);
    this.#posture = "shield";
    this.record("shield_activated");
  }

  lowerShield(): void {
    this.#bot.deactivateItem();
    this.#posture = "idle";
    this.record("shield_lowered");
  }

  /** Leaving the draw's scope without releasing an arrow cancels it. */
  drawBow(): BowDraw {
    this.#cancelDraw();
    // Invalidating local posture does not release server-side shield use.
    // End that use before requesting the other hand, or vanilla ignores the draw.
    this.lowerShield();
    this.#bot.activateItem();
    this.#posture = "drawing";
    this.record("bow_draw_started");
    return {
      release: () => {
        this.#bot.deactivateItem();
        recordCombatResourceReceipt(this.#bot, { kind: "arrow_release_command" });
        this.#posture = "idle";
        this.record("bow_released");
      },
      [Symbol.dispose]: () => this.#cancelDraw(),
    };
  }

  #cancelDraw(): void {
    if (this.#posture !== "drawing") return;
    // Changing slots cancels a bow draw; releasing use would fire it.
    const slot = this.#bot.quickBarSlot;
    this.#bot.setQuickBarSlot((slot + 1) % 9);
    this.#bot.setQuickBarSlot(slot);
    this.#posture = "idle";
    this.record("bow_cancelled");
  }

  /** Settle controls and repeat release after a tick, as the existing cleanup requires. */
  async neutralise(settleMovement: () => Promise<void>, ownerSignal: AbortSignal): Promise<void> {
    try {
      this.#cancelDraw();
      this.lowerShield();
    } finally {
      try {
        try {
          await waitForPhysicsTicks(this.#bot, 1, ownerSignal);
        } catch (cause) {
          if (!ownerSignal.aborted) throw cause;
        }
        this.lowerShield();
      } finally {
        // A health cancellation can precede the same hit's velocity packet.
        // Finish item release, then the landing, then relinquish controls.
        // There must be no awaited cleanup after the physical handoff.
        try {
          await settleMovement();
        } finally {
          this.#bot.clearControlStates();
        }
      }
    }
  }
}
