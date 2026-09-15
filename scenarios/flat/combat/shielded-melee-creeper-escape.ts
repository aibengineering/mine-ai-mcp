import { ScenarioCombat } from "../../src/combat.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Native fuse and movement physics test the shield-to-sprint transition. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  if (!(await standStill(context))) throw new Error("Initial footing did not settle");
  const target = Object.values(bot.entities).find((entity) => entity.name === "zombie");
  if (!target) throw new Error("The arranged melee target was not loaded");
  const done = new AbortController();
  using scenarioCombat1 = new ScenarioCombat(bot, navigation);
const combat = scenarioCombat1.controller;
  let elapsed = 0;
  const attack = bot.attack.bind(bot);
  let spawned = false;
  let shieldObserved = false;
  let sprintTicks = 0;
  let slowedSprintTicks = 0;
  let restingCrouchTicks = 0;
  let clearTicks = 0;
  let maximumSeparation = 0;
  let minimumHealth = bot.health;
  let explosions = 0;
  const onExplosion = () => {
    explosions++;
  };
  bot.attack = (...args) => {
    attack(...args);
    if (spawned) return;
    spawned = true;
    const p = bot.entity.position;
    bot.chat(`/summon minecraft:creeper ${p.x + 3.8} ${p.y} ${p.z} {PersistenceRequired:1b}`);
  };
  const tick = () => {
    if (++elapsed % 20 === 0)
      context.log(
        JSON.stringify({
          position: bot.entity.position,
          phase: combat.execution(),
          spawned,
          shieldObserved,
          sprintTicks,
          slowedSprintTicks,
          clearTicks,
          maximumSeparation,
          minimumHealth,
          explosions,
        }),
      );
    minimumHealth = Math.min(minimumHealth, bot.health);
    const flags: unknown = bot.entity.metadata?.[8];
    shieldObserved ||= typeof flags === "number" && (flags & 3) === 3;
    const moving = (["forward", "back", "left", "right"] as const).some((control) => bot.getControlState(control));
    if (!spawned && !moving && bot.getControlState("sneak")) restingCrouchTicks++;
    if (bot.getControlState("sprint") && bot.getControlState("forward")) {
      sprintTicks++;
      if (bot.usingHeldItem || bot.getControlState("sneak")) slowedSprintTicks++;
    }
    const creeper = Object.values(bot.entities).find((entity) => entity.name === "creeper" && entity.isValid);
    const separation = creeper?.position.distanceTo(bot.entity.position) ?? 0;
    maximumSeparation = Math.max(maximumSeparation, separation);
    clearTicks = separation >= 8 ? clearTicks + 1 : 0;
    if (clearTicks >= 10) done.abort("Observed sustained escape from the native creeper.");
  };
  bot.on("physicsTick", tick);
  bot._client.on("explosion", onExplosion);
  try {
    const outcome = await combat.engage(target.id, AbortSignal.any([signal, done.signal]), "hold");
    return {
      status:
        done.signal.aborted &&
        shieldObserved &&
        sprintTicks > 0 &&
        slowedSprintTicks === 0 &&
        restingCrouchTicks === 0 &&
        explosions === 0 &&
        minimumHealth === 20
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({
        outcome,
        shieldObserved,
        sprintTicks,
        slowedSprintTicks,
        restingCrouchTicks,
        maximumSeparation,
        minimumHealth,
        explosions,
      }),
    };
  } finally {
    bot.attack = attack;
    bot.off("physicsTick", tick);
    bot._client.off("explosion", onExplosion);
  }
};
