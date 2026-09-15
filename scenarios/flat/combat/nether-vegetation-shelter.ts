import { Vec3 } from "vec3";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { buildProtection, fullProtectionBlock } from "../../../src/survival/positioning/combat/build-protection.ts";

export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  if (!(await standStill(context))) throw new Error("Builder did not settle.");
  const cells = [-1, 0, 1].flatMap((z) => [new Vec3(1, -60, z), new Vec3(1, -59, z)]);
  const before = cells.filter((cell) => cell.y === -60).map((cell) => bot.blockAt(cell)?.name);
  if (!before.includes("warped_roots") || !before.includes("crimson_roots") || !before.includes("nether_sprouts"))
    throw new Error(`Native vegetation missing: ${before}`);
  const result = await buildProtection(bot, cells, { signal, terrain: { dig: false, place: true }, mayContinue: () => null });
  return { status: result.kind === "built" && cells.every((cell) => fullProtectionBlock(bot.blockAt(cell))) ? "succeeded" : "failed",
    detail: JSON.stringify({ before, result, after: cells.map((cell) => bot.blockAt(cell)?.name) }) };
};
