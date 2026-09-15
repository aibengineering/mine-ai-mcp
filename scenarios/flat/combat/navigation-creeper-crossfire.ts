import { NAVIGATE } from "@aibengineering/mine-ai-mcp";
import { Vec3 } from "vec3";
import { z } from "zod";
import { isSwelling } from "../../../src/survival/perception/combat/creepers.ts";
import { declaredEntitiesArranged, openRuntime } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export { prepare } from "./navigation-mixed-creeper-management.ts";

/** A normal journey through native melee, ranged and fuse threats. Telemetry
 * observes the production owner; it never selects a target or forces a response. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const { destination } = z.strictObject({
    destination: z.tuple([z.number().int(), z.number().int(), z.number().int()]),
  }).parse(context.scenario.params);
  await declaredEntitiesArranged(context);
  const runtime = await openRuntime(context, "creeper-crossfire");
  const died = new AbortController();
  let ticks = 0;
  let mixedTicks = 0;
  let minimumHealth = bot.health;
  let explosions = 0;
  const dead = new Set<number>();
  let previousState = "";
  const observe = (event: string) => {
    const hostiles = Object.values(bot.entities)
      .filter((entity) => entity.isValid && !dead.has(entity.id) && ["creeper", "husk", "zombie", "skeleton"].includes(entity.name ?? ""))
      .map((entity) => ({
        id: entity.id, name: entity.name, position: entity.position,
        distance: bot.entity.position.distanceTo(entity.position),
        swelling: entity.name === "creeper" && isSwelling(bot, entity),
      }));
    const mixed = hostiles.some((entity) => entity.name === "creeper" && entity.distance < 8) &&
      hostiles.some((entity) => entity.name !== "creeper" && entity.distance < 12);
    if (event === "tick" && mixed) mixedTicks++;
    minimumHealth = Math.min(minimumHealth, bot.health);
    const status = runtime.status();
    const { owner, response } = status.survival;
    const state = JSON.stringify([response?.phase, bot.health, hostiles.filter((entity) => entity.swelling).map((entity) => entity.id)]);
    if (event !== "tick" || state !== previousState || ticks % 10 === 0) {
      context.log(JSON.stringify({ event: `crossfire_${event}`, ticks, position: bot.entity.position,
        health: bot.health, owner, response, targetId: status.combat?.targetId, usingItem: bot.usingHeldItem,
        sprint: bot.getControlState("sprint"), hostiles }));
      previousState = state;
    }
  };
  const tick = () => { ticks++; observe("tick"); };
  const explosion = () => { explosions++; observe("explosion"); };
  const death = () => { observe("death"); died.abort("Bot died during the journey."); };
  const entityDead = (entity: typeof bot.entity) => { dead.add(entity.id); };
  bot.on("physicsTick", tick);
  bot.on("death", death);
  bot.on("entityDead", entityDead);
  bot._client.on("explosion", explosion);
  try {
    const [x, y, zPosition] = destination;
    const output = await runtime.run(runtime.actions.find((action) => action.name === NAVIGATE)!,
      { x, y, z: zPosition, range: 1 }, AbortSignal.any([signal, died.signal]));
    context.log(`NAVIGATION ${JSON.stringify(output)}`);
    const reached = bot.entity.position.distanceTo(new Vec3(x + 0.5, y, zPosition + 0.5)) <= 2;
    return {
      status: reached && !died.signal.aborted && minimumHealth >= 12 && mixedTicks > 0 ? "succeeded" : "failed",
      detail: JSON.stringify({ reached, mixedTicks, minimumHealth, explosions }),
    };
  } catch (cause) {
    if (!died.signal.aborted) throw cause;
    return { status: "failed", detail: JSON.stringify({ died: true, mixedTicks, minimumHealth, explosions }) };
  } finally {
    observe("finished");
    bot.off("physicsTick", tick);
    bot.off("death", death);
    bot.off("entityDead", entityDead);
    bot._client.off("explosion", explosion);
    await runtime.close();
  }
};
