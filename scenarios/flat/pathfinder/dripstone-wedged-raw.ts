import { z } from "zod";
import { ActionRunner, createRawAction } from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.object({
  wedge: z.tuple([z.number(), z.number(), z.number()]),
  dig: z.tuple([z.number(), z.number(), z.number()]),
});

export async function prepare({
  bot,
  scenario,
  log,
}: MineAiScenarioContext): Promise<void> {
  const [x, y, z] = paramsSchema.parse(scenario.params).wedge;
  const tip = bot.blockAt(new Vec3(0, -58, 0));
  const properties = tip?.getProperties() ?? null;
  log(
    JSON.stringify({
      kind: "wedge_tip_before_tp",
      name: tip?.name ?? null,
      properties,
      shapes: tip?.shapes ?? null,
    }),
  );
  if (
    tip?.name !== "pointed_dripstone" ||
    properties?.vertical_direction !== "up" ||
    tip.shapes.length === 0
  )
    throw new Error(
      `Supported upward pointed-dripstone tip was not observed before teleport: ${tip?.name ?? "unloaded"}.`,
    );
  const target = new Vec3(x, y, z);
  const moved = new Promise<void>((resolve, reject) => {
    let ticks = 0;
    const observe = () => {
      if (bot.entity.position.distanceTo(target) <= 0.1) {
        bot.off("physicsTick", observe);
        resolve();
      } else if (++ticks >= 40) {
        bot.off("physicsTick", observe);
        reject(
          new Error(
            `Wedge teleport was not observed at ${bot.entity.position}.`,
          ),
        );
      }
    };
    bot.on("physicsTick", observe);
  });
  bot.chat(`/tp @s ${x} ${y} ${z}`);
  await moved;
  await bot.waitForTicks(5);
}

export async function run({
  bot,
  scenario,
  signal,
  log,
}: MineAiScenarioContext): Promise<ClientCompletion> {
  const [x, y, z] = paramsSchema.parse(scenario.params).dig;
  const runner = new ActionRunner();
  const action = createRawAction(bot);
  const digOutput = await runner.run(
    action,
    { operation: "dig", x, y, z },
    signal,
  );
  log(JSON.stringify(digOutput));
  const controlOutput = await runner.run(
    action,
    { operation: "control", state: "sneak", ticks: 3 },
    signal,
  );
  log(JSON.stringify(controlOutput));
  const placeOutput = await runner.run(
    action,
    {
      operation: "place",
      block_name: "cobblestone",
      x: 0,
      y: -59,
      z: 0,
      face: "west",
    },
    signal,
  );
  log(JSON.stringify(placeOutput));
  const result = digOutput.result;
  const afterBlock = bot.blockAt(new Vec3(x, y, z))?.name ?? null;
  const placed = bot.blockAt(new Vec3(-1, -59, 0))?.name ?? null;
  const succeeded =
    result.status === "succeeded" &&
    "effectObserved" in result &&
    result.effectObserved === true &&
    controlOutput.result.status === "succeeded" &&
    "attempted" in controlOutput.result &&
    controlOutput.result.attempted &&
    placeOutput.result.status === "succeeded" &&
    "effectObserved" in placeOutput.result &&
    placeOutput.result.effectObserved === true &&
    afterBlock === "air" &&
    placed === "cobblestone";
  return {
    status: succeeded ? "succeeded" : "failed",
    detail: `dig=${result.status}/${"effectObserved" in result ? result.effectObserved : "runtime_failure"}; control=${controlOutput.result.status}/${"attempted" in controlOutput.result ? controlOutput.result.attempted : "runtime_failure"}; place=${placeOutput.result.status}/${"effectObserved" in placeOutput.result ? placeOutput.result.effectObserved : "runtime_failure"}; afterBlock=${afterBlock}; placed=${placed}; position=${bot.entity.position}`,
  };
}
