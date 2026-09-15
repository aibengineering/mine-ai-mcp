import { containerCheckpointSchema } from "../checkpoint-schemas.js";
import type { Bot } from "mineflayer";
import type { SqlBotData } from "../../bot-data/index.js";
import { forgetContainerObservation, recordContainerObservation, type ContainerContent } from "../../bot-data/index.js";
import { createMovements, nearGoal, type Navigate, type NavigationRuntime } from "../../navigation/index.js";
import { prepareBotForMovement } from "../../session/prepare-body.js";
import { asVec3 } from "../../utils/index.js";
import { chestOpeningObstruction } from "../../world/chest-clearance.js";
import { defineAction, type ActionContext } from "../action.js";
import { describeNavigation } from "../navigation-result.js";
import {
  parseUseContainerRequest,
  USE_CONTAINER,
  USE_CONTAINER_DESCRIPTION,
  useContainerInputSchema,
  useContainerResultSchema,
  useContainerAnnotations,
  useContainerOutcomes,
  type ContainerTarget,
  type ContainerTransferResult,
  type ContainerUseEvidence,
  type RequestedContainerItem,
  type UseContainerRequest,
  type UseContainerResult,
} from "./contract.js";

const CONTAINER_REACH = 4.5;

type ContainerWindow = Awaited<ReturnType<Bot["openContainer"]>>;
type ContainerBlock = NonNullable<ReturnType<Bot["blockAt"]>>;
type ContainerStack = ReturnType<ContainerWindow["containerItems"]>[number];
type ContainerOperationAttempt = { readonly kind: "completed" } | { readonly kind: "failed"; readonly cause: unknown };

type ContainerLayoutAttempt =
  | { readonly kind: "completed"; readonly movedStacks: number }
  | { readonly kind: "failed"; readonly movedStacks: number; readonly cause: unknown };

interface TransferExecution extends RequestedContainerItem {
  readonly available: number;
  readonly attempt: ContainerOperationAttempt | { readonly kind: "not_attempted" };
}

interface TransferBatchExecution {
  readonly items: readonly TransferExecution[];
  readonly compaction: ContainerLayoutAttempt | { readonly kind: "not_attempted" };
}

interface PlannedContainerStack {
  readonly slot: number;
  readonly count: number;
  readonly representative: ContainerStack;
}

interface OrganizationPlan {
  readonly stacks: readonly PlannedContainerStack[];
  readonly contents: readonly ContainerContent[];
}

interface OrganizationSettlement {
  readonly execution: ContainerLayoutAttempt;
  readonly matchedSlots: number;
  readonly contentsPreserved: boolean;
  readonly playerInventoryPreserved: boolean;
  readonly cursorEmpty: boolean;
}

type InspectRequest = Extract<UseContainerRequest, { readonly operation: "inspect" }>;
type TransferRequest = Extract<UseContainerRequest, { readonly operation: "deposit" | "withdraw" }>;
type OrganizeRequest = Extract<UseContainerRequest, { readonly operation: "organize" }>;
type InspectTarget = Extract<ContainerTarget, { readonly operation: "inspect" }>;
type TransferTarget = Extract<ContainerTarget, { readonly operation: "deposit" | "withdraw" }>;
type OrganizeTarget = Extract<ContainerTarget, { readonly operation: "organize" }>;

class UseContainerActionError extends Error {}

export interface UseContainerDependencies {
  readonly navigate: Navigate;
  readonly createMovements: typeof createMovements;
  readonly now: () => Date;
}

function productionDependencies(navigate: Navigate): UseContainerDependencies {
  return { navigate, createMovements, now: () => new Date() };
}

class OpenedContainer implements Disposable {
  static async open(bot: Bot, block: ContainerBlock): Promise<OpenedContainer> {
    try {
      const window = await bot.openContainer(block);
      return new OpenedContainer(window, (slot) => bot.clickWindow(slot, 0, 0));
    } catch (cause) {
      throw new UseContainerActionError(useContainerOutcomes.openFailed(cause), { cause });
    }
  }

  private constructor(
    private readonly window: ContainerWindow,
    private readonly clickSlot: (slot: number) => Promise<void>,
  ) {}

  get slotCount(): number {
    return this.window.inventoryStart;
  }

  contents(): ContainerContent[] {
    return this.containerStacks().map(({ slot, name: item, count }) => ({ slot, item, count }));
  }

  observedItemNames(): string[] {
    return [...new Set(this.containerStacks().map(({ name }) => name))].sort();
  }

  planOrganization(itemOrder: readonly string[]): OrganizationPlan {
    const groups = groupCompatibleStacks(this.containerStacks());
    const stacks: PlannedContainerStack[] = [];

    for (const itemName of itemOrder) {
      for (const group of groups.filter(({ representative }) => representative.name === itemName)) {
        const fullStacks = Math.floor(group.totalCount / group.representative.stackSize);
        for (let index = 0; index < fullStacks; index += 1) {
          stacks.push({
            slot: stacks.length,
            count: group.representative.stackSize,
            representative: group.representative,
          });
        }
        const remainder = group.totalCount % group.representative.stackSize;
        if (remainder > 0) stacks.push({ slot: stacks.length, count: remainder, representative: group.representative });
      }
    }

    return {
      stacks,
      contents: stacks.map(({ slot, count, representative }) => ({ slot, item: representative.name, count })),
    };
  }

  async transfer(
    operation: "deposit" | "withdraw",
    itemType: number,
    count: number,
  ): Promise<ContainerOperationAttempt> {
    try {
      if (operation === "deposit") await this.window.deposit(itemType, null, count);
      else await this.window.withdraw(itemType, null, count);
      return { kind: "completed" };
    } catch (cause) {
      return { kind: "failed", cause };
    }
  }

  async compact(signal?: AbortSignal): Promise<ContainerLayoutAttempt> {
    let movedStacks = 0;
    try {
      for (const group of groupCompatibleStacks(this.containerStacks())) {
        movedStacks += await this.compactGroup(group.representative, signal);
      }
      return { kind: "completed", movedStacks };
    } catch (cause) {
      signal?.throwIfAborted();
      return { kind: "failed", movedStacks, cause };
    }
  }

  async organize(plan: OrganizationPlan, signal?: AbortSignal): Promise<OrganizationSettlement> {
    const containerBefore = stackTotals(this.containerStacks());
    const playerInventoryBefore = stackLayout(this.window.items());
    const execution = await this.executeOrganization(plan, signal);
    const after = this.containerStacks();
    const matchedSlots = plan.stacks.filter((expected) => stackAt(after, expected.slot, expected)).length;

    return {
      execution,
      matchedSlots,
      contentsPreserved: stackTotals(after) === containerBefore,
      playerInventoryPreserved: stackLayout(this.window.items()) === playerInventoryBefore,
      cursorEmpty: this.window.selectedItem === null,
    };
  }

  private async executeOrganization(plan: OrganizationPlan, signal?: AbortSignal): Promise<ContainerLayoutAttempt> {
    const settledSlots = new Set<number>();
    const compaction = await this.compact(signal);
    if (compaction.kind === "failed") return compaction;
    let movedStacks = compaction.movedStacks;

    try {
      for (const desired of plan.stacks) {
        signal?.throwIfAborted();
        const current = this.containerStacks();
        if (stackAt(current, desired.slot, desired)) {
          settledSlots.add(desired.slot);
          continue;
        }

        const source = current.find(
          (candidate) =>
            !settledSlots.has(candidate.slot) &&
            sameItemKind(candidate, desired.representative) &&
            candidate.count === desired.count,
        );
        if (!source) {
          throw new Error(`No source stack remained for planned slot ${desired.slot}.`);
        }

        await this.moveStack(source, desired.slot, current);
        movedStacks += 1;
        settledSlots.add(desired.slot);
      }
      return { kind: "completed", movedStacks };
    } catch (cause) {
      signal?.throwIfAborted();
      return { kind: "failed", movedStacks, cause };
    }
  }

  private async compactGroup(representative: ContainerStack, signal?: AbortSignal): Promise<number> {
    let mergedStacks = 0;

    while (true) {
      signal?.throwIfAborted();
      const partials = this.containerStacks()
        .filter((stack) => sameItemKind(stack, representative) && stack.count < stack.stackSize)
        .sort((left, right) => right.count - left.count);
      if (partials.length < 2) return mergedStacks;

      const destination = partials[0]!;
      const source = partials.at(-1)!;
      await this.clickSlot(source.slot);
      await this.clickSlot(destination.slot);
      if (this.window.selectedItem) await this.clickSlot(source.slot);
      if (this.window.selectedItem) throw new Error("A compacted container stack remained held by the cursor.");
      mergedStacks += 1;
    }
  }

  private async moveStack(
    source: ContainerStack,
    destinationSlot: number,
    current: readonly ContainerStack[],
  ): Promise<void> {
    const destination = current.find(({ slot }) => slot === destinationSlot);
    if (!destination || !sameItemKind(destination, source)) {
      await this.moveOrSwapStack(source.slot, destinationSlot);
      return;
    }

    // Left-clicking two stacks of the same item merges them, so use one empty slot as a swap buffer.
    const bufferSlot = this.window.firstEmptyContainerSlot();
    if (bufferSlot === null) {
      throw new Error("No empty container slot was available to swap matching item stacks.");
    }
    await this.moveOrSwapStack(destinationSlot, bufferSlot);
    await this.moveOrSwapStack(source.slot, destinationSlot);
    await this.moveOrSwapStack(bufferSlot, source.slot);
  }

  private async moveOrSwapStack(sourceSlot: number, destinationSlot: number): Promise<void> {
    await this.clickSlot(sourceSlot);
    await this.clickSlot(destinationSlot);
    if (this.window.selectedItem) await this.clickSlot(sourceSlot);
    if (this.window.selectedItem) throw new Error("A container stack remained held by the cursor after its slot move.");
  }

  private containerStacks(): ContainerStack[] {
    return this.window.containerItems().sort((left, right) => left.slot - right.slot);
  }

  [Symbol.dispose](): void {
    this.window.close();
  }
}

function target(bot: Bot, request: InspectRequest): InspectTarget;
function target(bot: Bot, request: TransferRequest): TransferTarget;
function target(bot: Bot, request: OrganizeRequest): OrganizeTarget;
function target(bot: Bot, request: UseContainerRequest): ContainerTarget;
function target(bot: Bot, request: UseContainerRequest): ContainerTarget {
  const position = {
    dimension: bot.game.dimension,
    x: request.x,
    y: request.y,
    z: request.z,
  };
  if (request.operation === "inspect") return { ...position, operation: "inspect" };
  if (request.operation === "organize") {
    return {
      ...position,
      operation: "organize",
      itemOrder: [...request.itemOrder],
    };
  }
  return {
    ...position,
    operation: request.operation,
    items: request.items.map(({ itemName: item, count: requested }) => ({ item, requested })),
  };
}

function isLocationOwnedContainer(blockName: string): boolean {
  return (
    blockName === "chest" ||
    blockName === "trapped_chest" ||
    blockName === "barrel" ||
    blockName === "hopper" ||
    blockName === "dropper" ||
    blockName === "dispenser" ||
    blockName.endsWith("_shulker_box")
  );
}

function requestedItemNames(request: UseContainerRequest): readonly string[] {
  if (request.operation === "inspect") return [];
  if (request.operation === "organize") return request.itemOrder;
  return request.items.map(({ itemName }) => itemName);
}

function resolveItemTypes(bot: Bot, request: UseContainerRequest): ReadonlyMap<string, number> {
  const itemTypes = new Map<string, number>();
  const unknown: string[] = [];
  for (const itemName of requestedItemNames(request)) {
    const registryItem = bot.registry.itemsByName[itemName];
    if (registryItem) itemTypes.set(itemName, registryItem.id);
    else unknown.push(itemName);
  }
  if (unknown.length > 0) throw new UseContainerActionError(useContainerOutcomes.unknownItems(unknown));
  return itemTypes;
}

function itemCount(contents: readonly ContainerContent[], itemName: string): number {
  return contents.filter(({ item }) => item === itemName).reduce((total, { count }) => total + count, 0);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightValues = new Set(right);
  return left.every((value) => rightValues.has(value));
}

interface CompatibleStackGroup {
  readonly representative: ContainerStack;
  totalCount: number;
}

function groupCompatibleStacks(stacks: readonly ContainerStack[]): CompatibleStackGroup[] {
  const groups: CompatibleStackGroup[] = [];
  for (const stack of stacks) {
    const existing = groups.find(({ representative }) => sameItemKind(representative, stack));
    if (existing) existing.totalCount += stack.count;
    else groups.push({ representative: stack, totalCount: stack.count });
  }
  return groups;
}

function sameItemKind(left: ContainerStack, right: ContainerStack): boolean {
  return (
    left.type === right.type &&
    left.metadata === right.metadata &&
    JSON.stringify(left.nbt) === JSON.stringify(right.nbt)
  );
}

function stackAt(stacks: readonly ContainerStack[], slot: number, expected: PlannedContainerStack): boolean {
  const actual = stacks.find((stack) => stack.slot === slot);
  return actual !== undefined && sameItemKind(actual, expected.representative) && actual.count === expected.count;
}

function stackIdentity(stack: ContainerStack): string {
  return `${stack.type}\u0000${stack.metadata}\u0000${JSON.stringify(stack.nbt)}`;
}

function stackTotals(stacks: readonly ContainerStack[]): string {
  const totals = new Map<string, number>();
  for (const stack of stacks) {
    const identity = stackIdentity(stack);
    totals.set(identity, (totals.get(identity) ?? 0) + stack.count);
  }
  return JSON.stringify([...totals].sort(([left], [right]) => left.localeCompare(right)));
}

function stackLayout(stacks: readonly ContainerStack[]): string {
  return JSON.stringify(
    stacks
      .map((stack) => ({ slot: stack.slot, identity: stackIdentity(stack), count: stack.count }))
      .sort((left, right) => left.slot - right.slot),
  );
}

async function executeTransferBatch(
  bot: Bot,
  container: OpenedContainer,
  operation: "deposit" | "withdraw",
  items: readonly RequestedContainerItem[],
  itemTypes: ReadonlyMap<string, number>,
  before: readonly ContainerContent[],
  signal?: AbortSignal,
): Promise<TransferBatchExecution> {
  const executions: TransferExecution[] = [];
  for (const item of items) {
    if (signal?.aborted) break;
    const itemType = itemTypes.get(item.itemName)!;
    const available = operation === "deposit" ? bot.inventory.count(itemType, null) : itemCount(before, item.itemName);
    const attempted = Math.min(available, item.count);
    const attempt =
      attempted === 0 ? { kind: "not_attempted" as const } : await container.transfer(operation, itemType, attempted);
    executions.push({ ...item, available, attempt });
  }
  return {
    items: executions,
    compaction: operation === "withdraw" ? await container.compact(signal) : { kind: "not_attempted" },
  };
}

function settleTransfers(
  operation: "deposit" | "withdraw",
  executions: readonly TransferExecution[],
  before: readonly ContainerContent[],
  after: readonly ContainerContent[],
): ContainerTransferResult[] {
  return executions.map((execution) => {
    const beforeCount = itemCount(before, execution.itemName);
    const afterCount = itemCount(after, execution.itemName);
    const transferred = Math.max(0, operation === "deposit" ? afterCount - beforeCount : beforeCount - afterCount);
    const item = execution.itemName;
    const requested = execution.count;
    if (transferred === requested) return { status: "succeeded", item, requested, transferred };

    const error =
      execution.attempt.kind === "failed"
        ? useContainerOutcomes.transferFailed(operation, execution.attempt.cause)
        : execution.available < requested
          ? useContainerOutcomes.unavailable(operation, item, execution.available, requested)
          : useContainerOutcomes.transferIncomplete(operation, transferred, requested);
    return transferred > 0
      ? { status: "partial", item, requested, transferred, error }
      : { status: "failed", item, requested, transferred: 0, error };
  });
}

/** Open one exact container, execute one requested container transaction, and retain its observed slot layout. */
export async function useContainer(
  bot: Bot,
  data: SqlBotData,
  request: UseContainerRequest,
  context: ActionContext,
  dependencies: UseContainerDependencies,
): Promise<UseContainerResult> {
  context.signal?.throwIfAborted();
  const targetValue = target(bot, request);
  const inventoryCounts = () => {
    const counts: Record<string, number> = {};
    for (const item of bot.inventory.items()) counts[item.name] = (counts[item.name] ?? 0) + item.count;
    return counts;
  };
  const progressBefore = context.observeProgress ? inventoryCounts() : null;
  context.observeProgress?.(() => ({ baseline: { inventory: progressBefore },
    checkpoint: { phase: request.operation, inventory: inventoryCounts(), windowOpen: bot.currentWindow != null,
      requested: request.operation === "deposit" || request.operation === "withdraw" ? request.items.map((item) => ({ ...item })) : [] },
    completion: { kind: "event", observed: false, owes: "Container observation or requested transfer/layout operations confirmed before closing the window." },
  }));

  try {
    const itemTypes = resolveItemTypes(bot, request);

    // Pathfinder status is not enough: move until the container is observably within interaction reach.
    const position = asVec3(request);
    if (bot.entity.position.distanceTo(position) > CONTAINER_REACH) {
      const route = await dependencies
        .navigate({
          movements: dependencies.createMovements(bot),
          goal: nearGoal(position, 2),
          signal: context.signal,
        })
        .catch((cause: unknown) => {
          const reason = cause instanceof Error ? cause.message : String(cause);
          throw new UseContainerActionError(useContainerOutcomes.routeStopped(reason), { cause });
        });
      if (bot.entity.position.distanceTo(position) > CONTAINER_REACH) {
        throw new UseContainerActionError(useContainerOutcomes.routeStopped(describeNavigation(route)));
      }
    }

    const block = bot.blockAt(position);
    if (!block) return { status: "failed", error: useContainerOutcomes.blockUnloaded, target: targetValue };
    if (!isLocationOwnedContainer(block.name)) {
      forgetContainerObservation(data, targetValue);
      return {
        status: "failed",
        error: useContainerOutcomes.unsupportedBlock(block.name),
        target: targetValue,
      };
    }

    const obstruction = chestOpeningObstruction(bot, block.name, position);
    if (obstruction) return { status: "failed", error: obstruction, target: targetValue };
    using container = await OpenedContainer.open(bot, block);
    const observeAndRemember = () => {
      const contents = container.contents();
      const observedAt = dependencies.now().toISOString();
      recordContainerObservation(data, {
        dimension: bot.game.dimension,
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
        blockName: block.name,
        slotCount: container.slotCount,
        contents,
        observedByBotId: bot.username,
        observedAt,
      });
      return { blockName: block.name, slotCount: container.slotCount, contents, observedAt };
    };
    const before = observeAndRemember();
    context.signal?.throwIfAborted();

    if (request.operation === "inspect") {
      const inspectTarget = target(bot, request);
      return {
        status: "succeeded",
        container: { ...inspectTarget, ...before },
      };
    }

    if (request.operation === "deposit" || request.operation === "withdraw") {
      const transferTarget = target(bot, request);
      const execution = await executeTransferBatch(
        bot,
        container,
        request.operation,
        request.items,
        itemTypes,
        before.contents,
        context.signal,
      );
      const after = observeAndRemember();
      context.signal?.throwIfAborted();

      const transfers = settleTransfers(request.operation, execution.items, before.contents, after.contents);
      const containerEvidence: ContainerUseEvidence = {
        ...transferTarget,
        ...after,
        transfers,
      };
      if (transfers.every(({ status }) => status === "succeeded") && execution.compaction.kind !== "failed") {
        return { status: "succeeded", container: containerEvidence };
      }
      const error =
        execution.compaction.kind === "failed"
          ? useContainerOutcomes.compactionFailed(execution.compaction.cause)
          : useContainerOutcomes.batchIncomplete(transfers);
      return transfers.some(({ transferred }) => transferred > 0)
        ? { status: "partial", error, container: containerEvidence }
        : { status: "failed", error, target: transferTarget, container: containerEvidence };
    }

    if (request.operation !== "organize") throw new Error(`Unhandled container operation: ${request.operation}`);
    const organizeTarget = target(bot, request);
    const observedItemNames = container.observedItemNames();
    if (!sameStringSet(observedItemNames, request.itemOrder)) {
      return {
        status: "failed",
        error: useContainerOutcomes.itemOrderMismatch(observedItemNames, request.itemOrder),
        target: organizeTarget,
      };
    }

    const plan = container.planOrganization(request.itemOrder);
    const organization = await container.organize(plan, context.signal);
    const after = observeAndRemember();
    context.signal?.throwIfAborted();
    const containerEvidence: ContainerUseEvidence = {
      ...organizeTarget,
      ...after,
      plannedContents: [...plan.contents],
      matchedSlots: organization.matchedSlots,
      contentsPreserved: organization.contentsPreserved,
      playerInventoryPreserved: organization.playerInventoryPreserved,
      cursorEmpty: organization.cursorEmpty,
    };
    if (
      organization.execution.kind === "completed" &&
      organization.matchedSlots === plan.stacks.length &&
      after.contents.length === plan.stacks.length &&
      organization.contentsPreserved &&
      organization.playerInventoryPreserved &&
      organization.cursorEmpty
    ) {
      return { status: "succeeded", container: containerEvidence };
    }

    const error =
      organization.execution.kind === "failed"
        ? useContainerOutcomes.organizeFailed(organization.execution.cause)
        : useContainerOutcomes.organizeIncomplete(
            organization.matchedSlots,
            plan.stacks.length,
            organization.contentsPreserved,
            organization.playerInventoryPreserved,
            organization.cursorEmpty,
          );
    return organization.execution.movedStacks > 0
      ? { status: "partial", error, container: containerEvidence }
      : { status: "failed", error, target: organizeTarget, container: containerEvidence };
  } catch (cause) {
    context.signal?.throwIfAborted();
    if (cause instanceof UseContainerActionError) {
      return { status: "failed", error: cause.message, target: targetValue };
    }
    throw cause;
  }
}

export function formatUseContainerResult(result: UseContainerResult): string {
  switch (result.status) {
    case "succeeded":
      return formatContainerEvidence(result.container);
    case "partial":
      return formatContainerEvidence(result.container, result.error);
    case "failed":
      return result.container
        ? formatContainerEvidence(result.container, result.error)
        : `**Observed stop:** ${result.error}`;
  }
}

function formatContainerEvidence(container: ContainerUseEvidence, error?: string): string {
  const lines = [
    `Opened **${container.blockName}** at \`${container.x}, ${container.y}, ${container.z}\` in \`${container.dimension}\`.`,
    `- Operation: ${container.operation}`,
    `- Storage slots: ${container.slotCount}`,
  ];
  if (container.operation === "deposit" || container.operation === "withdraw") {
    lines.push(
      ...container.transfers.map(
        (transfer) =>
          `- ${transfer.item}: ${transfer.transferred}/${transfer.requested} (${transfer.status})` +
          ("error" in transfer ? ` — ${transfer.error}` : ""),
      ),
    );
  } else if (container.operation === "organize") {
    lines.push(
      `- Planned occupied slots matched: ${container.matchedSlots}/${container.plannedContents.length}`,
      `- Container contents preserved: ${container.contentsPreserved}`,
      `- Player inventory preserved: ${container.playerInventoryPreserved}`,
      `- Cursor empty: ${container.cursorEmpty}`,
    );
  }
  lines.push(
    `- Contents: ${container.contents.length === 0 ? "empty" : container.contents.map(({ slot, item, count }) => `[${slot}] ${item} x${count}`).join(", ")}`,
    `- Memorized at: ${container.observedAt}`,
    "- Queryable storage memory: `observed_container_slots` and `observed_container_items`",
  );
  if (error) lines.push("", `**Observed stop:** ${error}`);
  return lines.join("\n");
}

export function createUseContainerAction(
  bot: Bot,
  navigation: NavigationRuntime,
  data: SqlBotData,
  dependencies: UseContainerDependencies = productionDependencies(navigation.navigate),
) {
  return defineAction({
    checkpointSchema: containerCheckpointSchema,
    name: USE_CONTAINER,
    description: USE_CONTAINER_DESCRIPTION,
    inputSchema: useContainerInputSchema,
    resultSchema: useContainerResultSchema,
    formatResult: formatUseContainerResult,
    execution: {
      kind: "task",
      prepare: () => prepareBotForMovement(bot, navigation),
    },
    annotations: useContainerAnnotations,
    parse: parseUseContainerRequest,
    execute: (request, context) => useContainer(bot, data, request, context, dependencies),
  });
}
