import type { BotEvents } from "mineflayer";
import { engageTarget } from "../../../src/actions/hunt-mob/hunt-mob.ts";
import { ScenarioCombat } from "../../src/combat.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

/** Server-observed damage during a real engagement, without changing production combat policy. */
export const run: MineAiScenario = async ({ bot, navigation, signal }) => {
  const target = bot.nearestEntity((entity) => entity.name === "zombie");
  if (!target) return { status: "failed", detail: "The arranged zombie was not observed." };
  const stop = new AbortController();
  let hurt = false;
  let injected = false;
  let hitsAfterHurt = 0;
  const onHealth = () => {
    if (bot.health < 12) hurt = true;
  };
  const onHurt: BotEvents["entityHurt"] = (entity) => {
    if (entity.id !== target.id) return;
    if (hurt) {
      hitsAfterHurt++;
      stop.abort("The regression already observed an attack after the health boundary.");
    } else if (!injected) {
      injected = true;
      bot.chat(`/damage ${bot.username} 10 minecraft:generic`);
    }
  };
  bot.on("health", onHealth);
  bot.on("entityHurt", onHurt);
  try {
    using scenarioCombat1 = new ScenarioCombat(bot, navigation);
const { outcome } = await engageTarget(bot, scenarioCombat1.controller, target, {
      signal: AbortSignal.any([signal, stop.signal]),
    });
    return {
      status: hurt && hitsAfterHurt === 0 && outcome.kind === "capability_blocked" && outcome.reason === "recovery" ? "succeeded" : "failed",
      detail: `health ${bot.health}; hurt ${hurt}; subsequent target hits ${hitsAfterHurt}; outcome ${outcome.kind}; attacks ${outcome.attacks}`,
    };
  } finally {
    bot.off("health", onHealth);
    bot.off("entityHurt", onHurt);
  }
};
