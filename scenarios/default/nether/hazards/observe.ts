import type { Bot } from "mineflayer";
import { z } from "zod";
import { droppedItemName } from "../../../../src/world/item-pickup.ts";
import type { Site } from "./pit.ts";

const damageSchema = z.object({ entityId: z.number(), sourceCauseId: z.number(), sourceDirectId: z.number() });

export function isAngry(bot: Bot, entity: Bot["entity"]): boolean {
  const index = bot.registry.entitiesByName.enderman!.metadataKeys!.indexOf("creepy");
  const value: unknown = entity.metadata[index];
  return value === true;
}

/** Passive native evidence begins before any gaze stimulus and lives through recovery. */
export function watch(bot: Bot, site: Site, owner: () => string | undefined) {
  const start = Date.now();
  const snapshot = () => ({
    ms: Date.now() - start,
    position: bot.entity.position.clone(),
    velocity: bot.entity.velocity.clone(),
    health: bot.health,
    owner: owner(),
    onGround: bot.entity.onGround,
    support: bot.blockAt(bot.entity.position.offset(0, -0.1, 0))?.name,
    mobs: Object.values(bot.entities)
      .filter((e) => e.name === "enderman")
      .map((e) => ({ id: e.id, position: e.position.clone(), creepy: isAngry(bot, e) })),
  });
  let angryAtLip: ReturnType<typeof snapshot> | null = null;
  let gapPursuit: ReturnType<typeof snapshot> | null = null;
  const damage: Array<
    z.output<typeof damageSchema> & {
      ms: number;
      attackerId: number;
      directId: number;
      position: Bot["entity"]["position"];
    }
  > = [];
  const deadIds: number[] = [];
  const pearlDrops = new Set<number>();
  let deaths = 0,
    minimumY = bot.entity.position.y,
    minimumHealth = bot.health,
    lava = false,
    maximumUnsupportedDescent = 0;
  let supportY = bot.entity.position.y;
  let blocks = 0;
  let angryNear = 0;
  const onTick = () => {
    const position = bot.entity.position;
    minimumY = Math.min(minimumY, position.y);
    minimumHealth = Math.min(minimumHealth, bot.health);
    lava ||= Reflect.get(bot.entity, "isInLava") === true || bot.blockAt(position)?.name === "lava";
    maximumUnsupportedDescent = Math.max(maximumUnsupportedDescent, supportY - position.y);
    if (bot.entity.onGround) supportY = position.y;
    const mobs = Object.values(bot.entities).filter((entity) => entity.name === "enderman");
    if (position.distanceTo(site.start.offset(0.5, 0, 0.5)) <= 2) {
      if (
        owner() === "hostile_reflex" &&
        mobs.some((entity) => isAngry(bot, entity) && entity.position.distanceTo(position) < 8)
      )
        angryAtLip ??= snapshot();
      if (
        owner() === "collect_mob_drop" &&
        mobs.length === 1 &&
        mobs[0]!.position.distanceTo(site.target.offset(0.5, 0, 0.5)) < 2
      )
        gapPursuit ??= snapshot();
    }
    if (mobs.some((entity) => isAngry(bot, entity) && entity.position.distanceTo(position) < 8)) angryNear++;
    for (const entity of Object.values(bot.entities))
      if (droppedItemName(entity) === "ender_pearl") pearlDrops.add(entity.id);
  };
  const onDamage = (raw: unknown) => {
    const packet = damageSchema.parse(raw);
    damage.push({
      ms: Date.now() - start,
      ...packet,
      attackerId: packet.sourceCauseId - 1,
      directId: packet.sourceDirectId - 1,
      position: bot.entity.position.clone(),
    });
  };
  const onDeath = () => {
    deaths++;
  };
  const onHealth = () => {
    minimumHealth = Math.min(minimumHealth, bot.health);
  };
  const onDead = (entity: Bot["entity"]) => {
    deadIds.push(entity.id);
  };
  const onStatus = (packet: { entityId: number; entityStatus: number }) => {
    if (packet.entityId === bot.entity.id && packet.entityStatus === 29) {
      blocks++;
    }
  };
  bot.on("physicsTick", onTick);
  bot.on("death", onDeath);
  bot.on("health", onHealth);
  bot.on("entityDead", onDead);
  bot._client.on("damage_event", onDamage);
  bot._client.on("entity_status", onStatus);
  return {
    evidence: () => ({
      deaths,
      minimumY,
      minimumHealth,
      lava,
      maximumUnsupportedDescent,
      shieldBlocks: blocks,
      angryNearTicks: angryNear,
      angryAtLip,
      gapPursuit,
      deadIds,
      pearlDropsObserved: pearlDrops.size,
      damage,
    }),
    close: () => {
      bot.off("physicsTick", onTick);
      bot.off("death", onDeath);
      bot.off("health", onHealth);
      bot.off("entityDead", onDead);
      bot._client.off("damage_event", onDamage);
      bot._client.off("entity_status", onStatus);
    },
  };
}
