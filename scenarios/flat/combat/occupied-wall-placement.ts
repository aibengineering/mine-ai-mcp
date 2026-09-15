import { Vec3 } from "vec3";
import { placeBlock } from "../../../src/world/placement.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";

export const run: MineAiScenario = async ({ bot, signal, log }) => {
  const target = new Vec3(0, -60, -1);
  let packets = 0;
  const original = bot._client.write;
  bot._client.write = function (name, data) {
    if (name === "block_place") packets++;
    return original.call(bot._client, name, data);
  };
  const count = () =>
    bot.inventory
      .items()
      .filter((item) => item.name === "cobblestone")
      .reduce((sum, item) => sum + item.count, 0);
  try {
    bot.chat("/summon minecraft:wither_skeleton 0.5 -60 -0.1 {NoAI:1b,PersistenceRequired:1b}");
    await bot.waitForTicks(10);
    const skeleton = bot.nearestEntity((entity) => entity.name === "wither_skeleton");
    const item = bot.inventory.items().find((item) => item.name === "cobblestone");
    const support = bot.blockAt(target.offset(0, -1, 0));
    if (!skeleton || !item || !support) throw new Error("Fixture blocks or skeleton missing");
    const request = {
      item,
      support,
      face: new Vec3(0, 1, 0),
      expectedCells: [target] as [Vec3],
      matches: (block: NonNullable<ReturnType<typeof bot.blockAt>>) => block.name === "cobblestone",
      signal,
    };
    const before = count();
    const started = Date.now();
    const blocked = await placeBlock(bot, request);
    const elapsedMs = Date.now() - started;
    const packetCount = () => packets;
    const blockedPackets = packets;
    if (
      blocked.kind !== "failed" ||
      !blocked.error.includes(`wither_skeleton #${skeleton.id}`) ||
      packets !== 0 ||
      count() !== before ||
      bot.blockAt(target)?.name !== "air"
    )
      return {
        status: "failed",
        detail: `Occupied wall was not refused before sending: ${JSON.stringify({ blocked, packets, before, after: count() })}`,
      };
    bot.chat("/tp @e[type=minecraft:wither_skeleton,limit=1] 4.5 -60 -1.5");
    await bot.waitForTicks(10);
    const clear = await placeBlock(bot, request);
    const evidence = {
      blocked,
      elapsedMs,
      blockedPackets,
      clear,
      packets,
      before,
      after: count(),
      skeleton: skeleton.position,
    };
    log(JSON.stringify({ ...evidence, clear: clear.kind }));
    return {
      status:
        clear.kind === "placed" &&
        packetCount() === 1 &&
        count() === before - 1 &&
        bot.blockAt(target)?.name === "cobblestone"
          ? "succeeded"
          : "failed",
      detail: JSON.stringify({ ...evidence, clear: clear.kind }),
    };
  } finally {
    bot._client.write = original;
  }
};
