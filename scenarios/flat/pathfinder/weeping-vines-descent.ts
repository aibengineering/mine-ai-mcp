import type { ClientCompletion } from "mine-labs/client";
import { Vec3 } from "vec3";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";
import { run as runPathfinder } from "./vine-climb-reliability.ts";

/** Refuse an invalid setup before navigation can turn it into misleading physics evidence. */
export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot } = context;
  await bot.waitForChunksToLoad();
  const facts = {
    position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
    feet: bot.blockAt(new Vec3(0, -52, 0))?.name,
    head: bot.blockAt(new Vec3(0, -51, 0))?.name,
    support: bot.blockAt(new Vec3(0, -53, 0))?.name,
    entryFeet: bot.blockAt(new Vec3(2, -52, 0))?.name,
    entryHead: bot.blockAt(new Vec3(2, -51, 0))?.name,
    health: bot.health,
  };
  if (
    Math.floor(facts.position.x) !== 0 ||
    Math.floor(facts.position.y) !== -52 ||
    Math.floor(facts.position.z) !== 0 ||
    facts.feet !== "air" ||
    facts.head !== "air" ||
    facts.support !== "netherrack" ||
    facts.entryFeet !== "weeping_vines_plant" ||
    facts.entryHead !== "weeping_vines_plant" ||
    facts.health !== 20
  ) {
    return { status: "failed", detail: `Invalid weeping-vine setup: ${JSON.stringify(facts)}` };
  }
  return runPathfinder(context);
}
