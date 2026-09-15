import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { dragonPhase, entityHealth, isDragonLanding, isDragonPerched } from "../../../world/end-fight.js";

/** One requested perch window, including the ticks spent under a reflex. */
export class PerchObservation implements Disposable {
  readonly dimension: string;
  readonly healthBefore: number | null;
  readonly target: Parameters<Bot["attack"]>[0] | undefined;
  entered = false;
  landingObserved = false;
  ended = false;
  handoffComplete = false;
  died = false;
  attacks = 0;
  preparationTarget: Vec3 | null = null;
  preparedPosition: Vec3 | null = null;
  preparationDamaged = false;
  stage: "waiting" | "preparing" | "ready" | "approaching_head" | "attacking" | "withdrawing" = "waiting";
  private blocker: string | null = null;
  private lastAttackBlocker: string | null = null;
  private readonly startedAt = Date.now();
  private firstDamageMs: number | null = null;
  private firstDamageInPerchMs: number | null = null;
  private perchStartedAt: number | null = null;
  private confirmedDamage = 0;
  private perchedTicks = 0;
  private minimumHealth: number;
  private readonly stageTicks: Partial<Record<PerchObservation["stage"], number>> = {};
  #ticks = 0;
  #readyAt = 0;
  #health: number | null;
  #bodyHealth: number;

  constructor(
    private readonly bot: Bot,
    readonly targetId: number,
  ) {
    this.dimension = bot.game.dimension;
    this.target = bot.entities[targetId];
    this.healthBefore = this.target ? entityHealth(bot, this.target) : null;
    this.#bodyHealth = bot.health;
    this.minimumHealth = bot.health;
    this.#health = this.healthBefore;
    bot.on("physicsTick", this.#tick);
    bot.on("entityDead", this.#death);
    bot.on("entityUpdate", this.#observe);
    this.refresh();
  }

  readonly #tick = () => {
    this.#ticks++;
    this.refresh();
    this.stageTicks[this.stage] = (this.stageTicks[this.stage] ?? 0) + 1;
    if (this.target && isDragonPerched(dragonPhase(this.bot, this.target))) this.perchedTicks++;
  };
  readonly #observe = () => {
    this.refresh();
  };
  readonly #death = (entity: Parameters<Bot["attack"]>[0]) => {
    if (entity === this.target && this.bot.game.dimension === this.dimension) {
      this.died = true;
      this.#health = 0;
    }
  };

  refresh(): void {
    this.preparationDamaged ||= this.bot.health < this.#bodyHealth;
    this.minimumHealth = Math.min(this.minimumHealth, this.bot.health);
    this.#bodyHealth = this.bot.health;
    if (
      this.bot.game.dimension !== this.dimension ||
      !this.target?.isValid ||
      this.bot.entities[this.targetId] !== this.target
    )
      return;
    const phase = dragonPhase(this.bot, this.target);
    if (isDragonPerched(phase)) this.perchStartedAt ??= Date.now();
    const health = entityHealth(this.bot, this.target);
    if (health !== null && this.#health !== null && health < this.#health) {
      this.firstDamageMs ??= Date.now() - this.startedAt;
      if (this.perchStartedAt !== null) this.firstDamageInPerchMs ??= Date.now() - this.perchStartedAt;
      this.confirmedDamage += this.#health - health;
    }
    this.#health = health;
    if (this.#health === 0) this.died = true;
    if (phase !== null) {
      if (isDragonLanding(phase) || isDragonPerched(phase)) this.landingObserved = true;
      if (this.entered && !isDragonPerched(phase)) this.ended = true;
      if (isDragonPerched(phase)) this.entered = true;
    }
  }

  get healthAfter(): number | null {
    this.refresh();
    return this.#health;
  }
  get blockedBy(): string | null { return this.blocker; }
  set blockedBy(value: string | null) {
    this.blocker = value;
    if (value && (this.stage === "approaching_head" || this.stage === "attacking")) this.lastAttackBlocker = value;
  }
  get timing() {
    this.refresh();
    return { elapsedMs: Date.now() - this.startedAt, firstDamageMs: this.firstDamageMs,
      firstDamageInPerchMs: this.firstDamageInPerchMs,
      confirmedDamage: this.confirmedDamage, perchedTicks: this.perchedTicks,
      stageTicks: { ...this.stageTicks }, minimumHealth: this.minimumHealth, lastAttackBlocker: this.lastAttackBlocker };
  }
  get ready(): boolean {
    return this.#ticks >= this.#readyAt;
  }
  resetReadiness(ticks: number): void {
    this.#readyAt = this.#ticks + ticks;
  }
  swung(cooldownTicks: number): void {
    this.attacks++;
    this.resetReadiness(cooldownTicks);
  }

  [Symbol.dispose](): void {
    this.bot.off("physicsTick", this.#tick);
    this.bot.off("entityDead", this.#death);
    this.bot.off("entityUpdate", this.#observe);
  }
}
