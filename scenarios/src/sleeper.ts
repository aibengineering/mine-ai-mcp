/** Run one sleep request and judge its observable world effects. */
import type { Bot } from "mineflayer";
import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import {
  attachHighlighter,
  ActionRunner,
  createSleepAction,
} from "@aibengineering/mine-ai-mcp";

import type { MineAiScenarioContext } from "./scenario-client.ts";

const SLEEP_START = 12542;
const SLEEP_END = 23458;

function isAwakeTime(bot: Bot): boolean {
  return bot.time.timeOfDay < SLEEP_START || bot.time.timeOfDay > SLEEP_END;
}

function expectedPosition(value: unknown, name: string): Vec3 {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((coordinate) => typeof coordinate !== "number" || !Number.isFinite(coordinate))
  ) {
    throw new Error(`${name} must be a finite [x, y, z] position`);
  }
  return new Vec3(value[0], value[1], value[2]);
}

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return check();
}

async function respawnsNear(bot: Bot, expected: Vec3): Promise<boolean> {
  const respawned = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("bot did not respawn within 5 seconds")), 5_000);
    bot.once("spawn", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  bot.chat("/kill @s");
  await respawned;
  return waitUntil(() => bot.entity.position.distanceTo(expected) <= 3);
}

function nearbyBeds(bot: Bot): string[] {
  return bot
    .findBlocks({
      matching: (block) => block.name.endsWith("_bed"),
      maxDistance: 8,
      count: 8,
    })
    .map((position) => position.toString());
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  const { highlighter } = attachHighlighter(bot);
  const runner = new ActionRunner({ highlighter });

  context.log("sleep {}");
  const { result, durationMs } = await runner.run(createSleepAction(bot, context.navigation), {}, context.signal);
  const error = "error" in result ? result.error : "";
  context.log(`${result.status} (${durationMs} ms)${error ? ` — ${error}` : ""}`);

  if (result.status !== "succeeded") {
    const beds = nearbyBeds(bot);
    return {
      status: "failed",
      detail: `${error || "sleep did not succeed"}; nearby beds: ${beds.join(", ") || "none"}`,
    };
  }

  const params = context.scenario.params;
  const expectation = typeof params.expect === "string" ? params.expect : "morning";
  const failures: string[] = [];

  if (expectation === "morning" && !(await waitUntil(() => isAwakeTime(bot)))) {
    failures.push(`time remained ${bot.time.timeOfDay}; expected morning`);
  }

  if (params.spawn_near !== undefined) {
    const expected = expectedPosition(params.spawn_near, "spawn_near");
    if (!(await respawnsNear(bot, expected))) {
      failures.push(`respawned at ${bot.entity.position}, expected near ${expected}`);
    }
  }

  const bedCells = params.bed_cells === undefined ? [] : params.bed_cells;
  if (!Array.isArray(bedCells)) throw new Error("bed_cells must be an array of [x, y, z] positions");
  for (const [index, cell] of bedCells.entries()) {
    const position = expectedPosition(cell, `bed_cells[${index}]`);
    const observed = bot.blockAt(position)?.name ?? "unloaded";
    if (!observed.endsWith("_bed")) failures.push(`${position} contains ${observed}, expected a bed`);
  }

  return failures.length === 0
    ? {
        status: "succeeded",
        detail: `${expectation} observed in ${durationMs} ms; respawned at ${bot.entity.position}`,
      }
    : { status: "failed", detail: failures.join("; ") };
}
