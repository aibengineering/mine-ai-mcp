import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { horizontalControlsToward, type WorldView } from "../../navigation/index.js";
import { preferredScaffoldItem } from "../../navigation/mineflayer/movement-policy.js";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { advancingLavaAt } from "../../world/lava-flow.js";
import { occupiedCell, placeSolidBlockInto } from "../../world/placement.js";
import { fireContactCells, isBurning, isInFire, isInLava } from "../perception/body.js";
import { extinguishFireAt } from "../positioning/fire-clearance.js";
import {
  clearFireEscape,
  fireEscapeDeparture,
  nearbyFireEscape,
  type FireEscapeReason,
} from "../positioning/fire-escape.js";

export type FireEscapeOutcome = "escaped" | "blocked" | "died";

/** Replace adjacent lava with a solid step when there is no natural bank to climb. */
export async function buildLavaEscapeStep(bot: Bot, signal: AbortSignal): Promise<Vec3 | null> {
  const item = preferredScaffoldItem(bot);
  if (!item) return null;
  const origin = bot.entity.position.floored();
  const cells = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].map((offset) =>
    origin.plus(offset),
  );
  for (const cell of cells) {
    signal.throwIfAborted();
    if (bot.blockAt(cell)?.name !== "lava" || occupiedCell(bot, cell)) continue;
    if (
      ![1, 2].every((dy) => {
        const block = bot.blockAt(cell.offset(0, dy, 0));
        return block && ["air", "cave_air", "void_air"].includes(block.name);
      })
    )
      continue;
    const placed = await placeSolidBlockInto(bot, cell, item, { signal });
    if (placed.kind === "placed") return cell.offset(0.5, 1, 0.5);
  }
  return null;
}

/** Leave the active source; residual burning must not monopolise the body without reachable water. */
export async function escapeFire(
  bot: Bot,
  world: WorldView,
  signal: AbortSignal,
  reason: FireEscapeReason = "contact",
): Promise<FireEscapeOutcome> {
  bot.stopDigging();
  bot.deactivateItem();
  bot.clearControlStates();
  let target = nearbyFireEscape(bot, world, reason);
  let departure = fireEscapeDeparture(bot);
  let best = Infinity;
  let stalled = 0;
  try {
    while (bot.health > 0) {
      signal.throwIfAborted();
      const inLava = isInLava(bot);
      const inFire = isInFire(bot);
      if (
        !inLava &&
        !inFire &&
        !isBurning(bot) &&
        (bot.entity.onGround || Reflect.get(bot.entity, "isInWater")) &&
        (reason === "contact" || !advancingLavaAt(bot))
      )
        return "escaped";
      // Keep the admitted departure through the jump. Being momentarily above
      // lava is not a landing, and must not invalidate the bank we are climbing.
      if (target && !clearFireEscape(bot, world, target, departure)) {
        target = nearbyFireEscape(bot, world, reason);
        departure = fireEscapeDeparture(bot);
        best = Infinity;
      }
      // There is no water in the Nether. Solid terrain can still replace a
      // lava cell and provide the bank the local swimming controller needs.
      if (!target && inLava) {
        departure = fireEscapeDeparture(bot);
        target = await buildLavaEscapeStep(bot, signal);
      }
      if (!target && inFire) {
        // Environmental escape has its own authority, like the lava step.
        // A sealed refuge may offer no walk out, but its occupied fire can
        // still be extinguished without excavating any of the refuge's walls.
        for (const cell of fireContactCells(bot)) await extinguishFireAt(bot, cell, signal, true);
        if (!isInFire(bot)) continue;
      }
      if (
        !inLava &&
        !inFire &&
        bot.entity.onGround &&
        reason === "contact" &&
        (!target || bot.blockAt(target)?.name !== "water")
      )
        return "escaped";
      if (!target) return "blocked";
      const distance = bot.entity.position.distanceTo(target);
      if (distance < best - 0.05) {
        best = distance;
        stalled = 0;
      } else stalled++;
      // Two seconds without closing distance detects an obstructed jump out
      // of liquid. Release with evidence rather than retain a dead steering loop.
      if (stalled >= 40) return "blocked";
      const controls = horizontalControlsToward(bot.entity, target, 0.1);
      for (const control of ["forward", "back", "left", "right"] as const)
        bot.setControlState(control, controls[control]);
      bot.setControlState("jump", isInLava(bot) || target.y > bot.entity.position.y + 0.1);
      await waitForPhysicsTicks(bot, 1, signal);
      if (distance < 0.4 && bot.entity.onGround && !Reflect.get(bot.entity, "isInWater")) {
        target = nearbyFireEscape(bot, world, reason);
        departure = fireEscapeDeparture(bot);
        best = Infinity;
      }
    }
    return "died";
  } finally {
    bot.clearControlStates();
  }
}
