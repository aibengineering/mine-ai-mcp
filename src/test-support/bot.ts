/**
 * The one Mineflayer bot double the tests share.
 *
 * Every action reads the same few surfaces of a live bot: an inventory window
 * that announces slot changes, an entity with a position, the world as a block
 * reader and a ray, loaded entities and players, the dimension and the clock.
 * This builds those once. A test names only what its subject reads and adds
 * the one or two methods its action calls (`tossStack`, `consume`, `sleep`) as
 * overrides; it never rebuilds the skeleton.
 *
 * The principles behind the suite, and where each kind of test belongs, are
 * in `docs/mcp/testing.md`.
 */
import { EventEmitter } from "node:events";
import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { type CellReader, raycastThrough, worldOf } from "./world.js";

export const registry = minecraftData("1.21.4");

export interface FakeStack {
  name: string;
  count: number;
  /** Defaults to the registry id for `name`. */
  type?: number;
  [extra: string]: unknown;
}

export interface BotFixtureOptions {
  readonly username?: string;
  readonly position?: Vec3 | { x: number; y: number; z: number };
  readonly dimension?: string;
  readonly gameMode?: string;
  /** Carried stacks. The same array is returned by `inventory.items()`, so a test can mutate it. */
  readonly items?: FakeStack[];
  /** Equipment by window slot, as Mineflayer's `inventory.slots` reports it, with whatever else the subject reads. */
  readonly slots?: Record<number, { name: string; [extra: string]: unknown } | null>;
  /** Named cells (`"x,y,z": "stone"`) or a reader; everything unnamed is air, or stone at and below `groundY`. */
  readonly blocks?: Record<string, string> | CellReader;
  readonly groundY?: number | null;
  readonly entities?: Record<number, unknown>;
  readonly players?: Record<string, unknown>;
  readonly time?: { age?: number; timeOfDay?: number };
}

export type FakeBot = Bot & { inventory: Bot["inventory"] & EventEmitter };

/** Mineflayer's window slot for each equipment destination. */
export const EQUIPMENT_SLOTS: Record<string, number> = {
  hand: 36,
  "off-hand": 45,
  head: 5,
  torso: 6,
  legs: 7,
  feet: 8,
};

/**
 * A bot with the shared surfaces above, then `overrides` spread on top for
 * whatever else the subject reads or calls.
 */
export function botFixture(options: BotFixtureOptions = {}, overrides: Record<string, unknown> = {}): FakeBot {
  const stacks = options.items ?? [];
  for (const stack of stacks) stack.type ??= registry.itemsByName[stack.name]?.id ?? 0;
  const slots = options.slots ?? {};
  // The real window announces every slot the server redraws; an action that
  // waits for the server's count listens for exactly that.
  const inventory = Object.assign(new EventEmitter(), {
    inventoryStart: 9,
    inventoryEnd: 45,
    slots,
    items: () => stacks,
    count: (type: number) => stacks.filter((stack) => stack.type === type).reduce((sum, stack) => sum + stack.count, 0),
    emptySlotCount: () => 36 - stacks.length,
  });
  const read: CellReader =
    typeof options.blocks === "function" ? options.blocks : worldOf(options.blocks ?? {}, { groundY: options.groundY });
  const solid = (cell: Vec3) => (read(cell)?.shapes.length ?? 0) > 0;
  const { x, y, z } = options.position ?? { x: 0.5, y: 64, z: 0.5 };
  return Object.assign(new EventEmitter(), {
    username: options.username ?? "TestBot",
    registry,
    inventory,
    entity: {
      id: 1,
      position: new Vec3(x, y, z),
      velocity: new Vec3(0, 0, 0),
      yaw: 0,
      pitch: 0,
      height: 1.8,
      width: 0.6,
      onGround: true,
      isInWater: false,
      climbing: false,
      effects: {},
    },
    entities: options.entities ?? {},
    players: options.players ?? {},
    game: { dimension: options.dimension ?? "overworld", gameMode: options.gameMode ?? "survival" },
    time: { age: 24_000, timeOfDay: 6_000, ...options.time },
    health: 20,
    food: 20,
    foodSaturation: 5,
    heldItem: null,
    usingHeldItem: false,
    blockAt: read,
    findBlocks: () => [],
    world: {
      raycast: (origin: Vec3, direction: Vec3, distance: number) => raycastThrough(solid, origin, direction, distance),
      getBlockStateId: () => registry.blocksByName.air.defaultState,
      getColumns: () => [],
    },
    getEquipmentDestSlot: (destination: string) => EQUIPMENT_SLOTS[destination],
    setControlState: () => undefined,
    waitForTicks: async () => undefined,
    lookAt: async () => undefined,
    look: async () => undefined,
    equip: async () => undefined,
    ...overrides,
  }) as unknown as FakeBot;
}
