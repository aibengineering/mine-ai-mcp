/**
 * Exercise the same survival progression as
 * `flat/progression/primitive-progression-to-diamond`, on a seeded default
 * world instead of a hand-built flat one.
 *
 * Three things a flat fixture never has to deal with:
 *
 *   * Workstation coordinates are not known in advance. `place_block`
 *     takes an exact cell, so the driver — playing the caller's role, same as
 *     any MCP client — has to choose one itself. `findFlatPlacementCandidates`
 *     is the same helper production code uses for bed placement.
 *   * Ore is not prefilled beside spawn. `collect_block` owns discovery
 *     as well as mining: it scans loaded columns and explores from a persistent
 *     branch point when none contains a target.
 *   * A fixed workstation is expensive to get back to. The flat fixture never
 *     moves more than a few blocks from its table; this one digs a shaft tens
 *     of blocks deep, and a plain `navigate` back up will happily spend
 *     whatever it's carrying most of — including the ore it just mined — as
 *     climbing scaffold (`STANDARD_SCAFFOLDS` picks by carried count, not by
 *     value). Two things fix that instead of fighting it: the table and
 *     furnace are picked back up after each use and re-placed beside wherever
 *     the bot ends up next, so no return trip is ever needed; and dirt is
 *     collected far in excess of the goal's own requirement so it always
 *     outnumbers cobblestone in inventory, keeping the scaffold's pick
 *     harmless when a short climb still happens mid-route.
 */
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";
import { Vec3 } from "vec3";
import {
  attachHighlighter,
  ActionRunner,
  createCollectBlockAction,
  createCraftItemAction,
  createPlaceBlockAction,
  createSmeltItemAction,
  findFlatPlacementCandidates,
} from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  logs: z.number().int().positive(),
  dirt: z.number().int().positive(),
  stone: z.number().int().positive(),
  coal: z.number().int().positive(),
  rawIron: z.number().int().positive(),
  diamonds: z.number().int().positive(),
});

interface StageOutput {
  readonly durationMs: number;
  readonly result: { readonly status: string; readonly error?: string };
}

type Cell = { readonly x: number; readonly y: number; readonly z: number };

async function requireStage(
  context: MineAiScenarioContext,
  name: string,
  run: () => Promise<StageOutput>,
): Promise<number> {
  context.log(`${name}: starting`);
  const output = await run();
  const error = output.result.error ? ` — ${output.result.error}` : "";
  context.log(`${name}: ${output.result.status} in ${output.durationMs} ms${error}`);
  if (output.result.status !== "succeeded") {
    throw new Error(`${name} ${output.result.status}: ${output.result.error ?? "no error evidence"}`);
  }
  return output.durationMs;
}

/**
 * Place one carried block at the nearest cell `findFlatPlacementCandidates`
 * considers valid, trying the next candidate on failure rather than trusting
 * the first — real terrain can still refuse a candidate the scan approved
 * (a support block that breaks free, another player racing the cell).
 */
async function placeNearBot(
  context: MineAiScenarioContext,
  runner: ActionRunner,
  collect: ReturnType<typeof createCollectBlockAction>,
  place: ReturnType<typeof createPlaceBlockAction>,
  blockName: string,
): Promise<Cell> {
  const { bot } = context;
  let candidates = findFlatPlacementCandidates(bot, [{ x: 0, y: 0, z: 0 }], 6);
  if (candidates.length === 0) {
    await clearWorkstationAlcove(context, runner, collect);
    candidates = findFlatPlacementCandidates(bot, [{ x: 0, y: 0, z: 0 }], 6);
  }
  if (candidates.length === 0) throw new Error(`no flat placement candidate found near the bot for ${blockName}`);

  let lastError = "no candidate cell was tried";
  for (const candidate of candidates) {
    const { x, y, z } = candidate;
    const output = await runner.run(place, { block_name: blockName, x, y, z }, context.signal);
    context.log(`place ${blockName} @ ${x},${y},${z}: ${output.result.status}`);
    if (output.result.status === "succeeded") return { x, y, z };
    lastError = output.result.error ?? output.result.status;
  }
  throw new Error(`could not place ${blockName} at any of ${candidates.length} candidate cells: ${lastError}`);
}

/**
 * A collection route can finish in a one-wide shaft, where the bot's own cell
 * is the only clear, supported cell. Make a small horizontal alcove before
 * asking the placement action to choose a workstation position. The fixture
 * deliberately uses the collect action for every break, so its result remains
 * independently observed rather than assuming a direct dig succeeded.
 */
async function clearWorkstationAlcove(
  context: MineAiScenarioContext,
  runner: ActionRunner,
  collect: ReturnType<typeof createCollectBlockAction>,
): Promise<void> {
  const center = context.bot.entity.position.floored();
  const cells = [center.offset(1, 0, 0), center.offset(-1, 0, 0), center.offset(0, 0, 1), center.offset(0, 0, -1)];

  for (const cell of cells) {
    const block = context.bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
    if (!block || block.boundingBox === "empty") continue;

    const output = await runner.run(
      collect,
      { block_name: block.name, x: cell.x, y: cell.y, z: cell.z, scaffold: false },
      context.signal,
    );
    context.log(`clear workstation alcove @ ${cell.x},${cell.y},${cell.z}: ${output.result.status}`);
    if (output.result.status !== "succeeded") {
      throw new Error(
        `could not clear workstation alcove at ${cell.x},${cell.y},${cell.z}: ${output.result.error ?? output.result.status}`,
      );
    }
  }
}

/** Break a workstation back into carried inventory so it can travel with the bot. */
function pickUp(
  context: MineAiScenarioContext,
  runner: ActionRunner,
  collect: ReturnType<typeof createCollectBlockAction>,
  blockName: string,
  at: Cell,
): Promise<StageOutput> {
  return runner.run(collect, { block_name: blockName, x: at.x, y: at.y, z: at.z, scaffold: false }, context.signal);
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const { highlighter } = attachHighlighter(bot);
  const runner = new ActionRunner({ highlighter });
  const collect = createCollectBlockAction(bot, context.navigation);
  const craft = createCraftItemAction(bot, context.navigation);
  const place = createPlaceBlockAction(bot, context.navigation);
  const smelt = createSmeltItemAction(bot, context.navigation);
  const stages: string[] = [];
  let currentStage = "setup";
  let activeMovement = "none";
  let observedHealth = bot.health;
  let healthTransitions = 0;
  const stopMovementTrace = context.pathfinder.onEvent((event) => {
    if (event.kind === "step_started") activeMovement = `${event.movement} ${event.stepId}`;
    else if (event.kind === "step_completed" || event.kind === "step_failed") activeMovement = "none";
  });
  const observeHealth = () => {
    if (bot.health === observedHealth) return;
    const transition = `${observedHealth} -> ${bot.health} during ${currentStage}; active movement ${activeMovement}`;
    healthTransitions++;
    context.log(`health ${transition}`);
    observedHealth = bot.health;
  };
  bot.on("health", observeHealth);

  try {
    await bot.waitForChunksToLoad();
    context.signal.throwIfAborted();
    if (bot.game.difficulty !== "peaceful") {
      throw new Error(`expected peaceful difficulty; Mineflayer observed ${bot.game.difficulty}`);
    }

    const request = paramsSchema.parse(context.scenario.params);
    const stage = async (name: string, work: () => Promise<StageOutput>) => {
      currentStage = name;
      const durationMs = await requireStage(context, name, work);
      stages.push(`${name} ${durationMs} ms`);
    };
    const placeWorkstation = async (blockName: string) => {
      const at = await placeNearBot(context, runner, collect, place, blockName);
      stages.push(`place ${blockName} @ ${at.x},${at.y},${at.z}`);
      return at;
    };
    const pickUpWorkstation = (blockName: string, at: Cell) =>
      stage(`pick up ${blockName}`, () => pickUp(context, runner, collect, blockName, at));

    await stage("collect logs", () =>
      runner.run(collect, { block_name: "logs", count: request.logs, scaffold: false }, context.signal),
    );
    await stage("craft table", () =>
      runner.run(craft, { items: [{ item_name: "crafting_table", count: 1 }] }, context.signal),
    );

    let table = await placeWorkstation("crafting_table");

    await stage("craft wooden tools", () =>
      runner.run(
        craft,
        {
          items: [
            { item_name: "wooden_pickaxe", count: 1 },
            { item_name: "wooden_shovel", count: 1 },
          ],
        },
        context.signal,
      ),
    );
    await pickUpWorkstation("crafting_table", table);

    // Collected in excess of the goal's own requirement: STANDARD_SCAFFOLDS
    // picks whichever of dirt/cobblestone the bot carries the most of when a
    // route needs to climb, so a deep dirt reserve keeps that pick away from
    // the cobblestone the next stage is about to mine.
    await stage("collect dirt", () =>
      runner.run(collect, { block_name: "dirt", count: request.dirt, scaffold: false }, context.signal),
    );
    await stage("collect stone", () =>
      runner.run(collect, { block_name: "stone", count: request.stone, scaffold: false }, context.signal),
    );

    table = await placeWorkstation("crafting_table");
    await stage("craft stone tools", () =>
      runner.run(
        craft,
        {
          items: [
            { item_name: "stone_pickaxe", count: 1 },
            { item_name: "stone_shovel", count: 1 },
          ],
        },
        context.signal,
      ),
    );
    await stage("craft furnace", () =>
      runner.run(craft, { items: [{ item_name: "furnace", count: 1 }] }, context.signal),
    );

    let furnace = await placeWorkstation("furnace");
    await stage("collect coal", () =>
      runner.run(collect, { block_name: "coal_ore", count: request.coal, scaffold: false }, context.signal),
    );

    await pickUpWorkstation("crafting_table", table);
    await stage("pick up furnace", () =>
      runner.run(collect, { block_name: "furnace", count: 1, scaffold: false }, context.signal),
    );

    await stage("collect raw iron", () =>
      runner.run(collect, { block_name: "iron_ore", count: request.rawIron, scaffold: false }, context.signal),
    );

    furnace = await placeWorkstation("furnace");
    await stage("smelt iron", () =>
      runner.run(
        smelt,
        {
          item_name: "raw_iron",
          count: request.rawIron,
          fuel_item_name: "coal",
          x: furnace.x,
          y: furnace.y,
          z: furnace.z,
        },
        context.signal,
      ),
    );

    // A one-wide shaft may have only one valid workstation cell. Free the
    // furnace cell before asking the placement primitive to put the table
    // beside us; the earlier order made a sound primitive fail on a fixture
    // conflict that a real caller would avoid.
    await stage("pick up furnace", () =>
      runner.run(collect, { block_name: "furnace", count: 1, scaffold: false }, context.signal),
    );
    table = await placeWorkstation("crafting_table");
    await stage("craft iron pickaxe", () =>
      runner.run(craft, { items: [{ item_name: "iron_pickaxe", count: 1 }] }, context.signal),
    );

    await pickUpWorkstation("crafting_table", table);

    await stage("collect diamond", () =>
      runner.run(collect, { block_name: "diamond_ore", count: request.diamonds, scaffold: false }, context.signal),
    );

    return {
      status: "succeeded",
      detail:
        `default-world progression reached diamond; health ${bot.health}; ` +
        `health transitions ${healthTransitions} (see client log); ${stages.join("; ")}; ${context.pathfinder.summary()}`,
    };
  } catch (cause) {
    const complaint = cause instanceof Error ? cause.message : String(cause);
    return {
      status: "failed",
      detail:
        `${complaint}; health ${bot.health}; health transitions ${healthTransitions} (see client log); ` +
        `completed stages: ${stages.join("; ") || "none"}; ${context.pathfinder.summary()}`,
    };
  } finally {
    stopMovementTrace();
    bot.removeListener("health", observeHealth);
  }
}
