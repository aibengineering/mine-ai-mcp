import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { isAir, type WorldBlock } from "../../world/index.js";
import type { NetherPortalFrame } from "./contract.js";

/** Vanilla limits on the rectangular interior. */
const MINIMUM_WIDTH = 2;
const MINIMUM_HEIGHT = 3;
const MAXIMUM_SPAN = 21;
const PORTAL = "nether_portal";
const FRAME = "obsidian";

/** Whether a cell can be part of a portal's interior: air, or a portal already lit. */
function isInterior(block: WorldBlock | null): boolean {
  return block !== null && (isAir(block) || block.name === PORTAL);
}

function isFrame(block: WorldBlock | null): boolean {
  return block?.name === FRAME;
}

/** Every interior cell of a frame, bottom row first. */
export function interiorCells(frame: NetherPortalFrame): Vec3[] {
  const cells: Vec3[] = [];
  for (let up = 0; up < frame.height; up += 1) {
    for (let along = 0; along < frame.width; along += 1) {
      cells.push(
        frame.axis === "x"
          ? new Vec3(frame.origin.x + along, frame.origin.y + up, frame.origin.z)
          : new Vec3(frame.origin.x, frame.origin.y + up, frame.origin.z + along),
      );
    }
  }
  return cells;
}

type FrameSearch = { readonly frame: NetherPortalFrame } | { readonly reason: string };

/**
 * Walk from the cell to the interior's lowest, leftmost corner along one
 * axis, measure the interior, and check the obsidian around it. Corners are
 * not required, as the game does not require them.
 */
function findFrameAlong(bot: Bot, cell: Vec3, axis: "x" | "z"): FrameSearch {
  const at = (along: number, y: number) =>
    bot.blockAt(axis === "x" ? new Vec3(along, y, cell.z) : new Vec3(cell.x, y, along));
  const start = axis === "x" ? cell.x : cell.z;
  if (!isInterior(at(start, cell.y)))
    return { reason: `the named cell holds ${bot.blockAt(cell)?.name ?? "unloaded"}` };
  let bottom = cell.y;
  while (bottom - 1 >= cell.y - MAXIMUM_SPAN && isInterior(at(start, bottom - 1))) bottom -= 1;
  let left = start;
  while (left - 1 >= start - MAXIMUM_SPAN && isInterior(at(left - 1, bottom))) left -= 1;
  let width = 0;
  while (width < MAXIMUM_SPAN + 1 && isInterior(at(left + width, bottom))) width += 1;
  let height = 0;
  while (height < MAXIMUM_SPAN + 1 && isInterior(at(left, bottom + height))) height += 1;
  if (width < MINIMUM_WIDTH || height < MINIMUM_HEIGHT || width > MAXIMUM_SPAN || height > MAXIMUM_SPAN) {
    return { reason: `an opening ${width} wide and ${height} tall along ${axis} is not a portal shape` };
  }
  for (let along = left; along < left + width; along += 1) {
    if (!isFrame(at(along, bottom - 1))) return { reason: `no obsidian below the interior at ${axis}=${along}` };
    if (!isFrame(at(along, bottom + height))) return { reason: `no obsidian above the interior at ${axis}=${along}` };
    for (let y = bottom; y < bottom + height; y += 1) {
      if (!isInterior(at(along, y))) return { reason: `the interior is blocked at ${axis}=${along}, y=${y}` };
    }
  }
  for (let y = bottom; y < bottom + height; y += 1) {
    if (!isFrame(at(left - 1, y))) return { reason: `no obsidian beside the interior at y=${y}` };
    if (!isFrame(at(left + width, y))) return { reason: `no obsidian beside the interior at y=${y}` };
  }
  const origin = axis === "x" ? { x: left, y: bottom, z: cell.z } : { x: cell.x, y: bottom, z: left };
  return { frame: { axis, origin, width, height } };
}

/** The frame around the cell, along whichever axis holds one. */
export function findNetherPortalFrame(bot: Bot, cell: Vec3): FrameSearch {
  const alongX = findFrameAlong(bot, cell, "x");
  if ("frame" in alongX) return alongX;
  const alongZ = findFrameAlong(bot, cell, "z");
  if ("frame" in alongZ) return alongZ;
  return { reason: `${alongX.reason}; ${alongZ.reason}` };
}

/** A named obsidian block can border the opening at an edge or a corner. */
export function findNetherFrame(bot: Bot, target: Vec3): FrameSearch {
  if (bot.blockAt(target)?.name !== FRAME) return findNetherPortalFrame(bot, target);
  for (const axis of ["x", "z"] as const) {
    for (const along of [-1, 0, 1])
      for (const up of [-1, 0, 1]) {
        if (along === 0 && up === 0) continue;
        const cell = target.offset(axis === "x" ? along : 0, up, axis === "z" ? along : 0);
        const found = findFrameAlong(bot, cell, axis);
        if ("frame" in found) return found;
      }
  }
  return { reason: "the named obsidian does not border a complete rectangular opening" };
}
