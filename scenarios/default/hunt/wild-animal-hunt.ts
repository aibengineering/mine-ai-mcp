/**
 * Hunt whatever animal this seed's terrain actually put nearby.
 *
 * The failure this whole plan came from happened on generated terrain, not on
 * a flat fixture: a loaded rabbit sixty-five blocks off that `collect_mob_drop`
 * would not walk to. A flat world cannot reproduce it, because a flat world has
 * nothing to walk around.
 *
 * The species is not in the fixture, because terrain decides what lives there.
 * The driver asks `view_status` first - whose loaded-mob list is bounded
 * by nothing but what the client holds, which is exactly the set the hunt
 * pursues - takes the nearest animal it knows a guaranteed drop for, and hunts
 * that. So each seed asks the same question of whatever it generated.
 */
import {
  COLLECT_MOB_DROP,
  VIEW_STATUS,
  huntMobResultSchema,
  viewStatusResultSchema,
} from "@aibengineering/mine-ai-mcp";
import type { ClientCompletion } from "mine-labs/client";
import { z } from "zod";

import { openRuntime } from "../../src/runtime.ts";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

const paramsSchema = z.strictObject({
  count: z.number().int().positive().default(1),
});

/**
 * The animals worth hunting, and the one item each of them always drops.
 *
 * Guaranteed drops only, because the fixture asserts the drop reached the
 * inventory: beef, mutton, porkchop and chicken are one or more from every
 * adult kill. Leather, feathers and rabbit hide are coin tosses and would make
 * this a loot-table test. A rabbit has no guaranteed drop at all, so there is
 * no rabbit here despite the plan's flat fixtures using one.
 */
const QUARRY = new Map([
  ["cow", "beef"],
  ["sheep", "mutton"],
  ["pig", "porkchop"],
  ["chicken", "chicken"],
]);

/** Ticks to wait for the fall to end before giving up on a settled start. */
const SETTLE_TIMEOUT_TICKS = 200;
/** Consecutive still ticks that count as landed, as the receipts fixture uses. */
const STILL_TICKS = 10;

/**
 * Wait until the bot is standing still on the ground.
 *
 * A pinned spawn is a column, not a height: the server drops the player at the
 * named coordinates and lets it fall to whatever it generated there, and
 * `waitForChunksToLoad` returns while it is still on the way down. Every
 * distance in this fixture - the status view's sighting, the hunt's own - is
 * measured from where the bot is, so reading either mid-fall measures from a
 * cell the bot is about to leave.
 */
async function standStill(context: MineAiScenarioContext): Promise<boolean> {
  const { bot } = context;
  let lastY = bot.entity.position.y;
  let still = 0;
  for (let waited = 0; waited < SETTLE_TIMEOUT_TICKS; waited += 1) {
    context.signal.throwIfAborted();
    await bot.waitForTicks(1);
    const landed = bot.entity.onGround && Math.abs(bot.entity.position.y - lastY) < 1e-3;
    still = landed ? still + 1 : 0;
    lastY = bot.entity.position.y;
    if (still >= STILL_TICKS) return true;
  }
  return false;
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const params = paramsSchema.parse(context.scenario.params ?? {});
  const runtime = await openRuntime(context, "wild-hunt");
  try {
    const status = runtime.actions.find((action) => action.name === VIEW_STATUS);
    const hunt = runtime.actions.find((action) => action.name === COLLECT_MOB_DROP);
    if (!status || !hunt) throw new Error("The wild hunt scenario could not find its production actions.");
    await context.bot.waitForChunksToLoad();
    if (!(await standStill(context))) {
      return { status: "failed", detail: "The bot never settled on its spawn column; the fall did not end." };
    }

    const situation = viewStatusResultSchema.parse(
      (await runtime.run(status, {}, context.signal)).result,
    ).situation;
    const feet = situation.position;
    context.log(
      `spawned at ${feet.x.toFixed(1)},${feet.y.toFixed(1)},${feet.z.toFixed(1)}; ` +
        `loaded mobs ${situation.nearby.mobs.map((mob) => `${mob.name}x${mob.count}@${mob.nearest.distance}`).join(", ") || "none"}`,
    );

    const quarry = situation.nearby.mobs
      .filter((mob) => QUARRY.has(mob.name))
      .sort((left, right) => left.nearest.distance - right.nearest.distance)[0];
    if (!quarry) {
      // Not a hunt failure: this spawn point has no animals to hunt, and the
      // fixture's job is to move until it does.
      return {
        status: "failed",
        detail: `No huntable animal is loaded at this spawn point; status saw ${situation.nearby.mobs.map((mob) => mob.name).join(", ") || "no mobs at all"}. Move the spawn.`,
      };
    }
    const drop = QUARRY.get(quarry.name)!;
    const sighted = `${quarry.name} x${quarry.count}, nearest ${quarry.nearest.distance} blocks off at ${quarry.nearest.position.x},${quarry.nearest.position.y},${quarry.nearest.position.z}`;
    context.log(`hunting ${sighted} for ${drop}`);

    const request = { mob_name: quarry.name, drop_name: drop, count: params.count };
    const output = await runtime.run(hunt, request, context.signal);
    const parsed = huntMobResultSchema.safeParse(output.result);
    if (!parsed.success) {
      return { status: "failed", detail: `Unexpected hunt result: ${JSON.stringify(output.result)}` };
    }
    const evidence = parsed.data.hunt;
    const error = "error" in parsed.data ? parsed.data.error : "";
    const detail =
      `${parsed.data.status} in ${output.durationMs} ms; saw ${sighted}; ` +
      `${evidence.drop} ${evidence.gained}/${evidence.requested}; ` +
      `${evidence.targetDeathsObserved} kill${evidence.targetDeathsObserved === 1 ? "" : "s"} over ` +
      `${evidence.targetsEngaged} engagement${evidence.targetsEngaged === 1 ? "" : "s"}; ` +
      `targets ${evidence.targets.map((target) => `${target.species}#${target.id} at ${target.x},${target.y},${target.z} (${target.distance})`).join(", ") || "none"}` +
      ((output.interruptions ?? []).length > 0 ? `; interrupted by ${(output.interruptions ?? []).join(" | ")}` : "") +
      `${error ? `; ${error}` : ""}`;
    context.log(detail);

    if (parsed.data.status !== "succeeded") return { status: "failed", detail };
    if (evidence.gained < params.count) return { status: "failed", detail: `The drop never arrived. ${detail}` };
    // The point of the whole change: a result that says where the animal was.
    if (evidence.targets.length === 0) {
      return { status: "failed", detail: `The result named no target position. ${detail}` };
    }
    return { status: "succeeded", detail };
  } finally {
    await runtime.close();
  }
}
