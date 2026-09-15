import { openRuntime, standStill } from "../../src/runtime.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { readEncounters } from "../combat/reflex.ts";
import { z } from "zod";
import { Vec3 } from "vec3";

const paramsSchema = z.object({
  mob: z.enum(["enderman", "skeleton", "magma_cube"]).default("enderman"),
  arrival: z.tuple([z.number(), z.number(), z.number()]).default([-130.5, 47, 197.61474899858322]),
});

/** A scripted teleport delivers the threat; the server owns every hit and knockback. */
export const run: MineAiScenario = async (context) => {
  const { bot, signal, log } = context;
  const { mob, arrival } = paramsSchema.parse(context.scenario.params ?? {});
  if (!(await standStill(context))) throw new Error("The shelf spawn did not settle.");
  const runtime = await openRuntime(context, "enderman-ledge");
  let ticks = 0;
  let hits = 0;
  let shieldBlocks = 0;
  let landedAttacks = 0;
  let edgeContacts = 0;
  let deaths = 0;
  let lava = false;
  let minimumY = bot.entity.position.y;
  const scaffoldsBefore = bot.inventory
    .items()
    .filter((item) => item.name === "cobblestone")
    .reduce((sum, item) => sum + item.count, 0);
  const placedBlocks: { x: number; y: number; z: number }[] = [];
  const blockUpdate: import("mineflayer").BotEvents["blockUpdate"] = (before, after) => {
    if (before?.name !== "cobblestone" && after?.name === "cobblestone") {
      placedBlocks.push({ ...after.position });
      log(`SCAFFOLD_OBSERVED ${JSON.stringify(after.position)}`);
    }
  };
  const frame = () => ({
    tick: ticks,
    position: bot.entity.position.clone(),
    velocity: bot.entity.velocity.clone(),
    onGround: bot.entity.onGround,
    health: bot.health,
    offHand: bot.inventory.slots[45]?.name ?? null,
    owner: runtime.status().owner,
    action: runtime.status().activeAction?.action ?? null,
    controls: Object.fromEntries(
      (["forward", "back", "left", "right", "jump", "sprint", "sneak"] as const).map((control) => [
        control,
        bot.getControlState(control),
      ]),
    ),
  });
  const atEdge = () => {
    if (!bot.entity.onGround || bot.entity.position.y !== 47) return false;
    const feet = bot.entity.position.floored();
    return [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ].some(([dx, dz]) => {
      const x = feet.x + dx!;
      const z = feet.z + dz!;
      return bot.blockAt(new Vec3(x, 46, z))?.name === "air" && bot.blockAt(new Vec3(x, 31, z))?.name === "lava";
    });
  };
  const hurt = (packet: { entityId: number; sourceCauseId: number }) => {
    if (packet.sourceCauseId === bot.entity.id + 1 && bot.entities[packet.entityId]?.name === mob) landedAttacks++;
    if (packet.entityId !== bot.entity.id || bot.entities[packet.sourceCauseId - 1]?.name !== mob) return;
    hits++;
    if (atEdge()) edgeContacts++;
    log(`NATIVE_HIT ${JSON.stringify({ ...frame(), atEdge: atEdge() })}`);
  };
  const status = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId !== bot.entity.id || packet.entityStatus !== 29) return;
    shieldBlocks++;
    if (atEdge()) edgeContacts++;
    log(`NATIVE_SHIELD_BLOCK ${JSON.stringify({ ...frame(), atEdge: atEdge() })}`);
  };
  let dyingPosition: ReturnType<typeof frame> | null = null;
  const death = () => {
    dyingPosition = frame();
    deaths++;
  };
  const tick = () => {
    if (deaths > 0) return;
    ticks++;
    minimumY = Math.min(minimumY, bot.entity.position.y);
    lava ||= Reflect.get(bot.entity, "isInLava") === true;
    log(`LEDGE_TICK ${JSON.stringify(frame())}`);
  };
  bot._client.on("damage_event", hurt);
  bot._client.on("entity_status", status);
  bot.on("death", death);
  bot.on("physicsTick", tick);
  bot.on("blockUpdate", blockUpdate);
  try {
    const uuid = Buffer.from(bot.player.uuid.replaceAll("-", ""), "hex");
    const angryAt = [0, 4, 8, 12].map((offset) => uuid.readInt32BE(offset)).join(",");
    // Stage outside local hostile observation, so the bot cannot approach it.
    const equipment = mob === "skeleton" ? ',HandItems:[{id:"minecraft:bow",count:1},{}]' : "";
    bot.chat(
      `/summon ${mob} -128.5 57 240.5 {NoAI:1b,Size:3,PersistenceRequired:1b,Tags:["ledge_arrival"]${equipment}}`,
    );
    for (let waited = 0; waited < 40 && !bot.nearestEntity((entity) => entity.name === mob); waited++)
      await bot.waitForTicks(1);
    if (!bot.nearestEntity((entity) => entity.name === mob)) throw new Error(`The staged ${mob} was not observed.`);
    await bot.waitForTicks(20);
    if (!atEdge() || bot.entity.position.distanceTo(new Vec3(-128.53437787507164, 47, 197.61474899858322)) > 0.05)
      throw new Error("The bot left the starting edge before the contact stimulus.");
    log(`TELEPORT_CONTACT ${JSON.stringify(frame())}`);
    // Arrive on the opposite (west) side, aligned with the bot in z.
    // Native pursuit closes the gap; its hit pushes east toward the lava.
    // Assign anger before arrival, rather than introducing a neutral target
    // locally and only then assigning the intended aggression.
    bot.chat(`/data merge entity @e[tag=ledge_arrival,limit=1] {AngerTime:600,AngryAt:[I;${angryAt}]}`);
    bot.chat(`/tp @e[tag=ledge_arrival,limit=1] ${arrival.join(" ")}`);
    bot.chat(`/data merge entity @e[tag=ledge_arrival,limit=1] {NoAI:0b}`);
    // Twenty seconds covers arrival, melee cooldowns and delayed lava damage.
    // No teleport, freeze, damage injection or rescue occurs after this release.
    while (ticks < 400 && deaths === 0) {
      signal.throwIfAborted();
      await bot.waitForTicks(1);
    }
    const encounters = await readEncounters(context, runtime);
    await runtime.captureIncident();
    return {
      status:
        edgeContacts > 0 && deaths === 0 && !lava && minimumY >= 47 && bot.entity.onGround ? "succeeded" : "failed",
      detail: JSON.stringify({
        hits,
        shieldBlocks,
        landedAttacks,
        edgeContacts,
        deaths,
        lava,
        minimumY,
        placedBlocks,
        scaffoldsBefore,
        scaffoldsAfter: bot.inventory
          .items()
          .filter((item) => item.name === "cobblestone")
          .reduce((sum, item) => sum + item.count, 0),
        encounters,
        dyingPosition,
        final: frame(),
      }),
    };
  } finally {
    bot._client.off("damage_event", hurt);
    bot._client.off("entity_status", status);
    bot.off("death", death);
    bot.off("physicsTick", tick);
    bot.off("blockUpdate", blockUpdate);
    await runtime.close();
  }
};
