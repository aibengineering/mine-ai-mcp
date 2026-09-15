import { Vec3 } from "vec3";
import { z } from "zod";
import {
  declaredEntities,
  declaredEntitiesArranged,
  declaredStart,
  openRuntime,
  standStill,
  wearArmor,
} from "../../../src/runtime.ts";
import type { MineAiScenario } from "../../../src/scenario-client.ts";
import { readEncounters, type Encounter } from "../../../flat/combat/reflex.ts";
import { observe } from "./pit.ts";

/** Native terrain and AI, with only player equipment/health and mob positions arranged. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const { kind } = z.object({ kind: z.enum(["wounded", "lower_ledge"]) }).parse(context.scenario.params);
  const start = declaredStart(context);
  const cubes = declaredEntities(context).map(({ position }) => position);
  await bot.waitForChunksToLoad();
  const safeFloor = (at: Vec3) => ["basalt", "blackstone"].includes(bot.blockAt(at.offset(0, -1, 0))?.name ?? "");
  if (!safeFloor(start)) throw new Error(`Missing native basalt support at ${start}.`);
  if (kind === "lower_ledge") {
    // This exposed shelf was surveyed on the fresh seeded world. Five blocks
    // below and inside eight-block proximity, its cube cannot strike the bot.
    const lower = cubes[0]!;
    const eye = start.offset(0, 1.62, 0);
    const toward = lower.offset(0, 0.52, 0).minus(eye);
    if (
      !safeFloor(lower) ||
      lower.distanceTo(start) >= 8 ||
      ![0, 1].every((dy) => bot.blockAt(lower.offset(0, dy, 0))?.boundingBox === "empty") ||
      bot.world.raycast(eye, toward.scaled(1 / toward.norm()), toward.norm())
    )
      throw new Error("The exposed lower-shelf geometry changed.");
  }
  if (!(await standStill(context))) throw new Error("Could not settle on native shelf.");
  await wearArmor(context);
  await declaredEntitiesArranged(context);
  await observe(
    bot,
    () => Object.values(bot.entities).filter((e) => e.name === "magma_cube").length === cubes.length,
    "native cubes",
  );
  let minimumHealth = bot.health;
  let deaths = 0;
  let lava = false;
  let magma = false;

  const health = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const death = () => {
    deaths++;
  };
  const tick = () => {
    lava ||= Reflect.get(bot.entity, "isInLava") === true;
    magma ||= bot.entity.onGround && bot.blockAt(bot.entity.position.offset(0, -0.1, 0))?.name === "magma_block";
  };
  bot.on("health", health);
  bot.on("death", death);
  bot.on("physicsTick", tick);
  const runtime = await openRuntime(context, `basalt-${kind}`);
  const encounters: Encounter[] = [];
  let returned;
  try {
    bot.chat("/execute as @e[tag=reflex_trial] run data merge entity @s {NoAI:0b}");
    if (kind === "lower_ledge") {
      const action = runtime.actions.find((a) => a.name === "navigate")!;
      returned = await runtime.run(action, { x: 185, y: 49, z: -20, range: 1 }, signal);
    } else {
      for (let waited = 0; waited < 400 && deaths === 0; waited++) {
        signal.throwIfAborted();
        await bot.waitForTicks(1);
        if (waited % 5 === 0) encounters.push(...(await readEncounters(context, runtime)));
      }
    }
    await bot.waitForTicks(60);
    encounters.push(...(await readEncounters(context, runtime)));
    const met =
      kind === "wounded"
        ? bot.health > 0
        : returned?.result.status === "succeeded" && bot.entity.position.distanceTo(new Vec3(185.5, 49, -19.5)) <= 2;
    return {
      status: met && !lava && !magma && deaths === 0 ? "succeeded" : "failed",
      detail: JSON.stringify({ kind, cubes, start, returned, encounters, minimumHealth, deaths, lava, magma }),
    };
  } finally {
    bot.off("health", health);
    bot.off("death", death);
    bot.off("physicsTick", tick);
    await runtime.close();
  }
};
