import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { dragonPhase, entityHealth } from "../../../world/end-fight.js";

/** One released arrow and its observation survive a foreground interruption. */
export class DragonShotObservation implements Disposable {
  readonly target: Bot["entity"] | undefined;
  readonly dimension: string;
  readonly healthBefore: number | null;
  healthAfter: number | null;
  attacks = 0;
  died = false;
  damageObserved = 0;
  phase: "aiming" | "observing" | "settled" = "aiming";
  blockedBy: string | null = null;
  flightTicks: number | null = null;
  remainingFlightTicks = 0;
  aimingTicks = 0;
  private ticks = 0;
  private readonly motion: { tick: number; position: Vec3 }[] = [];

  constructor(private readonly bot: Bot, readonly targetId: number, readonly hitboxMargin = 0.5) {
    this.target = bot.entities[targetId];
    this.dimension = bot.game.dimension;
    this.healthBefore = this.healthAfter = this.target ? entityHealth(bot, this.target) : null;
    this.died = this.loaded && this.healthBefore === 0;
    bot.on("physicsTick", this.tick);
    bot.on("entityUpdate", this.update);
    bot.on("entityDead", this.death);
  }

  get loaded(): boolean {
    return this.bot.game.dimension === this.dimension && this.target?.isValid === true &&
      this.target.name === "ender_dragon" && this.bot.entities[this.targetId] === this.target;
  }
  get nativePhase(): number | null { return this.loaded ? dragonPhase(this.bot, this.target!) : null; }
  get velocity(): Vec3 | null {
    return this.measuredVelocity(this.motion.at(-4), this.motion.at(-1));
  }
  get previousVelocity(): Vec3 | null {
    return this.measuredVelocity(this.motion.at(-7), this.motion.at(-4));
  }
  private measuredVelocity(from: { tick: number; position: Vec3 } | undefined, to: { tick: number; position: Vec3 } | undefined): Vec3 | null {
    return from && to ? to.position.minus(from.position).scaled(1 / (to.tick - from.tick)) : null;
  }
  private tick = () => {
    this.ticks++;
    if (this.remainingFlightTicks > 0) this.remainingFlightTicks--;
    if (!this.loaded) { this.motion.length = 0; return; }
    this.motion.push({ tick: this.ticks, position: this.target!.position.clone() });
    while (this.motion.length > 7) this.motion.shift();
    this.update();
  };
  private update = () => {
    if (!this.loaded || this.died) return;
    const health = entityHealth(this.bot, this.target!);
    if (this.attacks > 0 && health !== null && this.healthAfter !== null)
      this.damageObserved += Math.max(0, this.healthAfter - health);
    this.healthAfter = health;
    this.died ||= health === 0;
  };
  private death = (entity: Bot["entity"]) => {
    if (entity === this.target && this.bot.game.dimension === this.dimension) {
      this.died = true;
      this.healthAfter = 0;
    }
  };
  released(flightTicks: number): void {
    this.update();
    this.attacks++;
    this.flightTicks = flightTicks;
    this.remainingFlightTicks = Math.ceil(flightTicks) + 20;
    this.phase = "observing";
    this.blockedBy = null;
  }
  get evidence() {
    return { phase: this.phase, nativePhase: this.nativePhase, flightTicks: this.flightTicks,
      damageObserved: this.damageObserved, blockedBy: this.blockedBy, hitboxMargin: this.hitboxMargin };
  }
  [Symbol.dispose](): void {
    this.bot.off("physicsTick", this.tick);
    this.bot.off("entityUpdate", this.update);
    this.bot.off("entityDead", this.death);
  }
}
