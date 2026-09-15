import assert from "node:assert/strict";
import { isBurning, isInLava } from "../../../src/survival/perception/body.ts";
import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  // The pool surface is one below the dry start the scenario file put the bot on.
  const poolY = Math.floor(bot.entity.position.y) - 1;
  assert.ok(await standStill(context));
  assert.equal(bot.health, 20, "The fixture must begin without prior lava damage.");
  await using runtime = await openRuntime(context, "lava-escape-step");
  let died = false;
  const death = () => {
    died = true;
  };
  bot.on("death", death);
  try {
    // No natural bank lies within the reflex's four-block local reach.
    bot.chat(`/tp @s 0.5 ${poolY} 0.5`);
    let contact = false;
    let claimed = false;
    for (let tick = 0; tick < 340 && !died; tick++) {
      signal.throwIfAborted();
      contact ||= isInLava(bot);
      claimed ||= runtime.status().activeAction?.action === "fire_reflex";
      if (tick % 10 === 0)
        log(
          JSON.stringify({
            tick,
            position: bot.entity.position,
            health: bot.health,
            lava: isInLava(bot),
            burning: isBurning(bot),
            owner: runtime.status().activeAction,
          }),
        );
      await bot.waitForTicks(1);
    }
    const detail = JSON.stringify({
      died,
      contact,
      claimed,
      health: bot.health,
      lava: isInLava(bot),
      burning: isBurning(bot),
      position: bot.entity.position,
      blocks: bot.inventory.count(bot.registry.itemsByName.cobblestone!.id, null),
    });
    assert.ok(!died && contact && bot.health > 0 && !isInLava(bot) && !isBurning(bot), detail);
    return { status: "succeeded", detail };
  } finally {
    bot.off("death", death);
  }
};
