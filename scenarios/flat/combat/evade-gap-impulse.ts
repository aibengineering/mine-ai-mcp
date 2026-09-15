import type { HostileContext } from "../../../src/survival/control/combat/context.ts";
import { observeHostileResponse } from "../../../src/survival/control/combat/observation.ts";
import { executeHostileResponse } from "../../../src/survival/control/combat/respond.ts";
import { completeResponse, encounterReceipt } from "../../../src/survival/control/combat/settlement.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import { hurt } from "./reflex.ts";

/** Replay the velocity interruption that made a fortress retreat miss its gap. */
export const run: MineAiScenario = async (context) => {
  const { bot, navigation, signal } = context;
  await standStill(context);
  if (!(await hurt(context, 11))) throw new Error("Could not arrange retreat health.");
  await bot.waitForTicks(12);
  const threats: HostileContext = {
    resolvedIds: new Set(),
    attackerIds: new Set(),
    unreachableIds: new Set(),
  };
  const request = observeHostileResponse(bot, threats);
  if (request.kind !== "evade") throw new Error(`Expected evade, observed ${request.kind}.`);
  let injected = false;
  let parkour = false;
  let lowest = bot.entity.position.y;
  const release = navigation.onEvent((event) => {
    if (event.kind === "step_started" && event.movement === "parkour") parkour = true;
  });
  const tick = () => {
    lowest = Math.min(lowest, bot.entity.position.y);
    if (!injected && parkour && !bot.entity.onGround && bot.entity.position.x > 3.3) {
      injected = true;
      // Native eyes trace at 1788830713502: horizontal momentum was reset
      // during the four-block jump. Rotate its z-directed flight onto x.
      bot._client.emit("entity_velocity", {
        entityId: bot.entity.id,
        velocity: { x: 0, y: 1318, z: 0 },
      });
    }
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
    await bot.waitForTicks(20);
    // There is no supported escape in this arrangement and no blocks carried.
    // A truthful capability limit on the starting platform is safer than a
    // momentum-dependent gap jump while hits can interrupt the flight.
    return {
      status: bot.health === 11 && lowest >= -56 && bot.entity.onGround ? "succeeded" : "failed",
      detail: JSON.stringify({ outcome, parkour, injected, lowest, health: bot.health, position: bot.entity.position }),
    };
  } finally {
    release();
    bot.off("physicsTick", tick);
  }
};
