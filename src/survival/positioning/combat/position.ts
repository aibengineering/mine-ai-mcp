import { isIncomingArrow } from "../../perception/combat/shield-projectiles.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { SupportedPositionHold } from "../../../navigation/index.js";
import {
  centerOnCell,
  createMovements,
  exactBlockGoal,
  steeringPortFor,
  type Goal,
  type MovementPolicy,
  type NavigationRuntime,
} from "../../../navigation/index.js";
import { isHeadPassable, isPassable, isSafeSupport, navigationFeet } from "../../../navigation/world/block-geometry.js";
import { isReplaceableForPlacement } from "../../../world/block-classification.js";
import { clearCombatRay, nearestBodyPoint } from "../../../world/entity-geometry.js";
import { occupiedCell } from "../../../world/placement.js";
import { positionThreat, type CombatPerception } from "../../perception/combat/observations.js";
import { fireAt } from "../../perception/body.js";
import { canBeBystander, isHostile } from "../../perception/combat/threats.js";
import { type CombatPolicy } from "../../policy/combat/contract.js";
import { Answered, type AnsweredScope } from "../../state/answered.js";
import { MELEE_RANGE } from "../../weapons/equipment.js";
import { extinguishFireAt } from "../fire-clearance.js";
import { buildProtection, fullProtectionBlock } from "./build-protection.js";
import { positionExposed, projectileReachesBody, type PositionThreat } from "./exposure.js";
import { geometryAnswer } from "./geometry-answer.js";
import { positionWorld, standingBody, standingCell, type CombatPositionPlan } from "./geometry.js";
import { countCapBlocks } from "./hide-blocks.js";
import {
  backstopPosition,
  requiredEndermanRoof,
  roofEngagementAvailable,
  PROTECTION_SIDES,
  findCombatPosition,
  findRoofPosition,
  type RoofOpening,
  type RoofPosition,
} from "./planner.js";

type Entity = Parameters<Bot["attack"]>[0];

/**
 * Existing combat detour bound: unreachable moving targets otherwise renew
 * search budgets while holding the body indefinitely. Also applies to protection.
 */
export const COMBAT_APPROACH_RADIUS = 32;

export type ProtectionRefusal =
  | { readonly kind: "materials_missing"; readonly reason: string }
  | { readonly kind: "unreachable"; readonly reason: string };

/** Geometry and movement for one engagement. It never owns shield, aim or attack controls. */
export class CombatPosition {
  plan: CombatPositionPlan | null = null;
  readonly #origin: Vec3;

  /** The same supported cell navigation reached, including lowered floors. */
  get cell(): Vec3 {
    const { x, y, z } = navigationFeet(this.bot.entity.position, this.bot.entity.onGround);
    return new Vec3(x, y, z);
  }

  get canEstablish(): boolean {
    const scope = this.searchScope();
    return this.answered.find(scope.capability, scope.scope) === null;
  }
  private get rejectedCoverCount(): number {
    return this.answered
      .snapshot()
      .filter((entry) => entry.capability === "combat.cover" && entry.scope.startsWith(`target:${this.target.id}:`))
      .length;
  }
  private geometryScope(capability: string, identity: string, origin: Vec3, radius: number): AnsweredScope {
    const targetId = this.target.id;
    return geometryAnswer(this.navigation.world, origin, radius, {
      capability,
      response: "establish",
      scope: `target:${targetId}:${identity}`,
      facts: () => ({
        target: this.bot.entities[targetId]?.position.floored().toString() ?? null,
        blocks: capability === "combat.cover" || capability === "combat.roof" ? null : countCapBlocks(this.bot),
      }),
      permissions: () => ({
        dig: this.policy().terrain.dig,
        place: this.policy().terrain.place,
        melee: this.policy().melee,
      }),
    });
  }
  private searchScope(): AnsweredScope {
    return this.geometryScope(
      "combat.cover_search",
      `origin:${this.#origin}:rejected:${this.rejectedCoverCount}`,
      this.#origin,
      COMBAT_APPROACH_RADIUS,
    );
  }
  private coverKey(plan: CombatPositionPlan): string {
    return `${plan.protected}:${plan.corner}:${plan.entrance}`;
  }
  private acceptsCover = (plan: CombatPositionPlan): boolean =>
    plan.protected.distanceTo(this.#origin) <= COMBAT_APPROACH_RADIUS &&
    plan.placements.every(this.canPlaceProtection) &&
    this.answered.find("combat.cover", `target:${this.target.id}:${this.coverKey(plan)}`) === null;

  /** Passable plants are not necessarily replaceable. Price the cells the
   * server can actually fill before provoking a quarry or starting a wall. */
  private canPlaceProtection = (cell: Vec3): boolean => {
    const observed = this.navigation.world.blockAt(cell.x, cell.y, cell.z);
    const block = observed.kind === "loaded" ? this.bot.registry.blocksByStateId[observed.stateId] : null;
    return isReplaceableForPlacement(block ?? null) && occupiedCell(this.bot, cell) === null;
  };

  /** Reject this geometry for this target position, not the target or the hunt. */
  rejectCover(reason = "The protected position offered no usable attack opening."): void {
    if (this.plan)
      this.answered.remember(
        this.geometryScope("combat.cover", this.coverKey(this.plan), this.plan.protected, COMBAT_APPROACH_RADIUS),
        { kind: "position_rejected", why: reason },
      );
    this.plan = null;
  }

  rejectRoof(cell: Vec3, reason: string): void {
    this.answered.remember(
      this.geometryScope("combat.roof", `${cell}:${this.target.position.floored()}`, cell, COMBAT_APPROACH_RADIUS),
      { kind: "target_progress_exhausted", why: reason },
    );
  }

  unproductiveRoofs(): ReadonlySet<string> {
    const prefix = `target:${this.target.id}:`;
    return new Set(
      this.answered
        .snapshot()
        .filter((entry) => entry.capability === "combat.roof" && entry.scope.startsWith(prefix))
        .map((entry) => entry.scope.slice(prefix.length)),
    );
  }
  constructor(
    readonly bot: Bot,
    readonly navigation: NavigationRuntime,
    public target: Entity,
    readonly dead: ReadonlySet<number>,
    readonly perception: CombatPerception,
    readonly policy: () => Readonly<CombatPolicy>,
    readonly answered: Answered,
  ) {
    this.#origin = this.cell;
  }

  async establishBackstop(signal: AbortSignal): Promise<boolean> {
    const blocks = this.policy().terrain.place ? countCapBlocks(this.bot) : 0;
    if (blocks === 0 || !this.policy().terrain.place) return false;
    const origin = this.cell;
    const scope = this.geometryScope("combat.backstop", `cell:${origin}`, origin, 3);
    if (this.answered.find(scope.capability, scope.scope)) return false;
    const plan = backstopPosition(this.navigation.world, origin, this.target.position, blocks);
    if (!plan || plan.placements.length === 0 || !plan.placements.every(this.canPlaceProtection)) {
      this.answered.remember(scope, {
        kind: "geometry_unavailable",
        why: "No backstop placement was available in this supported cell.",
      });
      return false;
    }
    const result = await buildProtection(this.bot, plan.placements, {
      signal,
      terrain: this.policy().terrain,
      mayContinue: () => (this.at(origin) ? null : "The body left the backstop construction cell."),
    });
    signal.throwIfAborted();
    if (result.kind !== "built") this.answered.remember(scope, { kind: "construction_blocked", why: result.reason });
    return result.kind === "built";
  }

  roofNeedsRelocation(eyeHeight: number): boolean {
    if (roofEngagementAvailable(this.navigation.world, this.cell, positionThreat(this.bot, this.target), eyeHeight)) return false;
    // Do not confuse a temporarily distant quarry with an unusable shelter.
    // Early relocation needs positive evidence of enclosure or a different level.
    return Math.abs(this.cell.y - this.target.position.y) > 3 || PROTECTION_SIDES.every((side) =>
      fullProtectionBlock(this.bot.blockAt(this.cell.plus(side))) ||
      fullProtectionBlock(this.bot.blockAt(this.cell.plus(side).offset(0, 1, 0))));
  }

  hasHeightProtection(): boolean {
    const full = (cell: Vec3) => fullProtectionBlock(this.bot.blockAt(cell));
    return requiredEndermanRoof(this.cell, full).every(full);
  }

  /** A failed construction belongs to its site. Knockback can leave another
   * supported cell, whose roof has not been attempted. */
  roofPreparationFailure() {
    return this.answered.find("combat.roof_preparation", `target:${this.target.id}:cell:${this.cell}`);
  }

  rejectRoofPreparation(cell: Vec3, reason: string, kind: ProtectionRefusal["kind"] = "unreachable"): void {
    this.answered.remember(
      this.geometryScope("combat.roof_preparation", `cell:${cell}`, cell, COMBAT_APPROACH_RADIUS),
      { kind, why: reason },
    );
  }

  /** Read-only construction admission, shared by pursuit preflight and execution. */
  planRoof(opening: RoofOpening): { readonly kind: "ready"; readonly plan: RoofPosition } | ProtectionRefusal {
    if (
      this.hasHeightProtection() &&
      (opening.kind === "protection" ||
        (opening.kind === "provoke" &&
          clearCombatRay(this.bot.world, this.bot.entity.position.offset(0, opening.eyeHeight, 0), opening.targetEye)))
    )
      return { kind: "ready", plan: { cell: this.cell, placements: [] } };
    const available = this.policy().terrain.place ? countCapBlocks(this.bot) : 0;
    const findRoof = (blocks: number) =>
      findRoofPosition(
        this.navigation.world,
        this.cell,
        this.target.position,
        blocks,
        this.canPlaceProtection,
        opening,
      );
    const search = findRoof(available);
    const roof = search.plan;
    if (!roof) {
      if (!this.policy().terrain.place)
        return {
          kind: "unreachable",
          reason: "[COMBAT_CONSTRAINED] No usable existing roof; construction is prohibited.",
        };
      // Search the same finite set of positions without the inventory filter to
      // distinguish missing material from geometry. Existing roofs cost zero.
      const buildable = available > 0 ? findRoof(Infinity).plan : null;
      if (available === 0 || buildable)
        return {
          kind: "materials_missing",
          reason: buildable
            ? `[COMBAT_BUILD_MATERIALS_MISSING] Defensive roof construction needs ${buildable.placements.length} usable building blocks at the selected position; ${available} carried.`
            : "[COMBAT_BUILD_MATERIALS_MISSING] No usable building blocks remain for defensive construction, and no usable existing roof was found.",
        };
      return {
        kind: "unreachable",
        reason:
          (opening.kind === "provoke"
            ? "No supported roof position with a clear gaze before construction can be reached or built."
            : "No supported roof position can be reached or built.") +
          ` Roof search from ${this.cell} toward ${this.target.position}: ${search.supportedCells} supported cells; rejected orientations: terrain ${search.rejected.terrain}, material ${search.rejected.material}, occupied ${search.rejected.occupied}, gaze ${search.rejected.gaze}, reach ${search.rejected.reach}.`,
      };
    }
    return { kind: "ready", plan: roof };
  }

  async prepareRoof(
    signal: AbortSignal,
    footing: SupportedPositionHold,
    opening: RoofOpening,
  ): Promise<ProtectionRefusal | null> {
    const planned = this.planRoof(opening);
    if (planned.kind !== "ready") return planned;
    const roof = planned.plan;
    if (roof.placements.length === 0 && this.at(roof.cell)) return null;
    const stopped = await this.move(roof.cell, signal, footing);
    if (stopped) return { kind: "unreachable", reason: stopped };
    return this.buildRoof(roof, signal);
  }

  /** A failed local roof search is not a verdict on reachable terrain. */
  async approachRoof(
    opening: () => RoofOpening,
    signal: AbortSignal,
    footing: SupportedPositionHold,
    stopSignal: AbortSignal,
  ): Promise<{ readonly kind: "ready"; readonly plan: RoofPosition } | ProtectionRefusal> {
    const local = this.planRoof(opening());
    if (local.kind !== "unreachable") return local;
    const stopped = await this.seekPosition(
      {
        resolve: () => {
          const gaze = opening();
          const target = this.target.position.clone();
          const blocks = this.policy().terrain.place ? countCapBlocks(this.bot) : 0;
          return {
            kind: "active",
            revision: `roof:${target}:${blocks}:${JSON.stringify(gaze)}:${gaze.kind === "engage" ? [...gaze.unproductive].join(";") : ""}`,
            heuristic: ({ feet }) => {
              if (gaze.kind !== "engage") return 0;
              const eye = new Vec3(feet.x + 0.5, feet.y + gaze.eyeHeight, feet.z + 0.5);
              return Math.max(0, nearestBodyPoint(eye, gaze.target).distanceTo(eye) - MELEE_RANGE);
            },
            isSatisfied: ({ feet }, world) => {
              const cell = new Vec3(feet.x, feet.y, feet.z);
              return findRoofPosition(world, cell, target, blocks, this.canPlaceProtection, gaze, [cell]).plan !== null;
            },
          };
        },
      },
      createMovements(this.bot, {
        // Contact interrupts terrain work through the fight's route watcher.
        // A sheltered attacker behind a wall does not forbid opening an exit.
        allowDigging: this.policy().terrain.dig,
        scaffolding: this.policy().terrain.place,
        allowSprinting: false,
        allowParkour: false,
        maximumDrop: 3,
      }),
      signal,
      footing,
      stopSignal,
    );
    if (stopped) return { kind: "unreachable", reason: `No productive shelter reached within ${COMBAT_APPROACH_RADIUS} blocks using permitted terrain work: ${stopped}` };
    return this.planRoof(opening());
  }

  /** Build the admitted plan after the controller has observed hostility. */
  async buildRoof(roof: RoofPosition, signal: AbortSignal): Promise<ProtectionRefusal | null> {
    const built = await buildProtection(this.bot, roof.placements, {
      signal,
      terrain: this.policy().terrain,
      mayContinue: () => (this.at(roof.cell) ? null : "The body left the roof construction cell."),
    });
    return built.kind === "blocked"
      ? { kind: "unreachable", reason: built.reason }
      : this.hasHeightProtection()
        ? null
        : { kind: "unreachable", reason: "The completed roof was not observed." };
  }

  threats(): PositionThreat[] {
    const candidates = this.perception.read().map((entry) => entry.entity);
    return candidates
      .filter(
        (entity) =>
          entity.isValid &&
          !this.dead.has(entity.id) &&
          (entity.id === this.target.id || (isHostile(entity) && !canBeBystander(this.bot, entity))) &&
          entity.position.distanceTo(this.bot.entity.position) <= 32,
      )
      .map((entity) => positionThreat(this.bot, entity));
  }

  protected(): boolean {
    const plan = this.plan;
    if (!plan) return false;
    const rays = positionWorld(this.navigation.world);
    const body = standingBody(plan.protected);
    return (
      standingCell(this.navigation.world, plan.protected) &&
      [plan.corner, plan.entrance, plan.fighting].every((cell) => {
        const world = this.navigation.world;
        // Fire obstructs travel until extinguished; it does not remove the
        // walls protecting a safe refuge. Solid obstructions still invalidate it.
        return (
          isSafeSupport(world.blockAt(cell.x, cell.y - 1, cell.z)) &&
          (isPassable(world.blockAt(cell.x, cell.y, cell.z)) || this.fireAt(cell)) &&
          (isHeadPassable(world.blockAt(cell.x, cell.y + 1, cell.z)) || this.fireAt(cell.offset(0, 1, 0)))
        );
      }) &&
      !this.threats().some((threat) => positionExposed(rays, body, threat)) &&
      !Object.values(this.bot.entities).some(
        (entity) => entity.isValid && ((entity.name === "small_fireball" && projectileReachesBody(rays, entity, body)) || isIncomingArrow(this.bot, entity, 0, body)),
      )
    );
  }

  /** The body remains on this refuge's observed protected return path. */
  canReturn(): boolean {
    const plan = this.plan;
    return (
      plan !== null &&
      this.protected() &&
      [plan.protected, plan.corner, plan.entrance, plan.fighting].some((cell) => this.at(cell))
    );
  }

  at(cell: Vec3): boolean {
    return this.bot.entity.onGround && this.bot.entity.position.distanceTo(cell.offset(0.5, 0, 0.5)) < 0.35;
  }

  adoptExisting(): void {
    this.plan = this.findCover(0);
  }

  private findCover(blocks: number): CombatPositionPlan | null {
    const target = positionThreat(this.bot, this.target);
    return findCombatPosition(
      this.navigation.world,
      this.cell,
      // A deliberate hunt can select a target beyond the nearby-threat census.
      [target, ...this.threats().filter((threat) => threat.id !== target.id)],
      target,
      blocks,
      undefined,
      this.acceptsCover,
    );
  }

  /** Price the same local cover that execution can build, including existing terrain. */
  planCover(): { readonly kind: "ready"; readonly plan: CombatPositionPlan } | ProtectionRefusal {
    const available = this.policy().terrain.place ? countCapBlocks(this.bot) : 0;
    const plan = this.findCover(available);
    if (plan) return { kind: "ready", plan };
    if (!this.policy().terrain.place)
      return {
        kind: "unreachable",
        reason: "[COMBAT_CONSTRAINED] No usable existing cover; construction is prohibited.",
      };
    const buildable = this.findCover(Infinity);
    if (buildable)
      return {
        kind: "materials_missing",
        reason: `[COMBAT_BUILD_MATERIALS_MISSING] Defensive cover construction needs ${buildable.placements.length} usable building blocks at the selected position; ${available} carried.`,
      };
    return {
      kind: "unreachable",
      reason: "[COMBAT_COVER_UNAVAILABLE] No local protected fighting position with a supported exit was observed.",
    };
  }

  /** Keep the same refuge and bend while peeking one supported step around its entrance. */
  findAttackOpening(canAttack: (feet: Vec3) => boolean): void {
    const plan = this.plan;
    if (!plan || canAttack(plan.fighting.offset(0.5, 0, 0.5))) return;
    const candidates = [
      plan.entrance,
      ...[new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)].map((side) =>
        plan.entrance.plus(side),
      ),
    ];
    const fighting = candidates.find(
      (cell) =>
        !cell.equals(plan.corner) &&
        !cell.equals(plan.protected) &&
        standingCell(this.navigation.world, cell) &&
        canAttack(cell.offset(0.5, 0, 0.5)),
    );
    if (fighting) this.plan = { ...plan, fighting };
  }

  /** One finite arrangement attempt. Each placement checks the body and the preserved passage again. */
  async establish(signal: AbortSignal, footing: SupportedPositionHold): Promise<ProtectionRefusal | null> {
    const searchScope = this.searchScope();
    let planned = this.planCover();
    if (planned.kind === "unreachable") {
      const stopped = await this.seekPosition(
        {
          resolve: () => {
            const target = positionThreat(this.bot, this.target);
            const threats = [target, ...this.threats().filter((threat) => threat.id !== target.id)];
            const blocks = this.policy().terrain.place ? countCapBlocks(this.bot) : 0;
            return {
              kind: "active",
              revision: `cover:${JSON.stringify(threats)}:${blocks}:${this.rejectedCoverCount}`,
              heuristic: () => 0,
              isSatisfied: ({ feet }, world) => {
                const cell = new Vec3(feet.x, feet.y, feet.z);
                return findCombatPosition(world, cell, threats, target, blocks, [cell], this.acceptsCover) !== null;
              },
            };
          },
        },
        createMovements(this.bot, {
          allowDigging: false,
          scaffolding: false,
          allowSprinting: false,
          allowParkour: false,
          // Seek a verified protected destination using navigation's ordinary
          // safe descent. A one-block limit strands this search on a two-high
          // fortress parapet even when the supported floor is reachable.
        }),
        signal,
        footing,
      );
      if (stopped) {
        signal.throwIfAborted();
        const why = `Cover position approach stopped: ${stopped}`;
        this.answered.remember(searchScope, { kind: "search_stopped", why });
        return { kind: "unreachable", reason: why };
      }
      planned = this.planCover();
    }
    if (planned.kind !== "ready") {
      this.answered.remember(searchScope, { kind: planned.kind, why: planned.reason });
      return planned;
    }
    const plan = planned.plan;
    const reject = (reason: string): ProtectionRefusal => {
      signal.throwIfAborted();
      this.plan = plan;
      this.rejectCover(reason);
      return { kind: "unreachable", reason };
    };
    try {
      const reached = await this.move(plan.protected, signal, footing);
      if (reached) return reject(reached);
      footing.start();
      const built = await buildProtection(this.bot, plan.placements, {
        signal,
        terrain: this.policy().terrain,
        mayContinue: () => {
          if (
            !this.at(plan.protected) ||
            ![plan.protected, plan.corner, plan.fighting].every((at) => standingCell(this.navigation.world, at))
          )
            return "The body or the return passage changed during cover construction.";
          if (
            this.threats().some(
              (threat) =>
                threat.attack !== "projectile" &&
                positionExposed(positionWorld(this.navigation.world), this.bot.entity, threat),
            )
          )
            return "A contact attacker reached the construction position.";
          return null;
        },
      });
      if (built.kind === "blocked") return reject(built.reason);
      this.plan = plan;
      return this.protected() ? null : reject("The finished position is still exposed or its return path is blocked.");
    } finally {
      // The engagement still owns this hold, including after a failed build.
      footing.start();
    }
  }

  fireAt(cell: Vec3): boolean {
    return fireAt(this.bot, cell);
  }

  /** Punch only fire, without excavation, changing tools or releasing the body's hold. */
  async extinguishFireAt(cell: Vec3, signal: AbortSignal): Promise<"clear" | "blocked"> {
    for (const at of [cell, cell.offset(0, 1, 0)]) {
      if ((await extinguishFireAt(this.bot, at, signal, this.policy().terrain.dig)) === "blocked") return "blocked";
    }
    return "clear";
  }

  async move(
    cell: Vec3,
    signal: AbortSignal,
    footing: SupportedPositionHold,
    stopSignal?: AbortSignal,
  ): Promise<string | null> {
    if (!standingCell(this.navigation.world, cell)) return "The protection cell is no longer safe to occupy.";
    if (this.at(cell)) return null;
    await footing.stop();
    try {
      const result = await this.navigation.navigate({
        movements: createMovements(this.bot, {
          allowDigging: false,
          scaffolding: false,
          allowSprinting: false,
          allowParkour: false,
          maximumDrop: 0,
        }),
        goal: exactBlockGoal(cell),
        signal,
        stopSignal,
        stepField: null,
        searchLimits: { maximumRadius: Math.max(4, Math.ceil(cell.distanceTo(this.bot.entity.position)) + 2) },
      });
      // A hit can arrive as navigation releases its successful route. Finish
      // that physical handoff before judging the standing-cell postcondition.
      footing.start();
      await footing.stop();
      if (
        !this.at(cell) &&
        this.bot.entity.onGround &&
        this.cell.equals(cell) &&
        standingCell(this.navigation.world, cell)
      ) {
        await centerOnCell(
          steeringPortFor(this.bot, (control, state) => this.bot.setControlState(control, state)),
          cell,
          signal,
        );
      }
      return this.at(cell)
        ? null
        : result.status === "stopped"
          ? result.reason
          : `Cover movement reached ${this.bot.entity.position}, onGround=${this.bot.entity.onGround}, instead of standing at ${cell}.`;
    } finally {
      footing.start();
    }
  }

  /** Navigation owns reachability; the supplied goal owns the protection geometry. */
  private async seekPosition(
    goal: Goal,
    movements: MovementPolicy,
    signal: AbortSignal,
    footing: SupportedPositionHold,
    stopSignal?: AbortSignal,
  ): Promise<string | null> {
    await footing.stop();
    try {
      const result = await this.navigation.navigate({
        movements,
        goal,
        signal,
        stopSignal,
        stepField: null,
        searchLimits: { maximumRadius: COMBAT_APPROACH_RADIUS },
      });
      signal.throwIfAborted();
      return result.status === "stopped" ? result.reason : null;
    } finally {
      footing.start();
    }
  }
}
