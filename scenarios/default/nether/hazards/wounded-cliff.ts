import { Vec3 } from "vec3";
import { DEFAULT_COMBAT_POLICY } from "../../../../src/survival/policy/combat/contract.ts";
import { readEncounters } from "../../../flat/combat/reflex.ts";
import { declaredEntitiesArranged, openRuntime } from "../../../src/runtime.ts";
import type { MineAiScenario } from "../../../src/scenario-client.ts";

import { isAngry, watch } from "./observe.ts";
import { arrange, cliff, observe } from "./pit.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, log } = context;
  await arrange(context, cliff);
  const healthBefore = bot.health;
  await declaredEntitiesArranged(context);
  const target = Object.values(bot.entities).find((e) => e.name === "enderman")!;
  const runtime = await openRuntime(context, "wounded-nether-cliff");
  const observation = watch(bot, cliff, () => runtime.status().activeAction?.action);
  try {
    try {
      // Administrative arrangement ends before this visible, ordinary gaze stimulus.
      log(
        `Gaze stimulus begins: target ${target.id}, player health ${bot.health}, player ${bot.entity.position}, target ${target.position}.`,
      );
      await bot.lookAt(target.position.offset(0, 2.6, 0), true);
      await observe(bot, () => isAngry(bot, target), "native angry enderman after gaze");
      for (let tick = 0; tick < 1200 && bot.health > 0; tick++) {
        context.signal.throwIfAborted();
        await bot.waitForTicks(1);
      }
      const restingFeet = bot.entity.position.floored();
      const shellPositions = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
        .flatMap((side) => [restingFeet.plus(side), restingFeet.plus(side).offset(0, 1, 0)])
        .concat(restingFeet.offset(0, 2, 0));
      const shell = () =>
        shellPositions.map((position) => ({
          position,
          name: bot.blockAt(position)?.name,
          solid: bot.blockAt(position)?.boundingBox === "block",
        }));
      let coveredTicks = 0,
        nearbyAngryTicks = 0;
      // Independently inspect the completed shelter through the full live-runtime dwell.
      for (let tick = 0; tick < 100; tick++) {
        context.signal.throwIfAborted();
        await bot.waitForTicks(1);
        const supported = bot.blockAt(restingFeet.offset(0, -1, 0))?.boundingBox === "block";
        const bodyClear = [restingFeet, restingFeet.offset(0, 1, 0)].every(
          (p) => bot.blockAt(p)?.boundingBox === "empty",
        );
        if (
          shell().every((cell) => cell.solid) &&
          supported &&
          bodyClear &&
          bot.entity.position.floored().equals(restingFeet) &&
          bot.entity.onGround &&
          !runtime.status().busy &&
          bot.health > 0
        )
          coveredTicks++;
        const attacker = bot.entities[target.id];
        if (attacker && isAngry(bot, attacker) && attacker.position.distanceTo(bot.entity.position) < 8)
          nearbyAngryTicks++;
      }
      const encounters = await readEncounters(context, runtime);
      const evidence = observation.evidence();
      const pressure = evidence.angryAtLip !== null;
      const escaped = encounters.some((e) => e.response === "evade" && e.outcome === "safe_separation");
      const hidden = encounters.some((e) => e.response === "hide" && e.outcome === "hidden");
      const finalTarget = bot.entities[target.id];
      const separation = finalTarget ? finalTarget.position.distanceTo(bot.entity.position) : null;
      const idle = !runtime.status().busy;
      const finalShell = shell();
      const safeCover = hidden && coveredTicks === 100 && finalShell.every((cell) => cell.solid);
      const safeEscape = escaped && separation !== null && separation >= DEFAULT_COMBAT_POLICY.evade_safe_range;
      const passed =
        healthBefore >= 8 &&
        healthBefore < 12 &&
        evidence.deaths === 0 &&
        !evidence.lava &&
        evidence.maximumUnsupportedDescent <= 3 &&
        bot.health > 0 &&
        bot.entity.onGround &&
        bot.game.dimension === "the_nether";
      return {
        status: passed ? "succeeded" : "failed",
        detail: JSON.stringify({
          verdict: passed ? "survived native cliff contact" : "survival or footing goal unmet",
          pressure,
          safeCover,
          safeEscape,
          serverArmorConfirmed: true,
          healthBefore,
          finalHealth: bot.health,
          targetId: target.id,
          separation,
          coveredTicks,
          nearbyAngryTicks,
          finalShell,
          idle,
          encounters,
          ...evidence,
        }),
      };
    } finally {
      await runtime.close();
    }
  } finally {
    observation.close();
  }
};
