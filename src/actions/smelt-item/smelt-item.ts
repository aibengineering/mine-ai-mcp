import { smeltCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { createMovements, nearGoal, type Navigate, type NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { carriedCount, settleInventoryCount, settleInventoryMinimum } from "../../world/inventory-count.js";
import { waitForSignal } from "../../utils/signals.js";
import { defineAction, type ActionContext } from "../action.js";
import { describeNavigation } from "../navigation-result.js";
import { formatWorkstation, useTemporaryWorkstation, workstationOperations } from "../temporary-workstation.js";
import type { ExistingFurnaceRequest } from "./contract.js";
import {
  parseSmeltItemRequest,
  SMELT_ITEM,
  SMELT_ITEM_DESCRIPTION,
  smeltItemInputSchema,
  smeltItemResultSchema,
  smeltItemAnnotations,
  smeltItemOutcomes,
  type SmeltItemRequest,
  type SmeltItemResult,
  type SmeltEvidence,
} from "./contract.js";

const FURNACE_REACH = 4.5;
const COOK_MS_PER_ITEM = 10_000;
const COOK_STALL_MS = 15_000;
const FUEL_START_SETTLEMENT_MS = 1_000;
const SLOT_RECOVERY_MS = 2_000;

type FurnaceWindow = Awaited<ReturnType<Bot["openFurnace"]>>;
type FurnaceBlock = NonNullable<ReturnType<Bot["blockAt"]>>;

export interface SmeltItemDependencies {
  readonly createMovements: typeof createMovements;
  readonly navigate: Navigate;
  readonly openFurnace: (bot: Bot, block: FurnaceBlock) => Promise<FurnaceWindow>;
  readonly now: () => number;
  readonly pause: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

function abortablePause(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, milliseconds);
    const aborted = () => done(signal?.reason ?? new Error("Smelting was cancelled."));
    function done(cause?: unknown) {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      if (cause !== undefined) reject(cause);
      else resolve();
    }
    if (signal?.aborted) aborted();
    else signal?.addEventListener("abort", aborted, { once: true });
  });
}

function productionDependencies(navigate: Navigate): SmeltItemDependencies {
  return {
    createMovements,
    navigate,
    openFurnace: (bot, block) => bot.openFurnace(block),
    now: () => performance.now(),
    pause: abortablePause,
  };
}

function fuelCapacity(name: string): number {
  if (name === "coal" || name === "charcoal") return 8;
  if (name === "coal_block") return 80;
  if (name === "dried_kelp_block") return 20;
  if (name === "blaze_rod") return 12;
  if (name.endsWith("_planks") || name.endsWith("_log") || name.endsWith("_wood")) return 1.5;
  if (name === "stick") return 0.5;
  return 0;
}

function evidence(
  bot: Bot,
  request: SmeltItemRequest,
  before: { readonly input: number; readonly fuel: number },
  observed: {
    readonly fuelInserted?: number;
    readonly outputItem?: string | null;
    readonly produced?: number;
    readonly rawRecovered?: number;
    readonly fuelRecovered?: number;
    readonly finalCookProgress?: number | null;
    readonly finalFuelProgress?: number | null;
    /** The settled input count, once the furnace has given back what it did not burn. */
    readonly inputAfter?: number;
  } = {},
): SmeltEvidence {
  return {
    dimension: bot.game.dimension,
    furnace: request.temporaryWorkstation === true ? null : { x: request.x, y: request.y, z: request.z },
    inputItem: request.itemName,
    fuelItem: request.fuelItemName,
    requested: request.count,
    fuelInserted: observed.fuelInserted ?? 0,
    outputItem: observed.outputItem ?? null,
    produced: observed.produced ?? 0,
    inputInventoryBefore: before.input,
    inputInventoryAfter: observed.inputAfter ?? carriedCount(bot, request.itemName),
    fuelInventoryBefore: before.fuel,
    fuelInventoryAfter: carriedCount(bot, request.fuelItemName),
    rawRecovered: observed.rawRecovered ?? 0,
    fuelRecovered: observed.fuelRecovered ?? 0,
    finalCookProgress: observed.finalCookProgress ?? null,
    finalFuelProgress: observed.finalFuelProgress ?? null,
  };
}

interface Recovery {
  readonly input: number;
  readonly fuel: number;
  readonly output: { readonly name: string; readonly count: number; readonly inventoryBefore: number } | null;
  readonly errors: readonly string[];
}

async function boundedTake<T>(operation: () => Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not settle within ${SLOT_RECOVERY_MS} ms.`)), SLOT_RECOVERY_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hasInventoryRoom(bot: Bot, item: ReturnType<FurnaceWindow["outputItem"]>): boolean {
  if (!item) return false;
  if (bot.inventory.items().some((stack) => stack.type === item.type && stack.count < stack.stackSize)) return true;
  const inventory = bot.inventory as Bot["inventory"] & { emptySlotCount?: () => number };
  return (inventory.emptySlotCount?.() ?? 1) > 0;
}

async function takeOutputOnce(bot: Bot, window: FurnaceWindow) {
  const item = window.outputItem();
  if (!item) return null;
  if (!hasInventoryRoom(bot, item)) throw new Error(`No inventory room for furnace output ${item.name} x${item.count}.`);
  const inventoryBefore = carriedCount(bot, item.name);
  // Furnace slot 2 is marked as a crafting result by prismarine-windows, so
  // Furnace.takeOutput uses a cursor pickup followed by another click. A
  // single shift-click is safe here: cooking itself cannot repeat on click.
  await bot.clickWindow(item.slot, 0, 1);
  // While a container is open, Mineflayer's player inventory can lag behind
  // the window packet even after the server accepted this click. The furnace
  // output slot is the direct witness for this one-slot transaction.
  const removed = await waitForSignal(
    () => Math.max(0, item.count - (window.outputItem()?.count ?? 0)),
    window,
    "updateSlot",
    { timeoutMs: SLOT_RECOVERY_MS },
  );
  const count = removed ?? 0;
  return { name: item.name, count, inventoryBefore, confirmed: count > 0 };
}

async function takeResidualOnce(window: FurnaceWindow, slot: "inputItem" | "fuelItem") {
  const item = window[slot]();
  if (!item) return null;
  if (slot === "inputItem") await window.takeInput();
  else await window.takeFuel();
  const remaining = window[slot]()?.count ?? 0;
  return { name: item.name, count: Math.max(0, item.count - remaining), confirmed: remaining < item.count };
}

async function recover(bot: Bot, window: FurnaceWindow): Promise<Recovery> {
  let input = 0;
  let fuel = 0;
  let output: Recovery["output"] = null;
  const errors: string[] = [];
  for (const [read, take] of [
    ["outputItem", "takeOutput"],
    ["inputItem", "takeInput"],
    ["fuelItem", "takeFuel"],
  ] as const) {
    try {
      const slotItem = window[read]();
      if (!slotItem) continue;
      if (!hasInventoryRoom(bot, slotItem)) {
        errors.push(`No inventory room for furnace ${read === "outputItem" ? "output" : read === "inputItem" ? "input" : "fuel"} ${slotItem.name} x${slotItem.count}.`);
        break;
      }
      if (take === "takeOutput") {
        const taken = await boundedTake(() => takeOutputOnce(bot, window), take);
        if (!taken) continue;
        output = { name: taken.name, count: taken.count, inventoryBefore: taken.inventoryBefore };
        if (!taken.confirmed) {
          errors.push(`Inventory did not confirm furnace output ${taken.name}.`);
          break;
        }
      } else {
        const taken = await boundedTake(() => takeResidualOnce(window, read), take);
        if (!taken) continue;
        if (take === "takeInput") input += taken.count;
        else fuel += taken.count;
      }
    } catch (cause) {
      errors.push(cause instanceof Error ? cause.message : String(cause));
      // A timed-out transfer can still be pending inside Mineflayer. Do not
      // start a second slot mutation against the same window.
      break;
    }
  }
  return { input, fuel, output, errors };
}

interface FurnaceObservation {
  readonly output: number;
  readonly input: number;
  readonly fuelItems: number;
  readonly cookProgress: number | null;
  readonly fuelProgress: number | null;
}

type CookVerdict = "completed" | "fuel_starved" | "stalled" | "safety_timeout";

function furnaceObservation(window: FurnaceWindow): FurnaceObservation {
  const state = window as FurnaceWindow & { progress?: number | null; fuel?: number | null };
  return {
    output: window.outputItem()?.count ?? 0,
    input: window.inputItem()?.count ?? 0,
    fuelItems: window.fuelItem()?.count ?? 0,
    cookProgress: typeof state.progress === "number" ? state.progress : null,
    fuelProgress: typeof state.fuel === "number" ? state.fuel : null,
  };
}

async function waitForCook(
  window: FurnaceWindow,
  requested: number,
  dependencies: SmeltItemDependencies,
  signal?: AbortSignal,
  observe?: (observation: FurnaceObservation, stalledForMs: number) => void,
): Promise<{ readonly verdict: CookVerdict; readonly observation: FurnaceObservation }> {
  const startedAt = dependencies.now();
  const safetyDeadline = startedAt + Math.max(60_000, requested * COOK_MS_PER_ITEM * 4 + COOK_STALL_MS);
  let lastAdvanceAt = startedAt;
  let previous = furnaceObservation(window);
  while (true) {
    signal?.throwIfAborted();
    const current = furnaceObservation(window);
    const now = dependencies.now();
    if (current.output !== previous.output || current.cookProgress !== previous.cookProgress) lastAdvanceAt = now;
    const stalledForMs = Math.max(0, now - lastAdvanceAt);
    observe?.(current, stalledForMs);
    if (current.output >= requested && current.input === 0 && (current.cookProgress ?? 0) === 0)
      return { verdict: "completed", observation: current };
    if (
      now - startedAt >= FUEL_START_SETTLEMENT_MS &&
      current.input > 0 &&
      current.fuelItems === 0 &&
      current.fuelProgress === 0 &&
      (current.cookProgress ?? 0) === 0
    ) return { verdict: "fuel_starved", observation: current };
    if (stalledForMs >= COOK_STALL_MS) return { verdict: "stalled", observation: current };
    if (now >= safetyDeadline) return { verdict: "safety_timeout", observation: current };
    previous = current;
    await dependencies.pause(100, signal);
  }
}

async function approach(
  bot: Bot,
  request: ExistingFurnaceRequest,
  context: ActionContext,
  dependencies: SmeltItemDependencies,
): Promise<string | null> {
  const target = new Vec3(request.x, request.y, request.z);
  if (bot.entity.position.distanceTo(target) <= FURNACE_REACH) return null;
  const route = await dependencies.navigate({
    movements: dependencies.createMovements(bot),
    goal: nearGoal(target, 2),
    signal: context.signal,
  });
  return bot.entity.position.distanceTo(target) <= FURNACE_REACH ? null : describeNavigation(route);
}

/** Use one caller-selected empty furnace as a bounded, observed inventory transaction. */
export async function smeltItem(
  bot: Bot,
  navigation: NavigationRuntime,
  request: SmeltItemRequest,
  context: ActionContext,
  dependencies: SmeltItemDependencies,
): Promise<SmeltItemResult> {
  if (request.temporaryWorkstation !== true) return smeltInFurnace(bot, request, context, dependencies);
  return useTemporaryWorkstation(
    bot,
    "furnace",
    context,
    workstationOperations(bot, navigation),
    (block) =>
      smeltInFurnace(
        bot,
        {
          itemName: request.itemName,
          count: request.count,
          fuelItemName: request.fuelItemName,
          x: block.position.x,
          y: block.position.y,
          z: block.position.z,
        },
        context,
        dependencies,
      ),
    (error) => ({
      status: "failed",
      error,
      smelt: evidence(bot, request, {
        input: carriedCount(bot, request.itemName),
        fuel: carriedCount(bot, request.fuelItemName),
      }),
    }),
  );
}

async function smeltInFurnace(
  bot: Bot,
  request: ExistingFurnaceRequest,
  context: ActionContext,
  dependencies: SmeltItemDependencies,
): Promise<SmeltItemResult> {
  context.signal?.throwIfAborted();
  const before = { input: carriedCount(bot, request.itemName), fuel: carriedCount(bot, request.fuelItemName) };
  const input = bot.registry.itemsByName[request.itemName];
  const fuel = bot.registry.itemsByName[request.fuelItemName];
  if (!input)
    return {
      status: "failed",
      error: smeltItemOutcomes.unknownItem(request.itemName),
      smelt: evidence(bot, request, before),
    };
  if (!fuel)
    return {
      status: "failed",
      error: smeltItemOutcomes.unknownItem(request.fuelItemName),
      smelt: evidence(bot, request, before),
    };
  const capacity = fuelCapacity(request.fuelItemName);
  if (capacity === 0)
    return {
      status: "failed",
      error: smeltItemOutcomes.unsupportedFuel(request.fuelItemName),
      smelt: evidence(bot, request, before),
    };
  if (before.input < request.count)
    return {
      status: "failed",
      error: smeltItemOutcomes.inputMissing(request.itemName, before.input, request.count),
      smelt: evidence(bot, request, before),
    };
  const requiredFuel = Math.ceil(request.count / capacity);
  const availableFuel = before.fuel - (request.itemName === request.fuelItemName ? request.count : 0);
  if (availableFuel < requiredFuel)
    return {
      status: "failed",
      error: smeltItemOutcomes.fuelMissing(request.fuelItemName, Math.max(0, availableFuel), requiredFuel),
      smelt: evidence(bot, request, before),
    };

  let routeFailure: string | null;
  try {
    routeFailure = await approach(bot, request, context, dependencies);
  } catch (cause) {
    context.signal?.throwIfAborted();
    routeFailure = cause instanceof Error ? cause.message : String(cause);
  }
  if (routeFailure !== null)
    return {
      status: "failed",
      error: smeltItemOutcomes.routeStopped(routeFailure),
      smelt: evidence(bot, request, before),
    };

  const block = bot.blockAt(new Vec3(request.x, request.y, request.z));
  if (!block)
    return { status: "failed", error: smeltItemOutcomes.blockUnloaded, smelt: evidence(bot, request, before) };
  if (block.name !== "furnace")
    return {
      status: "failed",
      error: smeltItemOutcomes.furnaceMissing(block.name),
      smelt: evidence(bot, request, before),
    };

  let furnace: FurnaceWindow;
  try {
    furnace = await dependencies.openFurnace(bot, block);
  } catch (cause) {
    context.signal?.throwIfAborted();
    return { status: "failed", error: smeltItemOutcomes.openFailed(cause), smelt: evidence(bot, request, before) };
  }

  let fuelInserted = 0;
  let outputItem: string | null = null;
  let produced = 0;
  let rawRecovered = 0;
  let fuelRecovered = 0;
  let ownsSlots = false;
  let current = furnaceObservation(furnace);
  let stalledForMs = 0;
  context.observeProgress?.(() => ({ baseline: { ...before },
    checkpoint: { phase: ownsSlots ? "smelting_or_collecting" : "loading_furnace", requested: request.count, produced,
      outputItem, furnaceOutput: current.output, fuelInserted, furnaceInput: current.input, furnaceFuel: current.fuelItems,
      cookProgress: current.cookProgress, fuelProgress: current.fuelProgress, stalledForMs },
    completion: { kind: "event", observed: produced >= request.count, owes: "Requested cooked output retrieved with confirmed furnace cleanup." },
  }));
  const occupied = [
    furnace.inputItem() && "input",
    furnace.fuelItem() && "fuel",
    furnace.outputItem() && "output",
  ].filter((slot): slot is string => Boolean(slot));
  if (occupied.length > 0) {
    furnace.close();
    return {
      status: "failed",
      error: smeltItemOutcomes.occupied(occupied),
      smelt: evidence(bot, request, before),
    };
  }

  let verdict: CookVerdict | "execution_failed" = "execution_failed";
  let executionError = "";
  let recovery: Recovery = { input: 0, fuel: 0, output: null, errors: [] };
  try {
    await furnace.putInput(input.id, null, request.count);
    ownsSlots = true;
    context.signal?.throwIfAborted();
    await furnace.putFuel(fuel.id, null, requiredFuel);
    fuelInserted = requiredFuel;
    context.signal?.throwIfAborted();

    const waited = await waitForCook(furnace, request.count, dependencies, context.signal, (observation, idleMs) => {
      current = observation;
      stalledForMs = idleMs;
    });
    verdict = waited.verdict;
    current = waited.observation;
  } catch (cause) {
    executionError = smeltItemOutcomes.executionFailed(cause);
  } finally {
    if (ownsSlots) recovery = await recover(bot, furnace);
    furnace.close();
  }
  context.signal?.throwIfAborted();
  if (recovery.output) {
    outputItem = recovery.output.name;
    produced = recovery.output.count;
    const outputAfter = await settleInventoryMinimum(
      bot,
      outputItem,
      recovery.output.inventoryBefore + produced,
      { timeoutMs: SLOT_RECOVERY_MS, signal: context.signal },
    );
    if (!outputAfter.confirmed) {
      recovery = {
        ...recovery,
        errors: [...recovery.errors, `Player inventory did not confirm furnace output ${outputItem} x${produced} after close.`],
      };
    }
  }
  rawRecovered = recovery.input;
  fuelRecovered = recovery.fuel;
  // The furnace's take operations resolve on that window's packets; the player
  // inventory that receives the leftovers is redrawn on a later broadcast. The
  // transaction's own invariant is that the input loses exactly what was
  // smelted, so that is the count worth waiting for, and the fuel count is
  // read once it has landed.
  const inputAfter = await settleInventoryCount(bot, request.itemName, before.input - produced, {
    signal: context.signal,
  });
  const observed = evidence(bot, request, before, {
    fuelInserted,
    outputItem,
    produced,
    inputAfter: inputAfter.count,
    rawRecovered,
    fuelRecovered,
    finalCookProgress: current.cookProgress,
    finalFuelProgress: current.fuelProgress,
  });
  if (verdict === "completed" && produced >= request.count && recovery.errors.length === 0)
    return { status: "succeeded", smelt: observed };
  const recoveryError = recovery.errors.length > 0 ? ` Recovery: ${recovery.errors.join(" ")}` : "";
  const error = verdict === "fuel_starved"
    ? smeltItemOutcomes.fuelStarved(produced, request.count, rawRecovered, fuelRecovered)
    : verdict === "stalled"
      ? smeltItemOutcomes.stalled(produced, request.count, rawRecovered, fuelRecovered, current.cookProgress)
      : verdict === "safety_timeout"
        ? smeltItemOutcomes.safetyTimeout(produced, request.count, rawRecovered, fuelRecovered, current.cookProgress)
        : executionError || smeltItemOutcomes.executionFailed("Cook completed but furnace contents were not recovered.");
  return { status: produced > 0 ? "partial" : "failed", error: `${error}${recoveryError}`, smelt: observed };
}

export function formatSmeltItemResult(result: SmeltItemResult): string {
  const { smelt } = result;
  const lines = [
    `Smelted **${smelt.produced}/${smelt.requested} ${smelt.inputItem}**${smelt.outputItem ? ` into **${smelt.outputItem}**` : ""}.`,
    ...formatWorkstation(result.workstation),
    `- Furnace: ${smelt.furnace ? `${smelt.furnace.x}, ${smelt.furnace.y}, ${smelt.furnace.z}` : "not placed"} in ${smelt.dimension}`,
    `- Fuel: ${smelt.fuelItem} x${smelt.fuelInserted}; inventory ${smelt.fuelInventoryBefore} → ${smelt.fuelInventoryAfter}`,
    `- Input inventory: ${smelt.inputInventoryBefore} → ${smelt.inputInventoryAfter}`,
    `- Recovered from furnace: raw x${smelt.rawRecovered}; fuel x${smelt.fuelRecovered}`,
    `- Final furnace state: cook ${smelt.finalCookProgress === null ? "unknown" : `${Math.round(smelt.finalCookProgress * 100)}%`}; fuel ${smelt.finalFuelProgress === null ? "unknown" : `${Math.round(smelt.finalFuelProgress * 100)}%`}`,
  ];
  if (result.status !== "succeeded") lines.push("", `**Observed stop:** ${result.error}`);
  return lines.join("\n");
}

export function createSmeltItemAction(
  bot: Bot,
  navigation: NavigationRuntime,
  dependencies: SmeltItemDependencies = productionDependencies(navigation.navigate),
) {
  return defineAction({
    checkpointSchema: smeltCheckpointSchema,
    name: SMELT_ITEM,
    description: SMELT_ITEM_DESCRIPTION,
    inputSchema: smeltItemInputSchema,
    resultSchema: smeltItemResultSchema,
    formatResult: formatSmeltItemResult,
    execution: { kind: "task", prepare: () => prepareBotForMovement(bot, navigation) },
    annotations: smeltItemAnnotations,
    parse: parseSmeltItemRequest,
    execute: (request, context) => smeltItem(bot, navigation, request, context, dependencies),
  });
}
