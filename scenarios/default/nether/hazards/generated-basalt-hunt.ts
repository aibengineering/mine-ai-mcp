import type { BotEvents } from "mineflayer";
import { Vec3 } from "vec3";
import {
  declaredEntities,
  declaredEntitiesArranged,
  declaredStart,
  openRuntime,
  standStill,
  wearArmor,
} from "../../../src/runtime.ts";
import type { MineAiScenario } from "../../../src/scenario-client.ts";
import { observe } from "./pit.ts";

/** The scenario file declares the cubes; their NBT carries the size the body check needs. */
function cubeSize(nbt: string): number {
  const size = /Size:(\d+)/u.exec(nbt);
  if (!size) throw new Error(`Declared magma cube has no Size in its NBT: ${nbt}`);
  return Number(size[1]);
}

/** Fresh seeded terrain: only players and mobs are arranged, never blocks. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal } = context;
  const start = declaredStart(context);
  const cubes = declaredEntities(context).filter(({ name }) => name === "magma_cube");
  await bot.waitForChunksToLoad();
  for (const p of [start, ...cubes.map((cube) => cube.position)]) {
    if (
      !["basalt", "blackstone"].includes(bot.blockAt(p.offset(0, -1, 0))?.name ?? "") ||
      ![0, 1, 2].every((dy) => bot.blockAt(p.offset(0, dy, 0))?.name.endsWith("air"))
    )
      throw new Error(`Generated standing cell changed: ${p}`);
  }
  let biomeConfirmed = false;
  const confirm = (message: string) => {
    if (message === "BASALT_CONFIRMED") biomeConfirmed = true;
  };
  bot.on("messagestr", confirm);
  try {
    bot.chat('/execute if biome ~ ~ ~ minecraft:basalt_deltas run tellraw @s "BASALT_CONFIRMED"');
    await observe(bot, () => biomeConfirmed, "server-confirmed basalt deltas biome");
  } finally {
    bot.off("messagestr", confirm);
  }
  if (!(await standStill(context))) throw new Error("Could not settle on generated basalt.");
  await wearArmor(context);
  for (const cube of cubes) {
    const [x, y, z] = cube.position.floored().toArray();
    // NBT Size is one less than the native cube size. Check its whole body so
    // the fixture cannot manufacture a trapped mob by summoning it into basalt.
    const width = bot.registry.entitiesByName.magma_cube!.width! * (cubeSize(cube.nbt) + 1);
    for (let bx = Math.floor(x + 0.5 - width / 2); bx < x + 0.5 + width / 2; bx++) {
      for (let bz = Math.floor(z + 0.5 - width / 2); bz < z + 0.5 + width / 2; bz++) {
        for (let by = y; by < y + width; by++) {
          if (bot.blockAt(new Vec3(bx, by, bz))?.boundingBox !== "empty")
            throw new Error(`Cube body intersects generated terrain at ${bx},${by},${bz}.`);
        }
      }
    }
  }
  await declaredEntitiesArranged(context);
  await observe(
    bot,
    () => Object.values(bot.entities).filter((e) => e.name === "magma_cube").length === cubes.length,
    "arranged magma cubes",
  );
  const cream = bot.registry.itemsByName.magma_cream!.id;
  const before = bot.inventory.count(cream, null);
  const runtime = await openRuntime(context, "generated-basalt-hunt");
  let minimumHealth = bot.health;
  let deaths = 0;
  let lava = false;
  let magma = false;
  const deadCubes = new Set<number>();
  const onHealth = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const onDeath = () => {
    deaths++;
  };
  const onDead: BotEvents["entityDead"] = (e) => {
    if (e.name === "magma_cube") deadCubes.add(e.id);
  };
  const onTick = () => {
    lava ||= Reflect.get(bot.entity, "isInLava") === true || bot.blockAt(bot.entity.position)?.name === "lava";
    magma ||= bot.entity.onGround && bot.blockAt(bot.entity.position.offset(0, -0.1, 0))?.name === "magma_block";
  };
  bot.on("health", onHealth);
  bot.on("death", onDeath);
  bot.on("entityDead", onDead);
  bot.on("physicsTick", onTick);
  let hunt: Awaited<ReturnType<typeof runtime.run>> | undefined;
  let returned: Awaited<ReturnType<typeof runtime.run>> | undefined;
  try {
    // Last administrative command; later observations do not probe via chat.
    // Cubes hop, split, attack and drop normal loot under native AI.
    bot.chat("/execute as @e[tag=basalt_hunt] run data merge entity @s {NoAI:0b}");
    const huntAction = runtime.actions.find((a) => a.name === "collect_mob_drop")!;
    hunt = await runtime.run(huntAction, { mob_name: "magma_cube", drop_name: "magma_cream", count: 1 }, signal);
    if (deaths > 0)
      return {
        status: "failed",
        detail: JSON.stringify({ deaths, minimumHealth, lava, magma, huntStatus: hunt?.result.status }),
      };
    const navigate = runtime.actions.find((a) => a.name === "navigate")!;
    returned = await runtime.run(
      navigate,
      { x: Math.floor(start.x), y: Math.floor(start.y), z: Math.floor(start.z), range: 1 },
      signal,
    );
    await bot.waitForTicks(60);
    const gained = bot.inventory.count(cream, null) - before;
    const atStart = bot.entity.position.distanceTo(start) <= 2;
    const passed = gained >= 1 && atStart && deaths === 0 && !lava && !magma;
    return {
      status: passed ? "succeeded" : "failed",
      detail: JSON.stringify({
        biomeConfirmed,
        gained,
        atStart,
        activeAction: runtime.status().activeAction,
        deaths,
        minimumHealth,
        lava,
        magma,
        deadCubes: deadCubes.size,
        huntStatus: hunt?.result.status,
        huntError: hunt && "error" in hunt.result ? hunt.result.error : undefined,
        returnStatus: returned.result.status,
        returnError: "error" in returned.result ? returned.result.error : undefined,
      }),
    };
  } finally {
    bot.off("health", onHealth);
    bot.off("death", onDeath);
    bot.off("entityDead", onDead);
    bot.off("physicsTick", onTick);
    await runtime.close();
  }
};
