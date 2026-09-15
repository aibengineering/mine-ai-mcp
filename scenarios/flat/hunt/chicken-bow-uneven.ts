import { Vec3 } from "vec3";
import type { BotEvents } from "mineflayer";
import { run as hunt } from "../../src/hunter.ts";
import type { MineAiScenario } from "../../src/scenario-client.ts";
import { STANDING_EYE_HEIGHT, type BlockRaycaster } from "../../../src/world/block-visibility.ts";

/** Fixture-only observation of the real hunt's release command; never alter its aim or timing. */
export const run: MineAiScenario = async (context) => {
  const { bot } = context;
  const activate = bot.activateItem;
  const deactivate = bot.deactivateItem;
  const selectSlot = bot.setQuickBarSlot;
  const look = bot.lookAt;
  let drawing = false;
  let aimed: Vec3 | null = null;
  let shots = 0;
  let cancelledDraws = 0;
  let spawnedArrows = 0;
  let hurtEvents = 0;
  const spawn: BotEvents["entitySpawn"] = (entity) => {
    if (entity.name === "arrow") spawnedArrows++;
  };
  const hurt: BotEvents["entityHurt"] = (entity) => {
    if (entity.name === "chicken") hurtEvents++;
  };
  bot.on("entitySpawn", spawn);
  bot.on("entityHurt", hurt);
  bot.activateItem = (...args) => {
    drawing = !args[0] && bot.heldItem?.name === "bow";
    return activate.apply(bot, args);
  };
  bot.setQuickBarSlot = (...args) => {
    if (drawing) cancelledDraws++;
    drawing = false;
    return selectSlot.apply(bot, args);
  };
  bot.lookAt = async (...args) => {
    aimed = args[0].clone();
    return look.apply(bot, args);
  };
  bot.deactivateItem = () => {
    if (drawing && aimed) {
      shots++;
      const target = bot.nearestEntity(
        (entity) => entity.name === "chicken" && entity.position.distanceTo(aimed!) < 1.5,
      );
      const eye = bot.entity.position.offset(0, STANDING_EYE_HEIGHT, 0);
      const delta = aimed.minus(eye);
      const world: BlockRaycaster = bot.world;
      const hit = world.raycast(eye, delta.scaled(1 / delta.norm()), delta.norm());
      const obstruction = hit && ("position" in hit ? hit.position : hit);
      context.log(
        `shot-geometry ${JSON.stringify({ shot: shots, eye, aim: aimed, obstruction, target: target ? { id: target.id, position: target.position, velocity: target.velocity, height: target.height } : null })}`,
      );
    }
    drawing = false;
    return deactivate.call(bot);
  };
  try {
    const result = await hunt(context);
    return {
      ...result,
      detail: `${result.detail}; bow releases=${shots}, cancelled draws=${cancelledDraws}, spawned arrows=${spawnedArrows}, chicken hurt events=${hurtEvents}`,
    };
  } finally {
    bot.activateItem = activate;
    bot.deactivateItem = deactivate;
    bot.setQuickBarSlot = selectSlot;
    bot.lookAt = look;
    bot.off("entitySpawn", spawn);
    bot.off("entityHurt", hurt);
  }
};
