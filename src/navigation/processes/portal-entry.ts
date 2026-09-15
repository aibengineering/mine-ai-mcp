import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { armSignal } from "../../utils/index.js";
import type { Goal } from "../goals/goal.js";
import { anyGoal, exactBlockGoal } from "../goals/index.js";
import { observeMineflayerBlock } from "../mineflayer/world.js";
import type { NavigationResult } from "../navigate.js";
import { driveHorizontalSteering, steeringPortFor } from "../steering/local-steering.js";
import { isSafeSupport, navigationFeet } from "../world/block-geometry.js";

export type PortalBlock = "end_portal" | "nether_portal";

const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
interface PortalEntry {
  readonly feet: Vec3;
  readonly portal: Vec3;
}

function clear(bot: Bot, cell: Vec3): boolean {
  const block = bot.blockAt(cell);
  return block !== null && block.boundingBox === "empty" && block.name !== "lava" && block.name !== "water";
}

/** End portals need a supported edge; Nether portals have supported cells inside their vertical opening. */
function entries(bot: Bot, target: Vec3, block: PortalBlock): PortalEntry[] {
  const seen = new Set<string>();
  const pending = [target];
  const cells: Vec3[] = [];
  while (pending.length > 0) {
    const cell = pending.pop()!;
    if (seen.has(cell.toString())) continue;
    seen.add(cell.toString());
    if (bot.blockAt(cell)?.name !== block) continue;
    cells.push(cell);
    for (const side of SIDES) pending.push(cell.plus(side));
    if (block === "nether_portal") pending.push(cell.offset(0, 1, 0), cell.offset(0, -1, 0));
  }
  const result: PortalEntry[] = [];
  for (const portal of cells) {
    if (block === "nether_portal") {
      const floor = bot.blockAt(portal.offset(0, -1, 0));
      if (floor && isSafeSupport(observeMineflayerBlock(floor)) && clear(bot, portal.offset(0, 1, 0)))
        result.push({ feet: portal, portal });
      continue;
    }
    if (!clear(bot, portal.offset(0, 1, 0)) || !clear(bot, portal.offset(0, 2, 0))) continue;
    for (const side of SIDES) {
      const beside = portal.plus(side);
      const floor = bot.blockAt(beside);
      if (!floor || !isSafeSupport(observeMineflayerBlock(floor))) continue;
      const feet = beside.offset(0, 1, 0);
      if (clear(bot, feet) && clear(bot, feet.offset(0, 1, 0))) result.push({ feet, portal });
    }
  }
  return result;
}

/** Pathfinder must reach actual footing, never treat the horizontal End opening as a floor. */
export function portalApproachGoal(bot: Bot, target: Vec3, block: PortalBlock): Goal {
  return {
    resolve(observation) {
      const candidates = entries(bot, target, block);
      if (candidates.length === 0)
        return {
          kind: "invalid",
          observation: "[NAVIGATION_PORTAL_NO_EDGE] No supported entry to the named portal is loaded.",
        };
      return anyGoal(candidates.map(({ feet }) => exactBlockGoal(feet))).resolve(observation);
    },
  };
}

/** Centre in the opening and wait through native portal charging for a server-positioned arrival. */
export async function enterPortal(
  bot: Bot,
  target: Vec3,
  block: PortalBlock,
  signal: AbortSignal,
): Promise<NavigationResult> {
  const started = Date.now();
  const stopped = (reason: string): NavigationResult => ({
    status: "stopped",
    reason,
    elapsedMs: Date.now() - started,
  });
  const feet = navigationFeet(bot.entity.position, bot.entity.onGround);
  const entry = entries(bot, target, block).find(
    ({ feet: candidate }) => candidate.x === feet.x && candidate.y === feet.y && candidate.z === feet.z,
  );
  if (!entry) return stopped("[NAVIGATION_PORTAL_NO_EDGE] Bot did not reach a supported portal entry.");
  const sourceDimension = bot.game.dimension;
  let positioned = false;
  let charging = false;
  const onPosition = () => {
    if (bot.game.dimension !== sourceDimension) positioned = true;
  };
  bot.on("forcedMove", onPosition);
  const arrival = armSignal(
    bot,
    ["forcedMove", "blockUpdate", "death", "physicsTick"],
    () => {
      if (positioned) return "arrived" as const;
      if (bot.health <= 0) return "died" as const;
      if (bot.game.dimension === sourceDimension && bot.blockAt(entry.portal)?.name !== block)
        return "portal_lost" as const;
      if (
        charging &&
        bot.game.dimension === sourceDimension &&
        block === "nether_portal" &&
        bot.blockAt(bot.entity.position.floored())?.name !== block
      )
        return "portal_left" as const;
      return null;
    },
    { context: { signal } },
  );
  try {
    const port = steeringPortFor(bot, (control, state) => bot.setControlState(control, state));
    const step = await driveHorizontalSteering(
      {
        ...port,
        // Physics pauses during a dimension change. A positioned arrival also
        // releases this wait, so no movement input survives into the new world.
        waitForTick: async () => {
          await Promise.race([port.waitForTick(), arrival.promise]);
        },
      },
      {
        target: () =>
          bot.game.dimension === sourceDimension && bot.blockAt(entry.portal)?.name === block
            ? entry.portal.offset(0.5, 0, 0.5)
            : null,
        arrived: () =>
          positioned ||
          Math.hypot(bot.entity.position.x - entry.portal.x - 0.5, bot.entity.position.z - entry.portal.z - 0.5) < 0.17,
        // A single horizontal block takes about five walking ticks. Two seconds
        // detects a blocked final step; server arrival has no deadline below.
        maximumTicks: 40,
        signal,
      },
    );
    signal.throwIfAborted();
    if (step.kind !== "arrived" && !positioned && bot.game.dimension === sourceDimension)
      return stopped(`[NAVIGATION_PORTAL_ENTRY_STOPPED] ${step.kind}`);
    charging = true;
    const outcome = await arrival.promise;
    signal.throwIfAborted();
    if (outcome.kind !== "signalled" || outcome.value !== "arrived")
      return stopped(
        `[NAVIGATION_PORTAL_ENTRY_STOPPED] ${outcome.kind === "signalled" ? outcome.value : outcome.kind}`,
      );
    return { status: "completed", elapsedMs: Date.now() - started };
  } finally {
    arrival.cancel();
    bot.off("forcedMove", onPosition);
  }
}
