import { openRuntime, wearArmor } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { readEncounters, watchShield, watchExplosions } from "./reflex.ts";
import { z } from "zod";

/** Follow every declared attacker through a mixed fight, including permitted creeper blasts. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const params = z
    .object({ maxExplosions: z.number().int().nonnegative().default(0) })
    .parse(context.scenario.params ?? {});
  const names = new Set(context.scenario.entities?.map((entity) => entity.type));
  const targets = Object.values(bot.entities).filter((e) => names.has(e.name ?? ""));
  const expected = context.scenario.entities ?? [];
  if (targets.length !== expected.length || [...names].some(name =>
    targets.filter(target => target.name === name).length !== expected.filter(target => target.type === name).length))
    throw new Error("The mixed encounter needs all declared targets loaded, with matching species counts.");
  const dead = new Set<number>();
  const onDeath: Parameters<typeof bot.on<"entityDead">>[1] = (entity) => {
    if (targets.some((target) => target.id === entity.id)) dead.add(entity.id);
  };
  bot.on("entityDead", onDeath);
  const shield = watchShield(context);
  const explosions = watchExplosions(context);
  // A permitted creeper explosion discards it without an entityDead event.
  const resolved = () =>
    targets.every(
      (target) => dead.has(target.id) || (target.name === "creeper" && !target.isValid && explosions.count() > 0),
    );
  const runtime = await openRuntime(context, "mixed-fight");
  const logState = () => context.log(`MIXED_STATE ${JSON.stringify({
    health: bot.health, dead: [...dead], explosions: explosions.count(), position: bot.entity.position,
    targets: targets.map(target => ({ id: target.id, name: target.name, valid: target.isValid,
      distance: target.position.distanceTo(bot.entity.position) })), survival: runtime.status().survival,
  })}`);
  try {
    await wearArmor(context);
    // Wait for every declared attacker; the YAML owns the encounter deadline.
    let ticks = 0;
    for (;;) {
      signal.throwIfAborted();
      if (resolved()) break;
      await bot.waitForTicks(1);
      if (++ticks % 200 === 0) logState();
    }
    const encounters = await readEncounters(context, runtime);
    return {
      status: resolved() && bot.health > 0 && explosions.count() <= params.maxExplosions ? "succeeded" : "failed",
      detail: JSON.stringify({
        dead: [...dead],
        explosions: explosions.count(),
        targets: targets.map((e) => ({ id: e.id, name: e.name })),
        owner: runtime.status().owner,
        health: bot.health,
        encounters,
        shield: shield.summary(),
      }),
    };
  } finally {
    logState();
    bot.off("entityDead", onDeath);
    shield.close();
    explosions.close();
    await runtime.close();
  }
};
