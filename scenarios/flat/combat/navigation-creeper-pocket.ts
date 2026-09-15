import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { z } from "zod";
import { isSwelling } from "../../../src/survival/perception/combat/creepers.ts";
import { declaredEntitiesArranged, openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export { prepare } from "./navigation-creeper-blocked-retreat.ts";

/** Escape the pocket and finish the journey. Telemetry never chooses a tactic. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const { destination } = z.strictObject({
    destination: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  }).parse(context.scenario.params);
  await declaredEntitiesArranged(context);
  const runtime = await openRuntime(context, "creeper-pocket");
  const died = new AbortController();
  let ticks = 0;
  let minimumHealth = bot.health;
  let explosions = 0;
  let mixedTicks = 0;
  let previous = "";
  const dead = new Set<number>();
  const observe = (event: string) => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    const hostiles = Object.values(bot.entities)
      .filter(entity => entity.isValid && !dead.has(entity.id) && ["creeper", "spider", "skeleton", "zombie"].includes(entity.name ?? ""))
      .map(entity => ({ id: entity.id, name: entity.name, position: entity.position,
        distance: entity.position.distanceTo(bot.entity.position),
        swelling: entity.name === "creeper" && isSwelling(bot, entity) }));
    if (event === "tick" && hostiles.some(entity => entity.name === "creeper" && entity.distance < 8) &&
      hostiles.some(entity => entity.name !== "creeper" && entity.distance < 12)) mixedTicks++;
    const status = runtime.status();
    const state = JSON.stringify([bot.health, status.survival.response?.phase, status.combat?.targetId,
      hostiles.filter(entity => entity.swelling).map(entity => entity.id)]);
    if (event !== "tick" || state !== previous || ticks % 20 === 0) {
      context.log(`POCKET_STATE ${JSON.stringify({ event, ticks, position: bot.entity.position, health: bot.health,
        owner: status.survival.owner, response: status.survival.response, targetId: status.combat?.targetId,
        hostiles, explosions, mixedTicks })}`);
      previous = state;
    }
  };
  const tick = () => { ticks++; observe("tick"); };
  const explosion = () => { explosions++; observe("explosion"); };
  const death = () => { minimumHealth = 0; observe("death"); died.abort("Died before escaping the pocket."); };
  const entityDead = (entity: typeof bot.entity) => { dead.add(entity.id); };
  bot.on("physicsTick", tick);
  bot.on("death", death);
  bot.on("entityDead", entityDead);
  bot._client.on("explosion", explosion);
  const summary = (reached: boolean) => ({ reached, died: died.signal.aborted, minimumHealth, explosions, mixedTicks });
  try {
    const [x, y, zPosition] = destination;
    const output = await runtime.run(runtime.actions.find(action => action.name === NAVIGATE)!,
      { x, y, z: zPosition, range: 1 }, AbortSignal.any([signal, died.signal]));
    context.log(`NAVIGATION ${JSON.stringify(output)}`);
    const reached = bot.entity.position.distanceTo(new Vec3(x + 0.5, y, zPosition + 0.5)) <= 2;
    return { status: reached && bot.health > 0 && !died.signal.aborted ? "succeeded" : "failed", detail: JSON.stringify(summary(reached)) };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return { status: "failed", detail: JSON.stringify(summary(false)) };
  } finally {
    observe("finished");
    bot.off("physicsTick", tick);
    bot.off("death", death);
    bot.off("entityDead", entityDead);
    bot._client.off("explosion", explosion);
    await runtime.close();
  }
};
