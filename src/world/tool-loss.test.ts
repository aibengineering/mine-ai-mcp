import assert from "node:assert/strict";
import test from "node:test";
import { botFixture, registry } from "../test-support/bot.js";
import { WELL_FED, flatWorld, planningStart } from "../test-support/navigation.js";
import { createMovementCatalogue } from "../navigation/movements/catalogue.js";
import { createMovementPolicy } from "../navigation/movements/policy.js";
import windowsLoader from "prismarine-windows";
import prismarineItem from "prismarine-item";
import { observeToolTierLoss } from "./tool-loss.js";

function select(bot: ReturnType<typeof botFixture>, guard: ReturnType<typeof observeToolTierLoss>, item: string) {
  guard.select(bot.registry.itemsByName[item]!.id);
}

test("stops only when a relevant best harvest capability drops", async () => {
  const items = [
    { name: "diamond_pickaxe", count: 1, slot: 36, maxDurability: 1561, durabilityUsed: 1559 },
    { name: "stone_pickaxe", count: 1, slot: 9, maxDurability: 131, durabilityUsed: 0 },
    { name: "wooden_axe", count: 1, slot: 10, maxDurability: 59, durabilityUsed: 0 },
  ];
  const bot = botFixture({ items });
  const guard = observeToolTierLoss(bot);
  select(bot, guard, "diamond_pickaxe");
  items.splice(2, 1); // unrelated axe loss
  bot.inventory.emit("updateSlot", 10, null);
  await Promise.resolve();
  assert.equal(guard.loss(), null);
  items.splice(0, 1); // packet can skip the final one-durability observation
  bot.inventory.emit("updateSlot", 36, null);
  await Promise.resolve();
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.loss()?.now.item, "stone_pickaxe");
  assert.match(guard.loss()?.reason ?? "", /diamond_pickaxe was lost.*stone pickaxe remains/);
  guard.close();
  assert.equal(registry.itemsByName.diamond_pickaxe?.maxDurability, 1561);
});

test("gold replacement does not preserve stone harvest capability", async () => {
  const items = [{ name: "stone_pickaxe", count: 1, slot: 36 }, { name: "golden_pickaxe", count: 1, slot: 9 }];
  const bot = botFixture({ items });
  const guard = observeToolTierLoss(bot);
  select(bot, guard, "stone_pickaxe");
  items.shift();
  bot.inventory.emit("updateSlot", 36, null);
  await Promise.resolve();
  assert.equal(guard.loss()?.now.tier, "golden");
  guard.close();
});

test("material downgrade and loss of the last selected tool stop independently of harvest rank", async () => {
  for (const replacement of ["diamond_pickaxe", null] as const) {
    const items = [{ name: "netherite_pickaxe", count: 1, slot: 36 }];
    if (replacement) items.push({ name: replacement, count: 1, slot: 9 });
    const bot = botFixture({ items });
    const guard = observeToolTierLoss(bot);
    select(bot, guard, "netherite_pickaxe");
    items.shift();
    bot.inventory.emit("updateSlot", 36, null);
    await Promise.resolve();
    assert.equal(guard.signal.aborted, true);
    assert.equal(guard.loss()?.now.item, replacement);
    guard.close();
  }
});

test("a tool considered only by speculative search is not relevant", async () => {
  const items = [{ name: "diamond_pickaxe", count: 1, slot: 36 }, { name: "diamond_axe", count: 1, slot: 9 }];
  const bot = botFixture({ items });
  const guard = observeToolTierLoss(bot);
  const axe = bot.registry.itemsByName.diamond_axe!.id;
  const world = flatWorld();
  world.load({ x: 1, y: 63, z: 0 }, { stateId: 1, traits: { empty: false, safeToBreak: true } });
  const candidates = createMovementCatalogue().generate(planningStart({ x: 0, y: 63, z: 0 }, 0), {
    world,
    policy: createMovementPolicy({ priceBreak: () => ({ decision: { kind: "allowed" }, tool: { itemType: axe, expectedTicks: 1 } }) }),
    player: WELL_FED,
    stepField: null,
  }, { submergedAtEyes: false, onGround: true, aquaAffinity: false, effects: {} }).toArray();
  assert.equal(candidates.some((candidate) => candidate.step.operations.some(
    (operation) => operation.kind === "break" && operation.toolType === axe,
  )), true, "candidate generation must really consider the unused axe dig");
  // Only the route executor callback for its selected physical effect reaches the guard.
  guard.select(bot.registry.itemsByName.diamond_pickaxe!.id);
  items.splice(1, 1);
  bot.inventory.emit("updateSlot", 9, null);
  await Promise.resolve();
  assert.equal(guard.loss(), null);
  guard.close();
});

test("a selected tool moving through Mineflayer's inventory cursor is not lost", async () => {
  const bot = botFixture();
  Reflect.set(bot, "registry", registry);
  const loadWindows = windowsLoader as unknown as (version: string) => { createWindow: (...args: unknown[]) => import("prismarine-windows").Window };
  const loadItem = prismarineItem as unknown as (data: typeof registry) => new (type: number, count: number) => import("prismarine-item").Item;
  const window = loadWindows("1.21.4").createWindow(0, "minecraft:inventory", "Inventory");
  const Item = loadItem(registry);
  const diamond = new Item(registry.itemsByName.diamond_pickaxe!.id, 1);
  window.updateSlot(9, diamond);
  bot.inventory = window as never;
  const guard = observeToolTierLoss(bot);
  guard.select(registry.itemsByName.diamond_pickaxe!.id);

  // Exercise the pinned prismarine-windows implementation: swapSelectedItem
  // emits updateSlot before it assigns selectedItem.
  const swapSelectedItem = Reflect.get(window, "swapSelectedItem") as (...args: unknown[]) => void;
  Reflect.apply(swapSelectedItem, window, [9, diamond]);
  await Promise.resolve();
  assert.equal(guard.loss(), null, "source-slot removal while the item is on the cursor is a transfer");

  Reflect.apply(swapSelectedItem, window, [36, null]);
  await Promise.resolve();
  assert.equal(guard.loss(), null, "destination-slot placement completes the normal equip");
  guard.close();
});
