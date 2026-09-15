import { Vec3 } from "vec3";
import { hideInPlace } from "../../../src/survival/responses/hide.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";

export const run: MineAiScenario = async (context) => {
  await standStill(context);
  const start = context.bot.entity.position.clone();
  const blocksBefore = context.bot.inventory
    .items()
    .filter((item) => item.name === "cobblestone")
    .reduce((sum, item) => sum + item.count, 0);
  const started = Date.now();
  using responseOwner1 = new ScenarioCombat(context.bot, context.navigation);
  const result = await hideInPlace(context.bot, {
    threatContext: {
      ...responseOwner1.context,
      resolvedIds: new Set(),
      attackerIds: new Set(),
      unreachableIds: new Set(),
    },
    signal: context.signal,
    recoverTo: 18,
    maximumMs: 1000,
  });
  const feet = context.bot.entity.position.floored();
  const shell = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
    .flatMap((side) => [feet.plus(side), feet.plus(side).offset(0, 1, 0)])
    .concat(feet.offset(0, 2, 0));
  const open = shell.filter((cell) => context.bot.blockAt(cell)?.boundingBox !== "block");
  const blocksAfter = context.bot.inventory
    .items()
    .filter((item) => item.name === "cobblestone")
    .reduce((sum, item) => sum + item.count, 0);
  const expected =
    context.scenario.params?.expectFailure === true
      ? result.kind === "failed" && open.length > 0 && blocksAfter === 0
      : result.kind === "recovered" && open.length === 0;
  return {
    status: expected && feet.equals(start.floored()) ? "succeeded" : "failed",
    detail: JSON.stringify({
      result,
      start,
      end: context.bot.entity.position,
      open,
      blocksBefore,
      blocksAfter,
      elapsedMs: Date.now() - started,
    }),
  };
};
