import type { HostileContext } from "../../../src/survival/control/combat/context.ts";
import { executeHostileResponse } from "../../../src/survival/control/combat/respond.ts";
import { completeResponse, encounterReceipt } from "../../../src/survival/control/combat/settlement.ts";
import { CombatPerception } from "../../../src/survival/perception/combat/observations.ts";
import { DEFAULT_COMBAT_POLICY } from "../../../src/survival/policy/combat/contract.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";

/** Keep native arrow collision and shield mechanics, but remove random launch spread. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, navigation, log } = context;
  await standStill(context);
  await bot.equip(
    bot.inventory.items().find((item) => item.name === "shield")!,
    "off-hand",
  );
  bot.chat("/attribute @s minecraft:max_health base set 11");
  while (bot.health !== 11) {
    signal.throwIfAborted();
    await bot.waitForTicks(1);
  }
  using perception = new CombatPerception(bot);
  let shots = 0,
    blocked = 0,
    guardedTicks = 0,
    lowestHealth = bot.health;
  const useIndex = bot.registry.entitiesByName.player!.metadataKeys!.indexOf("living_entity_flags");
  const spawned = (entity: typeof bot.entity) => {
    if (entity.name === "arrow") shots++;
  };
  const status = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === 29) blocked++;
  };
  const tick = () => {
    lowestHealth = Math.min(lowestHealth, bot.health);
    const flags: unknown = bot.entity.metadata[useIndex];
    if (typeof flags === "number" && (flags & 3) === 3) guardedTicks++;
  };
  bot.on("entitySpawn", spawned);
  bot._client.on("entity_status", status);
  bot.on("physicsTick", tick);
  try {
    bot.chat(
      '/summon minecraft:skeleton 0.5 -60 12.5 {PersistenceRequired:1b,HandItems:[{id:"minecraft:bow",count:1},{}]}',
    );
    while (shots === 0) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const skeleton = Object.values(bot.entities).find((entity) => entity.isValid && entity.name === "skeleton")!;
    const arrow = Object.values(bot.entities).find((entity) => entity.isValid && entity.name === "arrow")!;
    // Arrange the skeleton's actual arrow before invoking evasion: a repeatable
    // incoming arc, with enough flight time for vanilla's five-tick shield
    // readiness. Native spread otherwise made a safe guard fail for not
    // blocking a shot that missed, or sent a close shot before readiness.
    // Keep the shooter behind its arranged arrow, outside the collision path.
    bot.chat(`/tp ${skeleton.uuid} 0.5 -60 24.5`);
    while (skeleton.position.z < 20) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    bot.chat(`/data merge entity ${arrow.uuid} {Pos:[0.5d,-58.5d,16.5d],Motion:[0.0d,0.15d,-1.6d]}`);
    while (arrow.position.z < 12) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }

    const healthBefore = bot.health;
    const start = bot.entity.position.clone();
    // This fixture tests the physical evade response. Admission is explicit so
    // an early fight or a missed arrow cannot change which behavior is tested.
    const threats: HostileContext = {
      perception,
      resolvedIds: perception.resolvedIds,
      attackerIds: new Set([skeleton.id]),
      unreachableIds: new Set(),
    };
    log(`RETREAT_START ${JSON.stringify({ healthBefore, start, shots, skeleton: skeleton.position })}`);
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
    const result = encounterReceipt(
      completeResponse(
        await executeHostileResponse(
          bot,
          navigation,
          scenarioCombat1.controller,
          {
            kind: "evade",
            reason: "hurt",
            safeRange: DEFAULT_COMBAT_POLICY.evade_safe_range,
            threats: [
              {
                id: skeleton.id,
                name: "skeleton",
                position: skeleton.position.clone(),
                distance: skeleton.position.distanceTo(start),
              },
            ],
          },
          { ...scenarioCombat1.context, ...threats, perception },
          healthBefore,
          signal,
        ),
        signal,
      ),
    );
    await bot.waitForTicks(20);
    const distance = bot.entity.position.distanceTo(skeleton.position);
    const evidence = {
      result,
      shots,
      blocked,
      guardedTicks,
      healthBefore,
      lowestHealth,
      health: bot.health,
      start,
      end: bot.entity.position,
      distance,
    };
    log(`RETREAT_RESULT ${JSON.stringify(evidence)}`);
    return {
      status:
        result.outcome === "safe_separation" &&
        healthBefore === 11 &&
        lowestHealth === 11 &&
        distance >= DEFAULT_COMBAT_POLICY.evade_safe_range
          ? "succeeded"
          : "failed",
      detail: JSON.stringify(evidence),
    };
  } finally {
    bot.off("entitySpawn", spawned);
    bot._client.off("entity_status", status);
    bot.off("physicsTick", tick);
  }
};
