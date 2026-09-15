import type { ClientCompletion } from "mine-labs/client";
import type { BotEvents } from "mineflayer";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as runIdleReflex } from "./idle-reflex.ts";

/** Record contact timing; survival is valid regardless of the chosen response. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  let tick = 0;
  let enteredReach: number | null = null;
  let firstHit: number | null = null;
  const onTick = () => {
    tick += 1;
    if (enteredReach !== null) return;
    const target = Object.values(bot.entities).find((entity) => entity.name === "zombie");
    if (target && target.position.distanceTo(bot.entity.position) <= 3) enteredReach = tick;
  };
  const onHurt: BotEvents["entityHurt"] = (entity) => {
    if (entity.name === "zombie" && firstHit === null) firstHit = tick;
  };
  bot.on("physicsTick", onTick);
  bot.on("entityHurt", onHurt);
  try {
    const completion = await runIdleReflex(context);
    const delay = enteredReach !== null && firstHit !== null ? firstHit - enteredReach : null;
    const detail = `First hit ${delay ?? "unobserved"} ticks after entering reach; ${completion.detail}`;
    return { ...completion, detail };
  } finally {
    bot.off("physicsTick", onTick);
    bot.off("entityHurt", onHurt);
  }
}
