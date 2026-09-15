/** One production runtime per scenario bot, with queryable receipts retained in run artifacts. */
import {
  createMinecraftRuntime,
  type MinecraftRuntimeOptions,
} from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "./scenario-client.ts";
import path from "node:path";
import { Vec3 } from "vec3";

export type Runtime = Awaited<ReturnType<typeof createMinecraftRuntime>>;

/** One runtime per scenario, named after the behaviour under test. */
// @function-metrics size=1 branches=0 fan-out=1 depth=2 interface=2 fan-in=2
export function openRuntime(
  context: MineAiScenarioContext,
  worldId: string,
  options: Pick<MinecraftRuntimeOptions, "stepFieldProvider" | "createCombatController" | "incidents"> = {},
): Promise<Runtime> {
  const artifacts = process.env.MINE_LABS_ARTIFACTS_DIR;
  return createMinecraftRuntime(context.bot, {
    ...options,
    ...(artifacts
      ? { incidents: { ...options.incidents, directory: path.join(artifacts, context.bot.username, "incidents") } }
      : {}),
    botData: {
      // Failed collection runs need the complete semantic chronology after
      // the client closes; incident files only retain bounded physical windows.
      storage: artifacts ? { kind: "persistent", root: path.join(artifacts, "bot-data") } : { kind: "temporary" },
      identity: { worldId, scope: { kind: "bot", botId: context.bot.username } },
    },
  });
}

/** How long to give a bot to land on its pinned column before the fixture gives up on it. */
const SETTLE_TIMEOUT_TICKS = 200;
/** Consecutive still ticks that count as landed rather than momentarily level. */
const STILL_TICKS = 10;

/**
 * Wait until the bot is on the ground, not moving, and its vitals are known.
 *
 * A seeded default world pins a spawn column to the block, and the generator
 * does not always agree: `waitForChunksToLoad` returns while the bot is still
 * on the way down, so anything measured or placed then is beside a cell the
 * bot is about to leave. `bot.food` is zero until the first health packet
 * arrives, which reads as a starving bot with no health at all.
 */
// @function-metrics size=8 branches=3 fan-out=5 depth=2 interface=1 fan-in=2
export async function standStill(context: MineAiScenarioContext): Promise<boolean> {
  const { bot } = context;
  let lastY = bot.entity.position.y;
  let still = 0;
  for (let waited = 0; waited < SETTLE_TIMEOUT_TICKS; waited += 1) {
    context.signal.throwIfAborted();
    await bot.waitForTicks(1);
    const landed = bot.entity.onGround && Math.abs(bot.entity.position.y - lastY) < 1e-3;
    still = landed ? still + 1 : 0;
    lastY = bot.entity.position.y;
    if (still >= STILL_TICKS && bot.food > 0) return true;
  }
  return false;
}

/**
 * Put on any armor the fixture handed the bot.
 *
 * Mine Labs grants inventory, not equipment, and nothing in the runtime dresses
 * a bot. Fixtures that put the bot in a crowd need it: two zombies hitting at
 * once cost ten to twelve and a half health for a single kill unarmored, which
 * straddles the ten-health fight threshold and turns a policy test into a
 * damage-roll test. Armor is also simply what a bot heading out at night would
 * be wearing.
 */
// @function-metrics size=4 branches=2 fan-out=4 depth=2 interface=1 fan-in=2
export async function wearArmor(context: MineAiScenarioContext): Promise<void> {
  const destinations = [
    ["_helmet", "head"],
    ["_chestplate", "torso"],
    ["_leggings", "legs"],
    ["_boots", "feet"],
  ] as const;
  for (const [suffix, destination] of destinations) {
    const piece = context.bot.inventory.items().find((item) => item.name.endsWith(suffix));
    if (piece) await context.bot.equip(piece, destination);
    context.signal.throwIfAborted();
  }
}

/**
 * Where the scenario file put this bot. Mine Labs teleports the player there,
 * in the declared dimension, before the driver runs; a driver that needs the
 * coordinate later (to return home, say) reads the same declaration rather
 * than repeating it in its params.
 */
export function declaredStart(context: MineAiScenarioContext): Vec3 {
  const player = context.scenario.players.find(({ name }) => name === context.bot.username);
  const pos = player?.pos;
  if (!Array.isArray(pos)) throw new Error(`scenario declares no absolute pos for player '${context.bot.username}'`);
  return new Vec3(pos[0], pos[1], pos[2]);
}

export interface DeclaredEntity {
  /** Bare entity name as Mineflayer reports it, e.g. `blaze`. */
  name: string;
  position: Vec3;
  nbt: string;
}

/** Every entity the scenario file declares, as the client will see it. */
export function declaredEntities(context: MineAiScenarioContext): DeclaredEntity[] {
  return context.scenario.entities.map((entity) => {
    if (!Array.isArray(entity.pos)) throw new Error(`scenario entity '${entity.type}' needs an absolute pos`);
    return {
      name: entity.type.replace(/^minecraft:/u, ""),
      position: new Vec3(entity.pos[0], entity.pos[1], entity.pos[2]),
      nbt: entity.nbt ?? "",
    };
  });
}

/**
 * Wait until every declared entity is loaded. Mine Labs summons them after
 * the client reports `prepared`, so a driver that needs them on its first
 * tick confirms their arrival here. Presence is counted by type rather than
 * position: a mob summoned with its AI on may already have taken a step.
 */
export async function declaredEntitiesArranged(context: MineAiScenarioContext): Promise<void> {
  const { bot } = context;
  const expected = new Map<string, number>();
  for (const { name } of declaredEntities(context)) expected.set(name, (expected.get(name) ?? 0) + 1);
  const arrived = () => {
    const loaded = Object.values(bot.entities).filter((entity) => entity.isValid);
    return [...expected].every(([name, count]) => loaded.filter((entity) => entity.name === name).length >= count);
  };
  for (let tick = 0; tick < 400; tick++) {
    context.signal.throwIfAborted();
    if (arrived()) return;
    await bot.waitForTicks(1);
  }
  throw new Error(`Declared entities did not arrive within 20 seconds: ${JSON.stringify([...expected])}`);
}
