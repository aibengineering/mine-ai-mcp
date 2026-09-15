import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";
import { hasExposedBody } from "../../../world/entity-visibility.js";
import { z } from "zod";

const explosionPosition = z.object({ x: z.number(), y: z.number(), z: z.number() });

type Entity = Bot["entity"];
export const CREEPER_CLEARANCE = 8;
export const FUSE_UNWIND_TICKS = 30;
export const isCreeper = (entity: Entity): boolean => entity.name === "creeper";
export function isSwelling(bot: Bot, entity: Entity): boolean {
  const index = bot.registry.entitiesByName[entity.name ?? ""]?.metadataKeys?.indexOf("swell_dir") ?? -1;
  const direction: unknown = index >= 0 ? entity.metadata?.[index] : undefined;
  return direction === 1;
}
export function fusedThreats(bot: Bot, range: number): readonly Entity[] {
  return Object.values(bot.entities).filter(entity => entity.isValid && isCreeper(entity) &&
    entity.position.distanceTo(bot.entity.position) <= range);
}
export interface CreeperObservation {
  readonly id: number;
  readonly position: Vec3;
  readonly distance: number;
  readonly swelling: boolean;
  readonly observed: boolean;
  readonly exposed?: boolean;
  /** Conservative remaining native fuse ticks; first-seen active fuses are due. */
  readonly fuseRemainingTicks?: number;
}

/** Connection-owned clearance survives target changes and physical fight lifetimes.
 * Missing entities retain their last position; disappearance is not proof of death. */
export class CreeperClearance {
  readonly #pending = new Map<number, { position: Vec3; clearTicks: number; explosionTick: number | null }>();
  readonly #fuses = new Map<number, { entity: Entity; tick: number; remaining: number }>();
  #lastTick = -1;
  #dimension: string;
  constructor(readonly bot: Bot) { this.#dimension = bot.game.dimension; }
  resolve(id: number): void { this.#pending.delete(id); this.#fuses.delete(id); }
  reset(): void { this.#pending.clear(); this.#fuses.clear(); this.#lastTick = -1; this.#dimension = this.bot.game.dimension; }
  private fuseRemaining(entity: Entity, tick: number): number {
    const swelling = isSwelling(this.bot, entity);
    const previous = this.#fuses.get(entity.id);
    const elapsed = previous ? Math.max(0, tick - previous.tick) : 0;
    const remaining = previous?.entity === entity
      ? Math.max(0, Math.min(FUSE_UNWIND_TICKS, previous.remaining + (swelling ? -elapsed : Math.min(1, elapsed))))
      : swelling ? 0 : FUSE_UNWIND_TICKS;
    this.#fuses.set(entity.id, { entity, tick, remaining });
    return remaining;
  }
  require(threats: readonly CreeperObservation[]): void {
    // Once cover has discharged one fuse, another pending fuse must not rearm
    // it on every read. Actual exposure or swelling can admit it again.
    for (const threat of threats) if ((threat.exposed !== false || threat.swelling) && !this.#pending.has(threat.id))
      this.#pending.set(threat.id, { position: threat.position.clone(), clearTicks: 0, explosionTick: null });
  }
  /** A matching blast followed by removal discharges its fuse. Neither a
   * disappearance alone nor a different nearby explosion establishes that. */
  exploded(packet: unknown, tick: number): void {
    const parsed = explosionPosition.safeParse(packet);
    if (!parsed.success) return;
    const { x, y, z: zPosition } = parsed.data;
    for (const [id, state] of this.#pending) {
      const position = this.bot.entities[id]?.position ?? state.position;
      // A swelling creeper stands still; allow a sub-block packet discrepancy.
      if (Math.hypot(position.x - x, position.y - y, position.z - zPosition) <= 0.75) state.explosionTick = tick;
    }
  }
  get pending(): boolean { return this.#pending.size > 0; }
  observe(tick: number, dead: ReadonlySet<number>): readonly CreeperObservation[] {
    if (this.bot.game.dimension !== this.#dimension) this.reset();
    for (const id of this.#fuses.keys()) if (dead.has(id) || !this.bot.entities[id]?.isValid) this.#fuses.delete(id);
    const live = fusedThreats(this.bot, CREEPER_CLEARANCE * 2).filter(entity => !dead.has(entity.id));
    const observations = new Map<number, CreeperObservation>(live.map(entity => [entity.id, {
      id: entity.id, position: entity.position.clone(), distance: entity.position.distanceTo(this.bot.entity.position),
      swelling: isSwelling(this.bot, entity), observed: true, exposed: hasExposedBody(this.bot, entity),
      fuseRemainingTicks: this.fuseRemaining(entity, tick),
    }]));
    for (const [id, state] of this.#pending) {
      if (dead.has(id)) { this.#pending.delete(id); continue; }
      const entity = this.bot.entities[id];
      const observed = entity?.isValid === true;
      if (!observed && state.explosionTick !== null && tick - state.explosionTick <= 2) { this.#pending.delete(id); continue; }
      if (observed) state.position = entity.position.clone();
      const distance = state.position.distanceTo(this.bot.entity.position);
      const swelling = observed && isSwelling(this.bot, entity);
      const exposed = observed ? hasExposedBody(this.bot, entity) : true;
      // Solid occlusion plus a full observed unwind also ends the emergency.
      // A missing entity or a shield command cannot establish this protection.
      if (tick !== this.#lastTick) state.clearTicks = distance > CREEPER_CLEARANCE || (observed && !exposed && !swelling) ? state.clearTicks + 1 : 0;
      if (state.clearTicks >= FUSE_UNWIND_TICKS) { this.#pending.delete(id); continue; }
      observations.set(id, { id, position: state.position.clone(), distance, swelling, observed, exposed,
        fuseRemainingTicks: observed ? this.fuseRemaining(entity, tick) : 0 });
    }
    this.#lastTick = tick;
    return [...observations.values()];
  }
}
