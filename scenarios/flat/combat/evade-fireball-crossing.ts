import type { HostileContext } from "../../../src/survival/control/combat/context.ts";
import { observeHostileResponse } from "../../../src/survival/control/combat/observation.ts";
import { executeHostileResponse } from "../../../src/survival/control/combat/respond.ts";
import { completeResponse, encounterReceipt } from "../../../src/survival/control/combat/settlement.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { hurt } from "./reflex.ts";

/** Native projectile crosses the retreat's next cells, initially missing its current body. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal, log } = context;
  await standStill(context);
  if (!(await hurt(context, 11))) throw new Error("Could not arrange retreat health.");
  await bot.waitForTicks(12);
  const shield = bot.inventory.items().find((item) => item.name === "shield")!;
  await bot.equip(shield, "off-hand");
  const threats: HostileContext = {
    resolvedIds: new Set(),
    attackerIds: new Set(),
    unreachableIds: new Set(),
  };
  const request = observeHostileResponse(bot, threats);
  if (request.kind !== "evade") throw new Error(`Expected evade, observed ${request.kind}.`);
  let launched = false;
  let spawned = false;
  let minimumHealth = bot.health;
  const start = bot.entity.position.clone();
  const tick = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
    if (
      !launched &&
      bot.entity.position.distanceTo(start) >= 4 &&
      bot.getControlState("forward") &&
      bot.getControlState("sprint")
    ) {
      launched = true;
      const p = bot.entity.position;
      // Shot 427's recorded ray, advanced five observed-velocity ticks so
      // the crossing tests the shield's readiness deadline. This isolates
      // timing, rather than claiming to replay the entire fortress route.
      bot.chat(
        `/summon small_fireball ${p.x - 2.313} ${p.y + 1.6144} ${p.z + 8.0195} {Motion:[0.5174d,-0.0818d,-1.1401d]}`,
      );
    }
    const projectiles = Object.values(bot.entities).filter((e) => e.name === "small_fireball");
    spawned ||= projectiles.length > 0;
    if (projectiles.length)
      log(
        `CROSSING ${JSON.stringify({
          position: bot.entity.position,
          yaw: bot.entity.yaw,
          controls: { forward: bot.getControlState("forward"), sprint: bot.getControlState("sprint") },
          health: bot.health,
          projectiles: projectiles.map((e) => ({ position: e.position, velocity: e.velocity })),
        })}`,
      );
  };
  bot.on("physicsTick", tick);
  try {
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
    const outcome = encounterReceipt(
      completeResponse(
        await executeHostileResponse(
          bot,
          navigation,
          scenarioCombat1.controller,
          request,
          { ...scenarioCombat1.context, ...threats, perception: scenarioCombat1.perception },
          bot.health,
          signal,
        ),
        signal,
      ),
    );
    await bot.waitForTicks(25);
    return {
      status: spawned && minimumHealth === 11 && outcome.outcome === "safe_separation" ? "succeeded" : "failed",
      detail: JSON.stringify({ outcome, spawned, minimumHealth, health: bot.health }),
    };
  } finally {
    bot.off("physicsTick", tick);
  }
};
