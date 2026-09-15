/**
 * A world for building in without a server: a stone floor under air, a bot
 * that carries what it is told, and physical effects that edit the map. Every
 * stall the build process has had was a disagreement between what the world
 * offered and what the loop did about it, which a fake answers in a
 * millisecond rather than a thirty-second fixture.
 */
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { BuildRequest } from "../navigation/processes/building/build-process.js";
import { observation } from "./navigation.js";

const registry = minecraftData("1.21.4");

const key = (position: { x: number; y: number; z: number }) => `${position.x},${position.y},${position.z}`;

export interface StructureWorldOptions {
  readonly feet?: Vec3;
  readonly carried?: Record<string, number>;
  /** Cells beyond this many blocks from the bot read as unloaded. */
  readonly loadedRadius?: number;
}

export type StructurePhysics = Pick<BuildRequest, "movements" | "route" | "breakInPlace" | "canSeeDig" | "place">;

/** A stone floor at y 63 under air, a bot standing at `feet`, and the log of what the physics did. */
export function structureWorld(options: StructureWorldOptions = {}) {
  const blocks = new Map<string, { name: string; boundingBox: "block" | "empty"; position: Vec3 }>();
  const put = (position: Vec3, name: string) =>
    blocks.set(key(position), { name, boundingBox: name === "air" ? "empty" : "block", position });
  for (let x = -6; x <= 40; x += 1) for (let z = -6; z <= 6; z += 1) put(new Vec3(x, 63, z), "stone");
  const carried = new Map(Object.entries(options.carried ?? { cobblestone: 64, obsidian: 14 }));
  const position = (options.feet ?? new Vec3(0, 64, 0)).offset(0.5, 0, 0.5);
  const bot = {
    game: { dimension: "overworld" },
    registry,
    entity: { position, height: 1.8 },
    inventory: {
      items: () => [...carried].filter(([, count]) => count > 0).map(([name, count]) => ({ name, count })),
    },
    blockAt: (at: Vec3) => {
      if (options.loadedRadius !== undefined && at.distanceTo(bot.entity.position) > options.loadedRadius) return null;
      return blocks.get(key(at)) ?? { name: "air", boundingBox: "empty" as const, position: at };
    },
  } as unknown as Bot;
  const placements: string[] = [];
  const routes: string[] = [];
  const protectedSets: ReadonlySet<number>[] = [];
  const physics: StructurePhysics = {
    canSeeDig: () => true,
    movements: (protectedCells) => {
      protectedSets.push(protectedCells);
      return {} as never;
    },
    route: async ({ goal, onArrival }) => {
      // Arrive next to whatever the goal asks for first: two blocks toward the
      // origin side of it. Then let the process work there and, if it asks to
      // continue, walk on to the next thing the revised goal names.
      for (let legs = 0; legs < 64; legs += 1) {
        const resolved = goal.resolve(observation());
        if (resolved.kind !== "active") return { status: "stopped", reason: resolved.observation, elapsedMs: 0 };
        const target = /(-?\d+),(-?\d+),(-?\d+)/.exec(resolved.revision)!;
        routes.push(resolved.revision);
        bot.entity.position = new Vec3(Number(target[1]) - 2 + 0.5, 64, Number(target[3]) + 0.5);
        const decision = onArrival ? await onArrival({ signal: undefined } as never) : { kind: "completed" };
        if (decision.kind === "completed") return { status: "completed", elapsedMs: 0 };
      }
      return { status: "stopped", reason: "the fake route ran out of legs", elapsedMs: 0 };
    },
    breakInPlace: async ({ position }) => {
      put(new Vec3(position.x, position.y, position.z), "air");
      return { status: "broken" };
    },
    place: async (placement) => {
      const cell = placement.expectedCells[0];
      placements.push(key(cell));
      put(new Vec3(cell.x, cell.y, cell.z), placement.item.name);
      carried.set(placement.item.name, (carried.get(placement.item.name) ?? 0) - 1);
      return { kind: "placed", block: blocks.get(key(cell)) as never };
    },
  };
  return { bot, blocks, put, physics, placements, routes, protectedSets };
}
