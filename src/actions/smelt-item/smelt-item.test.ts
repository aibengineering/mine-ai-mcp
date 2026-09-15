import type { NavigationRuntime } from "../../navigation/index.js";
import type { Bot } from "mineflayer";
const navigation = {} as NavigationRuntime;
import assert from "node:assert/strict";
import test from "node:test";
import { botFixture, registry, type FakeStack } from "../../test-support/bot.js";
import { createSmeltItemAction, parseSmeltItemRequest, smeltItem, type SmeltItemDependencies } from "./index.js";

test("a named furnace and a temporary one are exclusive, and a temporary one must be carried", async () => {
  assert.deepEqual(
    parseSmeltItemRequest({
      item_name: " Minecraft:Raw Iron ",
      count: 3,
      fuel_item_name: "Coal",
      x: 4,
      y: 64,
      z: -2,
    }),
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 4, y: 64, z: -2 },
  );

  const input = { item_name: "raw_iron", count: 3, fuel_item_name: "coal", temporary_workstation: true };
  const request = parseSmeltItemRequest(input);
  assert.deepEqual(request, { itemName: "raw_iron", count: 3, fuelItemName: "coal", temporaryWorkstation: true });
  assert.throws(() => parseSmeltItemRequest({ ...input, x: 1, y: 64, z: 0 }));
  assert.throws(() => parseSmeltItemRequest({ ...input, temporary_workstation: false }));
  assert.throws(() => parseSmeltItemRequest({ ...input, temporary_workstation: false, x: 1 }));
  const { bot, dependencies } = smeltingBot();
  const result = await smeltItem(bot, navigation, request, {}, dependencies);
  assert.equal(result.status, "failed");
  assert.match(result.error, /WORKSTATION_NOT_CARRIED.*furnace/);
  assert.equal(result.smelt.furnace, null);
  assert.equal(result.smelt.inputInventoryAfter, 3);
});

function smeltingBot() {
  const items: FakeStack[] = [
    { name: "raw_iron", count: 3 },
    { name: "coal", count: 1 },
  ];
  const adjust = (name: string, delta: number) => {
    const stack = items.find((candidate) => candidate.name === name);
    if (stack) stack.count += delta;
    else items.push({ name, count: delta, type: registry.itemsByName[name]!.id });
    if (stack && stack.count === 0) items.splice(items.indexOf(stack), 1);
  };
  let input: { name: string; count: number } | null = null;
  let fuel: { name: string; count: number } | null = null;
  let output: { name: string; count: number; type: number; stackSize: number; slot: number } | null = null;
  const take = (slot: { name: string; count: number } | null) => {
    if (slot) adjust(slot.name, slot.count);
    return slot;
  };
  const furnace = {
    inputItem: () => input,
    fuelItem: () => fuel,
    outputItem: () => output,
    putInput: async (_type: number, _metadata: null, count: number) => {
      adjust("raw_iron", -count);
      input = { name: "raw_iron", count };
    },
    putFuel: async (_type: number, _metadata: null, count: number) => {
      adjust("coal", -count);
      fuel = null;
      input = null;
      output = { name: "iron_ingot", count: 3, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 };
    },
    takeInput: async () => take(input),
    takeFuel: async () => take(fuel),
    takeOutput: async () => take(output),
    close: () => undefined,
  };
  const bot = botFixture({ items, blocks: { "2,64,0": "furnace" } });
  bot.clickWindow = async (slot) => {
    if (slot !== 2 || !output) return;
    adjust(output.name, output.count);
    output = null;
  };
  const dependencies: SmeltItemDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    openFurnace: async () => furnace as never,
    now: Date.now,
    pause: async () => undefined,
  };
  return { bot, dependencies };
}

test("smelts the requested input and reports output actually taken into inventory", async () => {
  const { bot, dependencies } = smeltingBot();
  const result = await smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    dependencies,
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.smelt.outputItem, "iron_ingot");
  assert.equal(result.smelt.produced, 3);
  assert.equal(result.smelt.inputInventoryAfter, 0);
  assert.equal(result.smelt.fuelInventoryAfter, 0);
});

test("does not insert anything into a furnace that already owns contents", async () => {
  let readProgress: (() => import("../../session/request.js").RequestEvidence) | undefined;
  const { bot, dependencies } = smeltingBot();
  const occupiedDependencies: SmeltItemDependencies = {
    ...dependencies,
    openFurnace: async () =>
      ({
        inputItem: () => ({ name: "sand", count: 1 }),
        fuelItem: () => null,
        outputItem: () => null,
        takeInput: async () => ({ name: "sand", count: 1 }),
        takeFuel: async () => null,
        takeOutput: async () => null,
        close: () => undefined,
      }) as never,
  };

  const result = await smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    { observeProgress: (read) => { readProgress = read; } },
    occupiedDependencies,
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /FURNACE_NOT_EMPTY/);
  assert.equal(result.smelt.inputInventoryAfter, 3);
  assert.equal(readProgress?.().completion.observed, false);
});

function observedFurnace(options: { readonly cookMs: number; readonly stopAfter?: number; readonly starved?: boolean; readonly recoverInputCount?: number }) {
  const items: FakeStack[] = [
    { name: "raw_iron", count: 3 },
    { name: "coal", count: 1 },
  ];
  const adjust = (name: string, delta: number) => {
    const stack = items.find((candidate) => candidate.name === name);
    if (stack) stack.count += delta;
    else items.push({ name, count: delta, type: registry.itemsByName[name]!.id });
    if (stack?.count === 0) items.splice(items.indexOf(stack), 1);
  };
  let now = 0;
  let input = 0;
  let output = 0;
  let activeFuel = 0;
  const furnace = {
    progress: 0,
    fuel: 0,
    inputItem: () => input > 0 ? { name: "raw_iron", count: input } : null,
    fuelItem: () => null,
    outputItem: () => output > 0 ? { name: "iron_ingot", count: output, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 } : null,
    putInput: async (_type: number, _metadata: null, count: number) => {
      adjust("raw_iron", -count);
      input = count;
    },
    putFuel: async () => {
      adjust("coal", -1);
      activeFuel = options.starved ? 0 : 1;
      furnace.fuel = activeFuel;
    },
    takeInput: async () => {
      const taken = { name: "raw_iron", count: input };
      const moved = Math.min(input, options.recoverInputCount ?? input);
      adjust(taken.name, moved);
      input -= moved;
      return taken;
    },
    takeFuel: async () => null,
    takeOutput: async () => {
      const taken = { name: "iron_ingot", count: output };
      adjust(taken.name, taken.count);
      output = 0;
      return taken;
    },
    close: () => undefined,
  };
  const bot = botFixture({ items, blocks: { "2,64,0": "furnace" } });
  bot.clickWindow = async (slot) => {
    if (slot !== 2 || output === 0) return;
    adjust("iron_ingot", output);
    output = 0;
  };
  let elapsedInItem = 0;
  const dependencies: SmeltItemDependencies = {
    createMovements: () => ({}) as never,
    navigate: async () => ({ status: "completed", elapsedMs: 0 }),
    openFurnace: async () => furnace as never,
    now: () => now,
    pause: async (milliseconds, signal) => {
      signal?.throwIfAborted();
      now += milliseconds;
      if (output === options.stopAfter) return;
      if (activeFuel === 0) return;
      elapsedInItem += milliseconds;
      furnace.progress = Math.min(1, elapsedInItem / options.cookMs);
      furnace.fuel = activeFuel > 0 ? Math.max(0, 1 - now / (options.cookMs * 8)) : 0;
      if (elapsedInItem < options.cookMs) return;
      elapsedInItem = 0;
      furnace.progress = 0;
      input -= 1;
      output += 1;
      if (input === 0) activeFuel = 0;
    },
  };
  return { bot, dependencies, furnace, get now() { return now; } };
}

test("keeps waiting while native cook progress advances beyond the old wall-clock deadline", async () => {
  const fixture = observedFurnace({ cookMs: 20_000 });
  const result = await smeltItem(
    fixture.bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    fixture.dependencies,
  );

  assert.equal(result.status, "succeeded");
  assert.equal(result.smelt.produced, 3);
  assert.equal(result.smelt.rawRecovered, 0);
  assert(fixture.now > 3 * 10_000 + 5_000);
});

test("reports a true cook stall and the raw input recovered from the furnace", async () => {
  const fixture = observedFurnace({ cookMs: 2_000, stopAfter: 1 });
  const result = await smeltItem(
    fixture.bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    fixture.dependencies,
  );

  assert.equal(result.status, "partial");
  assert.match(result.error, /SMELT_STALLED.*retrieved 1\/3 cooked, 2 raw, and 0 fuel/);
  assert.equal(result.smelt.produced, 1);
  assert.equal(result.smelt.rawRecovered, 2);
  assert.equal(result.smelt.inputInventoryAfter, 2);
});

test("distinguishes exhausted fuel from a cook stall", async () => {
  const fixture = observedFurnace({ cookMs: 2_000, starved: true });
  const result = await smeltItem(
    fixture.bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    fixture.dependencies,
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /SMELT_FUEL_STARVED.*0\/3 cooked, 3 raw, and 0 fuel/);
  assert.equal(result.smelt.rawRecovered, 3);
  assert.equal(fixture.now, 1_000);
});

test("reports only the raw count removed from a partially recovered furnace slot", async () => {
  const fixture = observedFurnace({ cookMs: 2_000, stopAfter: 1, recoverInputCount: 1 });
  const result = await smeltItem(
    fixture.bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    fixture.dependencies,
  );

  assert.equal(result.status, "partial");
  assert.equal(result.smelt.produced, 1);
  assert.equal(result.smelt.rawRecovered, 1);
  assert.match(result.error, /retrieved 1\/3 cooked, 1 raw, and 0 fuel/);
});

for (const stop of ["cancelled", "disconnected"] as const) {
  test(`bounds ${stop} settlement and gives back observed furnace contents`, async () => {
    const fixture = observedFurnace({ cookMs: 2_000 });
    const controller = new AbortController();
    const originalPause = fixture.dependencies.pause;
    const dependencies: SmeltItemDependencies = {
      ...fixture.dependencies,
      pause: async (milliseconds, signal) => {
        await originalPause(milliseconds, signal);
        controller.abort(new Error(stop));
      },
    };
    await assert.rejects(
      smeltItem(
        fixture.bot,
        navigation,
        { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
        { signal: controller.signal },
        dependencies,
      ),
      new RegExp(stop),
    );
    assert.equal(fixture.bot.inventory.items().find((item) => item.name === "raw_iron")?.count, 3);
  });
}

test("the production action clock is monotonic when the wall clock jumps", async (t) => {
  const originalDateNow = Date.now;
  let wallNow = originalDateNow();
  Date.now = () => (wallNow += 1_000_000);
  t.after(() => { Date.now = originalDateNow; });
  const fixture = observedFurnace({ cookMs: 20_000, stopAfter: 0 });
  fixture.bot.openFurnace = async () => fixture.furnace as never;
  const controller = new AbortController();
  const pending = createSmeltItemAction(fixture.bot, navigation).execute(
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(new Error("clock test cancelled")), 20);

  await assert.rejects(pending, /clock test cancelled/);
});

test("a nonsettling slot take closes the window without starting later recovery mutations", async () => {
  const { bot, dependencies } = smeltingBot();
  let closed = false;
  let inputTakes = 0;
  let fuelTakes = 0;
  let loaded = false;
  let takingOutput = false;
  let outputClick: readonly [number, number, number] | null = null;
  const unresolved = new Promise<never>(() => undefined);
  bot.clickWindow = (slot, button, mode) => {
    outputClick = [slot, button, mode];
    takingOutput = true;
    return unresolved;
  };
  const stuckDependencies: SmeltItemDependencies = {
    ...dependencies,
    openFurnace: async () => ({
      progress: 0,
      fuel: 0,
      inputItem: () => takingOutput ? { name: "raw_iron", count: 3 } : null,
      fuelItem: () => takingOutput ? { name: "coal", count: 1 } : null,
      outputItem: () => loaded ? { name: "iron_ingot", count: 3, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 } : null,
      putInput: async () => undefined,
      putFuel: async () => { loaded = true; },
      takeOutput: () => unresolved,
      takeInput: async () => { inputTakes += 1; return null; },
      takeFuel: async () => { fuelTakes += 1; return null; },
      close: () => { closed = true; },
    }) as never,
  };
  const started = performance.now();
  const result = await smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    stuckDependencies,
  );
  const elapsed = performance.now() - started;

  assert.equal(result.status, "failed");
  assert.match(result.error, /takeOutput did not settle within 2000 ms/);
  assert(elapsed >= 1_900 && elapsed < 3_000, `bounded settlement took ${elapsed} ms`);
  assert.equal(closed, true);
  assert.equal(inputTakes, 0);
  assert.equal(fuelTakes, 0);
  assert.deepEqual(outputClick, [2, 0, 1], "furnace output uses one shift-click, never the result-slot cursor path");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(inputTakes, 0, "the timed-out operation cannot advance to a later slot after close");
  assert.equal(fuelTakes, 0, "the timed-out operation cannot advance to a later slot after close");
});

test("refuses furnace output recovery before clicking when inventory has no room", async () => {
  const { bot, dependencies } = smeltingBot();
  let loaded = false;
  let clicks = 0;
  (bot.inventory as Bot["inventory"] & { emptySlotCount: () => number }).emptySlotCount = () => 0;
  bot.clickWindow = async () => { clicks += 1; };
  const result = await smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    {
      ...dependencies,
      openFurnace: async () => ({
        progress: 0,
        fuel: 0,
        inputItem: () => null,
        fuelItem: () => null,
        outputItem: () => loaded ? { name: "iron_ingot", count: 3, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 } : null,
        putInput: async () => undefined,
        putFuel: async () => { loaded = true; },
        takeOutput: async () => null,
        takeInput: async () => null,
        takeFuel: async () => null,
        close: () => undefined,
      }) as never,
    },
  );

  assert.equal(result.status, "failed");
  assert.match(result.error, /No inventory room for furnace output iron_ingot x3/);
  assert.equal(clicks, 0);
});

test("does not start a multi-click raw recovery after output consumes the last inventory slot", async () => {
  const { bot, dependencies } = smeltingBot();
  let loaded = false;
  let outputRemoved = false;
  let freeSlots = 1;
  let inputTakes = 0;
  let fuelTakes = 0;
  (bot.inventory as Bot["inventory"] & { emptySlotCount: () => number }).emptySlotCount = () => freeSlots;
  bot.clickWindow = async () => {
    freeSlots = 0;
    outputRemoved = true;
    const items = bot.inventory.items() as unknown as FakeStack[];
    items.push({ name: "iron_ingot", count: 1, type: registry.itemsByName.iron_ingot!.id });
  };
  const result = await smeltItem(
    bot,
    navigation,
    { itemName: "raw_iron", count: 3, fuelItemName: "coal", x: 2, y: 64, z: 0 },
    {},
    {
      ...dependencies,
      openFurnace: async () => ({
        progress: 0.5,
        fuel: 0.5,
        inputItem: () => loaded ? { name: "raw_iron", count: 2, type: registry.itemsByName.raw_iron!.id, stackSize: 64 } : null,
        fuelItem: () => loaded ? { name: "coal", count: 1, type: registry.itemsByName.coal!.id, stackSize: 64 } : null,
        outputItem: () => loaded && !outputRemoved ? { name: "iron_ingot", count: 1, type: registry.itemsByName.iron_ingot!.id, stackSize: 64, slot: 2 } : null,
        putInput: async () => undefined,
        putFuel: async () => { loaded = true; throw new Error("fixture stops after loading"); },
        takeOutput: async () => null,
        takeInput: async () => { inputTakes += 1; return null; },
        takeFuel: async () => { fuelTakes += 1; return null; },
        close: () => undefined,
      }) as never,
    },
  );

  assert.equal(result.status, "partial");
  assert.equal(result.smelt.produced, 1);
  assert.equal(result.smelt.rawRecovered, 0);
  assert.match(result.error, /No inventory room for furnace input raw_iron x2/);
  assert.equal(inputTakes, 0);
  assert.equal(fuelTakes, 0);
});
