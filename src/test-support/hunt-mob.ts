/**
 * The collect_mob_drop test world: a bot with loaded mobs and one counted
 * drop, a pursuit that walks straight to each, and effects that script the
 * fights. Shared by the hunt's own tests and its shield-gate tests.
 */
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../navigation/index.js";
import type { HuntTarget } from "../navigation/processes/hunting/hunt-process.js";
import type { CombatController, CombatOutcome } from "../survival/index.js";
import { SurvivalPolicyState } from "../survival/state/survival-policy.js";
import { botFixture, registry } from "./bot.js";
import type { HuntMobRequest } from "../actions/hunt-mob/contract.js";
import type { HuntMobDependencies, TargetEngagement } from "../actions/hunt-mob/hunt-mob.js";

export type Entity = Parameters<Bot["attack"]>[0];

export function mob(id: number, entityType: number, name: string, x: number, kind = "Passive mobs"): Entity {
  return {
    id,
    entityType,
    name,
    kind,
    isValid: true,
    position: new Vec3(x, 64, 0),
    height: 1.3,
  } as Entity;
}

/** A plain hunt for one white wool: no spawner camp and no observation window. */
export function huntRequest(mobName: string, allowWithoutShield = false): HuntMobRequest {
  return { campSpawner: false, allowWithoutShield, observeForMs: 0, mobName, dropName: "white_wool", count: 1 };
}

/** A bot beside `targets` whose inventory counts `inventory.count` white wool and nothing else. */
export function huntBot(targets: readonly Entity[], inventory: { count: number }, health = 20): Bot {
  const bot = botFixture(
    { position: new Vec3(0, 64, 0), entities: Object.fromEntries(targets.map((target) => [target.id, target])) },
    {
      health,
      blockAt: () => null,
      world: { raycast: () => null },
      nearestEntity: (predicate: (entity: Entity) => boolean) => targets.find(predicate) ?? null,
    },
  );
  bot.entity.id = 0;
  // The wool count is scripted: the hunt's effects credit a drop by raising it.
  bot.inventory.count = (itemId: number) => (itemId === registry.itemsByName.white_wool!.id ? inventory.count : 0);
  bot.inventory.emptySlotCount = () => 36;
  return bot;
}

/**
 * A pursuit that reaches every matching loaded mob in turn, nearest first.
 *
 * The walk itself is the hunt process's own subject, tested against a fake
 * route in `hunt-process.test.ts`. What these tests ask is what the action
 * makes of each thing the pursuit can report, so this stands in for the walk
 * and for nothing else.
 */
export function pursueLoaded(bot: Bot): HuntMobDependencies["pursue"] {
  return async (pursuit) => {
    const retired = new Set<number>();
    // The real process's rule: an unreachable fight is a stop on that target,
    // and a second stop gives it up.
    type Sighting = {
      readonly id: number;
      readonly position: { x: number; y: number; z: number };
      readonly distance: number;
    };
    const stops = new Map<number, number>();
    let lastStop: { readonly target: Sighting; readonly reason: string } | null = null;
    let previous: HuntTarget | null = null;
    let selectionReason = "Initial target selection.";
    const describe = (reason: string, target: Sighting) =>
      `${reason}; the target was last observed at ` +
      `${target.position.x},${target.position.y},${target.position.z}, ${target.distance.toFixed(1)} blocks away`;
    while (!pursuit.isSatisfied()) {
      const targets = Object.values(bot.entities)
        .filter((entity) => !retired.has(entity.id) && pursuit.matches(entity))
        .map((entity) => ({
          id: entity.id,
          position: {
            x: Math.floor(entity.position.x),
            y: Math.floor(entity.position.y),
            z: Math.floor(entity.position.z),
          },
          distance: entity.position.distanceTo(bot.entity.position),
        }))
        .sort((left, right) => left.distance - right.distance);
      await pursuit.onTargets?.(targets);
      const target = targets[0];
      if (!target) {
        return lastStop
          ? { status: "unreachable", reason: describe(lastStop.reason, lastStop.target) }
          : { status: "no_targets", reason: null };
      }
      if (previous?.id !== target.id)
        pursuit.onTargetChanged?.({ previous, selected: target, reason: selectionReason });
      previous = target;
      const refused = pursuit.preflight?.(bot.entities[target.id]!);
      if (refused) return { status: "capability_blocked", reason: describe(refused, target) };
      const engagement = await pursuit.engage(target.id);
      if (engagement.kind === "stopped") return { status: "stopped", reason: describe(engagement.reason, target) };
      if (engagement.kind === "unreachable") {
        const count = (stops.get(target.id) ?? 0) + 1;
        stops.set(target.id, count);
        lastStop = { target, reason: engagement.reason };
        selectionReason = engagement.reason;
        if (count >= 2) retired.add(target.id);
        continue;
      }
      retired.add(target.id);
      selectionReason =
        engagement.kind === "defeated" ? "The previous engagement was completed." : "The previous target was lost.";
    }
    return { status: "satisfied", reason: null };
  };
}

export function outcome(kind: CombatOutcome["kind"], attacks: number, extra: Partial<CombatOutcome> = {}): CombatOutcome {
  return {
    kind,
    targetId: 0,
    attacks,
    stylesUsed: ["melee"],
    weaponsUsed: ["iron_sword"],
    shieldRaisedSwings: 0,
    projectileGuards: 0,
    explosions: 0,
    observation: "",
    ...extra,
  } as CombatOutcome;
}

export function died(attacks: number, x: number): TargetEngagement {
  return { outcome: outcome("died", attacks), deathPosition: { x, y: 64, z: 0 } };
}

/**
 * Hunt effects that play `engagements` in order, credit one drop to
 * `inventory` per collected death, and sweep `swept` other drops after each.
 */
export function dependencies(
  bot: Bot,
  inventory: { count: number },
  engagements: readonly TargetEngagement[],
  swept = 0,
): HuntMobDependencies {
  let engagementIndex = 0;
  return {
    createCamp: () => {
      throw new Error("Unexpected camping");
    },
    finish: fakeCombat.finish,
    pursue: pursueLoaded(bot),
    engageTarget: async () => {
      const result = engagements[engagementIndex];
      engagementIndex += 1;
      assert.ok(result, `the test scripted no engagement #${engagementIndex}`);
      return result;
    },
    collectDropAfterDeath: async () => {
      inventory.count += 1;
      return { kind: "collected" };
    },
    sweepDropsAfterDeath: async () => swept,
    gatherLoadedDrops: async () => 0,
    shieldPermitted: () => true,
  };
}

export const fakeNavigation = { cancel: () => undefined } as unknown as NavigationRuntime;
/** A combat controller that loses every target and hands off safely. */
export const fakeCombat: CombatController = {
  resourceRefusal: () => null,
  policy: new SurvivalPolicyState({} as Bot),
  engage: async () => outcome("target_lost", 0),
  stop: async () => undefined,
  runEnd: async () => {
    throw new Error("Unexpected End combat");
  },
  endDanger: () => false,
  activePosition: () => null,
  execution: () => null,
  onDecision: () => () => {},
  finish: async () => ({
    observedAt: 1,
    kind: "safe" as const,
    basis: "clear" as const,
    position: { x: 0, y: 64, z: 0 },
  }),
  canRecover: () => false,
  activeEngagement: () => null,
};
