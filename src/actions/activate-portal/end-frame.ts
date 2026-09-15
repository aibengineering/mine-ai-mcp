import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { WorldBlock } from "../../world/index.js";
import type { Position3 } from "../../utils/index.js";
import { PLAYER_HALF_WIDTH } from "../../world/player-physics.js";

export interface EndPortalFrame {
  readonly center: Vec3;
  readonly sockets: readonly { readonly position: Vec3; readonly facing: string }[];
  readonly interior: readonly Vec3[];
}

/** Twelve inward-facing sockets around a three-by-three opening; corners are absent. */
export function endFrameAt(center: Vec3): EndPortalFrame {
  const sockets: EndPortalFrame["sockets"][number][] = [];
  const interior: Vec3[] = [];
  for (let offset = -1; offset <= 1; offset += 1) {
    sockets.push(
      { position: center.offset(offset, 0, -2), facing: "south" },
      { position: center.offset(offset, 0, 2), facing: "north" },
      { position: center.offset(-2, 0, offset), facing: "east" },
      { position: center.offset(2, 0, offset), facing: "west" },
    );
    for (let z = -1; z <= 1; z += 1) interior.push(center.offset(offset, 0, z));
  }
  return { center, sockets, interior };
}

export function hasEye(block: WorldBlock | null): boolean {
  return block?.name === "end_portal_frame" && block.getProperties().eye === true;
}

export function endFrameIntact(bot: Bot, frame: EndPortalFrame): boolean {
  return frame.sockets.every(({ position, facing }) => {
    const block = bot.blockAt(position);
    return block?.name === "end_portal_frame" && block.getProperties().facing === facing;
  });
}

export function findEndFrame(bot: Bot, target: Vec3): EndPortalFrame | null {
  // The named socket can be any of the three sockets on any side.
  for (const dx of [-2, -1, 0, 1, 2])
    for (const dz of [-2, -1, 0, 1, 2]) {
      if ((Math.abs(dx) === 2) === (Math.abs(dz) === 2)) continue;
      const frame = endFrameAt(target.offset(dx, 0, dz));
      if (endFrameIntact(bot, frame)) return frame;
    }
  return null;
}

/** Keep the player's entire 0.6-block-wide body outside the opening, even above it. */
export function outsideEndOpening(frame: EndPortalFrame, feet: Position3): boolean {
  const { center } = frame;
  return (
    feet.x + PLAYER_HALF_WIDTH <= center.x - 1 ||
    feet.x - PLAYER_HALF_WIDTH >= center.x + 2 ||
    feet.z + PLAYER_HALF_WIDTH <= center.z - 1 ||
    feet.z - PLAYER_HALF_WIDTH >= center.z + 2
  );
}
