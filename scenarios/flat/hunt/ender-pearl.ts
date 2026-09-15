import type { ClientCompletion } from "mine-labs/client";
import { run as hunt } from "../../src/hunter.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

/** Record ammunition use without prescribing the hunt's weapon choice. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const arrow = context.bot.registry.itemsByName.arrow!;
  const before = context.bot.inventory.count(arrow.id, null);
  let minimum = before;
  const observeArrows = () => {
    minimum = Math.min(minimum, context.bot.inventory.count(arrow.id, null));
  };
  context.bot.inventory.on("updateSlot", observeArrows);
  try {
    const result = await hunt(context);
    const after = context.bot.inventory.count(arrow.id, null);
    const detail = `${result.detail}; arrows ${before} -> ${after}, minimum ${minimum}`;
    return { ...result, detail };
  } finally {
    context.bot.inventory.off("updateSlot", observeArrows);
  }
}
