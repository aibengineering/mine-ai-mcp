import { Vec3 } from "vec3";
import { hideInPlace } from "../../../src/survival/responses/hide.ts";
import { standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { ScenarioCombat } from "../../src/combat.ts";

export const run: MineAiScenario = async (context) => {
  await standStill(context);
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
  const closed = shell.every(
    (cell) => context.bot.blockAt(cell)?.name === "dirt" || context.bot.blockAt(cell)?.name === "grass_block",
  );
  return {
    status: result.kind === "recovered" && feet.y <= -63 && closed ? "succeeded" : "failed",
    detail: `${JSON.stringify(result)}; feet=${feet}; shellClosed=${closed}`,
  };
};
