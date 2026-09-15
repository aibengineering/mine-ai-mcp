/**
 * Pursue matching loaded entities until a caller-owned quantity is satisfied.
 *
 * This is the third process beside `MineProcess` and `BuilderProcess`: the same
 * loop with an entity for a target and a fight for the physical step. Select
 * the nearest thing the caller calls quarry, walk to it, hand the caller the
 * body inside contact range, and settle with a status and a reason.
 *
 * Two things make it easier than mining, and one makes it harder.
 *
 * Easier: there is one target at a time rather than a composite goal, because
 * a fight is not a cell that can be coalesced with the next one; and the goal
 * is `nearEntityGoal`, which re-reads the entity on every search, so a mob that
 * wanders is followed by the run's own replanning rather than by this loop
 * reissuing routes.
 *
 * Harder: the target moves, so "the route completed" is not "the bot arrived".
 * A pursuit that keeps completing routes without ever closing the distance is
 * the one way this loop could walk forever, and the closing rule below is what
 * ends it.
 *
 * Nothing here knows a species from a species, or a fight from a handshake.
 * `matches` decides what counts as quarry and `engage` is the whole physical
 * step, so the combat controller — and the thirty-two block approach bound it
 * keeps for the reflex — stays on the caller's side of this boundary.
 */
import type { Bot } from "mineflayer";
import { nearEntityGoal, type BlockPosition, type MovementPolicy, type Navigate } from "../../index.js";

/** A loaded Mineflayer entity, which is what `matches` is asked about. */
export type MinecraftEntity = Bot["entities"][number];

/**
 * How many sightings one announcement carries. The process pursues one target
 * at a time and the announcement exists so a caller's result can say where the
 * species is; the nearest sixteen answer that without turning one hunt into a
 * census of a sheep field.
 */
export const MAX_HUNT_TARGETS = 16;

/**
 * Stopped approaches to one target, by route or by fight, before it is given up on.
 *
 * Baritone blacklists the target nearest a failure rather than abandoning the
 * process, and so does mining. A hunted target earns a second attempt that a
 * block does not, because the reason the first route stopped may have walked
 * away in the meantime; a second stop on the same target is the target's
 * answer, not the world's.
 */
const MAX_TARGET_STOPS = 2;

/**
 * How much nearer a completed route must leave the bot for the pursuit to
 * count as closing on a moving target. One block: anything smaller is inside
 * the noise of where a mob stands when a route settles, and the rule only has
 * to make the distance a sequence that ends.
 */
const CLOSING_BLOCKS = 1;

/** Reconsider moving quarry without turning ordinary wandering into route churn. */
const RECONSIDER_EVERY_TICKS = 20;
const RECONSIDER_DISTANCE_RATIO = 0.6;
const TELEPORT_DISTANCE = 8;
const STOP_RESET_DISTANCE = 4;
const STOP_RESET_AFTER_MS = 30_000;
const NEAREST_DISTANCE_BAND_RATIO = 1.5;

/** One loaded target as it was last scanned. */
export interface HuntTarget {
  readonly id: number;
  /** Where it was, as a cell a caller can navigate to or name in a result. */
  readonly position: BlockPosition;
  /** How far the bot was from it then. */
  readonly distance: number;
}

/** A chosen quarry change, independent of changes to the surrounding census. */
export interface HuntTargetChange {
  readonly previous: HuntTarget | null;
  readonly selected: HuntTarget;
  readonly reason: string;
}

/** What the caller's physical step made of the target. */
export type EngagementOutcome =
  /** The target is dead and whatever it owed the caller has been settled. */
  | { readonly kind: "defeated" }
  /** The target is gone without a verdict: despawned, or killed by someone else. */
  | { readonly kind: "target_lost" }
  /**
   * The fight could not reach the target: it moved beyond the approach's
   * reach, as an enderman does when it teleports onto a canopy. That is a stop
   * on this target, like a refused route, and the next loaded one is pursued.
   */
  | { readonly kind: "unreachable"; readonly reason: string }
  /**
   * The fight ended without a verdict on the target, and the hunt ends with it.
   * The reason is the caller's own account of what happened, which the settle
   * reason carries out unchanged with the target's last position appended.
   */
  | { readonly kind: "stopped"; readonly reason: string };

export interface HuntRequest {
  /** Which loaded entities count as the quarry. */
  readonly matches: (entity: MinecraftEntity) => boolean;
  /** Caller-owned priority among admitted quarry, after pursuit-owned distance and failed-approach bounds. */
  readonly compareTargets?: (left: MinecraftEntity, right: MinecraftEntity) => number;
  /** Caller-owned hard safety tier; distance reconsideration never crosses into a worse tier. */
  readonly targetTier?: (target: MinecraftEntity) => number;
  /** Whether the caller has what it asked for. */
  readonly isSatisfied: () => boolean;
  readonly movements: MovementPolicy;
  /** How near the pursuit walks before it hands the body to `engage`. */
  readonly contactRange: number;
  /** Moving quarry whose long approaches should be reconsidered while the route owns the body. */
  readonly reconsiderApproach?: boolean;
  readonly signal?: AbortSignal;
  /**
   * Route execution, injectable so the process can be exercised without a
   * server. Every bug this loop can have is in how it reacts to a route's
   * outcome, which is a question a fake answers in a millisecond.
   */
  readonly route: Navigate;
  /** Read-only caller admission, before the pursuit walks or starts an engagement. */
  readonly preflight?: (target: MinecraftEntity) => string | null;
  /** The physical step, injectable: the fight, from inside contact range. */
  readonly engage: (targetId: number) => Promise<EngagementOutcome>;
  /** Target sightings when selection changes, plus the refreshed final target when the hunt stops. */
  readonly onTargets?: (targets: readonly HuntTarget[]) => void | Promise<void>;
  readonly onTargetChanged?: (change: HuntTargetChange) => void;
}

export interface HuntResult {
  readonly status: "satisfied" | "no_targets" | "unreachable" | "capability_blocked" | "stopped";
  /** Why the hunt stopped short, naming the target's last observed position and distance. */
  readonly reason: string | null;
}

/** `<reason>; the target was last observed at x,y,z, N blocks away`. */
function describe(reason: string, target: HuntTarget): string {
  const { x, y, z } = target.position;
  return `${reason}; the target was last observed at ${x},${y},${z}, ${target.distance.toFixed(1)} blocks away`;
}

/**
 * Everything one hunt remembers between looks at the world: which targets are
 * finished with, which have refused a route, and how near the pursuit has ever
 * brought the bot to each.
 */
class HuntTargeting {
  /** Targets with no verdict left to give: defeated, or gone while being fought. */
  readonly #retired = new Set<number>();
  readonly #stops = new Map<
    number,
    { readonly count: number; readonly stoppedAt: number; readonly position: BlockPosition }
  >();
  /** The nearest this pursuit has ever been to each target, which only decreases. */
  readonly #closest = new Map<number, number>();
  #lastStop: { readonly target: HuntTarget; readonly reason: string } | null = null;
  #announced = "";
  #selected: HuntTarget | null = null;
  #selectionReason = "Initial target selection.";
  #preferred: { readonly id: number; readonly reason: string } | null = null;

  constructor(
    private readonly bot: Bot,
    private readonly request: HuntRequest,
  ) {}

  /** Whether any target was given up on for refusing routes, which "no targets" would hide. */
  get abandoned(): boolean {
    return this.#lastStop !== null;
  }

  /** One entity as a target: where it is, and how far the bot is from it. */
  #sight(entity: MinecraftEntity): HuntTarget {
    const position = entity.position;
    return {
      id: entity.id,
      position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
      distance: position.distanceTo(this.bot.entity.position),
    };
  }

  #normalizeStop(target: HuntTarget): void {
    const stop = this.#stops.get(target.id);
    if (!stop || !this.request.reconsiderApproach) return;
    const moved = Math.hypot(
      target.position.x - stop.position.x,
      target.position.y - stop.position.y,
      target.position.z - stop.position.z,
    );
    if (moved >= STOP_RESET_DISTANCE || Date.now() - stop.stoppedAt >= STOP_RESET_AFTER_MS) {
      this.#stops.delete(target.id);
    }
  }

  /**
   * The matching targets still worth pursuing. Ordinary hunts retain their
   * existing stop/caller/distance order. Reconsidered Enderman hunts first keep
   * selection within 1.5x of the nearest loaded quarry, then apply those same
   * priorities inside that band. This bounds a terrain preference without a
   * pairwise ratio comparator, whose ordering could depend on candidate order.
   * There is no radius: the client-loaded set is the census bound.
   */
  scan(): readonly HuntTarget[] {
    const targets = Object.values(this.bot.entities ?? {})
      .filter((entity) => entity.id !== this.bot.entity?.id)
      .filter((entity) => !this.#retired.has(entity.id))
      .filter((entity) => this.request.matches(entity))
      .map((entity) => this.#sight(entity));
    for (const target of targets) this.#normalizeStop(target);
    const eligible = targets.filter((target) => (this.#stops.get(target.id)?.count ?? 0) < MAX_TARGET_STOPS);
    const tiers = new Map(
      eligible.map((target) => [target.id, this.request.targetTier?.(this.bot.entities[target.id]!) ?? 0] as const),
    );
    const tier = (target: HuntTarget) => tiers.get(target.id)!;
    const safestTier = Math.min(...eligible.map(tier));
    const nearestDistance = Math.min(...eligible.filter((target) => tier(target) === safestTier).map(({ distance }) => distance));
    eligible.sort((left, right) => {
      const tierDifference = tier(left) - tier(right);
      if (tierDifference !== 0) return tierDifference;
      if (this.request.reconsiderApproach) {
        const leftNear = left.distance <= nearestDistance * NEAREST_DISTANCE_BAND_RATIO;
        const rightNear = right.distance <= nearestDistance * NEAREST_DISTANCE_BAND_RATIO;
        if (leftNear !== rightNear) return leftNear ? -1 : 1;
        // Far sightings are an announcement, not an immediate choice. Avoid
        // repeatedly resolving their terrain on every reconsideration tick;
        // they receive the full caller rank when the near band reaches them.
        if (!leftNear) return left.distance - right.distance;
      }
      return (
        (this.#stops.get(left.id)?.count ?? 0) - (this.#stops.get(right.id)?.count ?? 0) ||
        this.request.compareTargets?.(this.bot.entities[left.id]!, this.bot.entities[right.id]!) ||
        left.distance - right.distance
      );
    });
    const ranked = eligible.slice(0, MAX_HUNT_TARGETS);
    const preferred = this.#preferred && ranked.findIndex(({ id }) => id === this.#preferred!.id);
    if (preferred !== null && preferred > 0) {
      const [target] = ranked.splice(preferred, 1);
      ranked.unshift(target!);
    }
    return ranked;
  }

  /** Where one target is now, or null once the client no longer holds it. */
  sight(id: number): HuntTarget | null {
    const entity = this.bot.entities?.[id];
    return entity ? this.#sight(entity) : null;
  }

  /** Publish the target set when it is not the one already published. */
  async announce(targets: readonly HuntTarget[]): Promise<void> {
    const identity = targets.map((target) => target.id).join("|");
    if (identity === this.#announced) return;
    this.#announced = identity;
    await this.request.onTargets?.(targets);
  }

  select(target: HuntTarget): void {
    if (this.#selected?.id !== target.id) {
      const reason = this.#preferred?.id === target.id ? this.#preferred.reason : this.#selectionReason;
      this.request.onTargetChanged?.({ previous: this.#selected, selected: target, reason });
    }
    this.#selected = target;
    this.#preferred = null;
    this.#selectionReason = "Target priority changed after the preceding approach.";
  }

  prefer(target: HuntTarget, reason: string): void {
    this.#preferred = { id: target.id, reason };
  }

  retire(id: number, reason: string): void {
    this.#retired.add(id);
    this.#selectionReason = reason;
  }

  stop(target: HuntTarget, reason: string): void {
    const previous = this.#stops.get(target.id);
    this.#stops.set(target.id, {
      count: (previous?.count ?? 0) + 1,
      stoppedAt: Date.now(),
      position: target.position,
    });
    this.#lastStop = { target, reason };
    this.#selectionReason = reason;
  }

  /**
   * Record how near this target the pursuit has come, and say whether that was
   * nearer than ever before. A route that completes without closing is the
   * target moving as fast as the bot, and repeating it is the one way this loop
   * could walk forever.
   */
  recordClosing(target: HuntTarget): boolean {
    const closest = this.#closest.get(target.id);
    if (closest !== undefined && target.distance > closest - CLOSING_BLOCKS) return false;
    this.#closest.set(target.id, target.distance);
    return true;
  }

  async settle(
    status: HuntResult["status"],
    stop?: { readonly target: HuntTarget; readonly reason: string },
  ): Promise<HuntResult> {
    if (this.request.isSatisfied()) return { status: "satisfied", reason: null };
    const observed = stop ?? this.#lastStop;
    if (!observed) return { status, reason: null };
    // The physical engagement may have moved both bodies since selection.
    // Keep the recorded sighting only when the client no longer has a valid one.
    const entity = this.bot.entities[observed.target.id];
    const target = entity?.isValid ? this.#sight(entity) : observed.target;
    if (entity?.isValid) await this.request.onTargets?.([target]);
    return { status, reason: describe(observed.reason, target) };
  }
}

export async function hunt(bot: Bot, request: HuntRequest): Promise<HuntResult> {
  const targeting = new HuntTargeting(bot, request);

  while (!request.isSatisfied()) {
    request.signal?.throwIfAborted();
    const targets = targeting.scan();
    await targeting.announce(targets);
    // Nothing matching left, which is not the same as nothing matching ever: a
    // target given up on for refusing every route was found and could not be
    // reached, and saying "none loaded" would hide that.
    if (targets.length === 0) return targeting.settle(targeting.abandoned ? "unreachable" : "no_targets");

    const target = targets[0]!;
    targeting.select(target);
    const entity = bot.entities[target.id];
    if (!entity) continue;
    const refused = request.preflight?.(entity);
    if (refused) return targeting.settle("capability_blocked", { target, reason: refused });
    if (target.distance <= request.contactRange) {
      const engagement = await request.engage(target.id);
      if (engagement.kind === "stopped") return targeting.settle("stopped", { target, reason: engagement.reason });
      if (engagement.kind === "unreachable") {
        targeting.stop(target, engagement.reason);
        continue;
      }
      // Defeated or vanished, the target has no verdict left to give; the next
      // loaded one is the hunt's answer, not this one again.
      targeting.retire(
        target.id,
        engagement.kind === "defeated" ? "The previous engagement was completed." : "The previous target was lost.",
      );
      continue;
    }

    // No `maximumRadius`: the reflex's approach is a detour bound, and this is
    // the walk itself. `stepField: null` for the same reason the fight's routes
    // say it — a pursuit walks toward the very thing a hostile field prices.
    const reconsider = new AbortController();
    let reconsidered = false;
    let ticks = 0;
    let selectedPosition = entity.position.clone();
    const consider = (reason: string) => {
      if (reconsidered) return;
      const current = targeting.sight(target.id);
      const alternative = targeting.scan().find(({ id }) => id !== target.id);
      if (
        !current ||
        !alternative ||
        alternative.id === current.id ||
        (request.targetTier?.(bot.entities[alternative.id]!) ?? 0) >
          (request.targetTier?.(bot.entities[current.id]!) ?? 0) ||
        alternative.distance > current.distance * RECONSIDER_DISTANCE_RATIO
      )
        return;
      reconsidered = true;
      targeting.prefer(alternative, reason);
      reconsider.abort(reason);
    };
    const onPhysicsTick = () => {
      if (++ticks % RECONSIDER_EVERY_TICKS === 0) consider("closer target during approach");
    };
    const onEntityMoved = (moved: MinecraftEntity) => {
      if (moved.id !== target.id) return;
      const teleported = selectedPosition.distanceTo(moved.position) >= TELEPORT_DISTANCE;
      selectedPosition = moved.position.clone();
      if (teleported) consider("selected target teleported");
    };
    if (request.reconsiderApproach) {
      bot.on("physicsTick", onPhysicsTick);
      bot.on("entityMoved", onEntityMoved);
    }
    let route;
    try {
      route = await request.route({
        movements: request.movements,
        goal: nearEntityGoal({ id: target.id }, request.contactRange),
        stepField: null,
        ...(request.signal && { signal: request.signal }),
        ...(request.reconsiderApproach && { stopSignal: reconsider.signal }),
      });
    } finally {
      if (request.reconsiderApproach) {
        bot.off("physicsTick", onPhysicsTick);
        bot.off("entityMoved", onEntityMoved);
      }
    }
    if (reconsidered) continue;
    // A target can die or unload while navigation returns its invalid goal.
    // That ends this target's pursuit, not the hunt's reachability; settling
    // with no targets also lets the caller gather any resulting loaded drops.
    const remaining = bot.entities[target.id];
    if (!remaining || !request.matches(remaining)) {
      targeting.retire(target.id, "The previous target was no longer loaded after its approach.");
      continue;
    }
    if (route.status === "stopped") {
      targeting.stop(target, route.reason);
      continue;
    }

    const arrived = targeting.sight(target.id);
    if (arrived === null) {
      targeting.retire(target.id, "The previous target was no longer loaded after its approach.");
      continue;
    }
    if (arrived.distance > request.contactRange && !targeting.recordClosing(arrived)) {
      targeting.stop(arrived, `the route completed without closing on the target`);
    }
  }

  return targeting.settle("satisfied");
}
