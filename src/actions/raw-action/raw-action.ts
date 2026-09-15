import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { waitForPhysicsTicks } from "../../utils/physics-ticks.js";
import { defineAction, type ActionContext } from "../action.js";
import { executionCheckpointSchema } from "../checkpoint-schemas.js";
import {
  RAW_ACTION,
  RAW_ACTION_DESCRIPTION,
  parseRawActionRequest,
  rawActionAnnotations,
  rawActionInputSchema,
  rawActionResultSchema,
  type RawActionRequest,
  type RawActionResult,
} from "./contract.js";

// Minecraft 1.21.4's survival interaction attributes. Measure to the nearest
// point on the target's collision-sized volume, as the server does.
const BLOCK_REACH = 4.5;
const ENTITY_REACH = 3;
// Native placement owns listeners until its five-second server receipt timeout.
// Cancellation waits through that bound before returning foreground ownership.
const OPERATION_DRAIN_MS = 6_000;
const FACES = {
  up: new Vec3(0, 1, 0),
  down: new Vec3(0, -1, 0),
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  east: new Vec3(1, 0, 0),
  west: new Vec3(-1, 0, 0),
} as const;
interface Evidence {
  target: Vec3 | null;
  beforeBlock: string | null;
  entityId: number | null;
  attempted: boolean;
  effectObserved: boolean | null;
}

function vector(v: { x: number; y: number; z: number }) {
  return { x: v.x, y: v.y, z: v.z };
}
function inventory(bot: Bot) {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory.items())
    counts[item.name] = (counts[item.name] ?? 0) + item.count;
  return counts;
}
function observation(bot: Bot) {
  return {
    position: vector(bot.entity.position),
    yaw: bot.entity.yaw,
    pitch: bot.entity.pitch,
    inventory: inventory(bot),
  };
}
function eyes(bot: Bot) {
  const observedEyeHeight = Reflect.get(bot.entity, "eyeHeight");
  return bot.entity.position.offset(
    0,
    typeof observedEyeHeight === "number"
      ? observedEyeHeight
      : bot.entity.height,
    0,
  );
}
function blockWithinReach(bot: Bot, cell: Vec3) {
  const eye = eyes(bot);
  const nearest = new Vec3(
    Math.max(cell.x, Math.min(cell.x + 1, eye.x)),
    Math.max(cell.y, Math.min(cell.y + 1, eye.y)),
    Math.max(cell.z, Math.min(cell.z + 1, eye.z)),
  );
  return eye.distanceTo(nearest) <= BLOCK_REACH;
}

function entityWithinReach(bot: Bot, entity: Bot["entity"]) {
  const eye = eyes(bot);
  const halfWidth = entity.width / 2;
  const nearest = new Vec3(
    Math.max(entity.position.x - halfWidth, Math.min(entity.position.x + halfWidth, eye.x)),
    Math.max(entity.position.y, Math.min(entity.position.y + entity.height, eye.y)),
    Math.max(entity.position.z - halfWidth, Math.min(entity.position.z + halfWidth, eye.z)),
  );
  return eye.distanceTo(nearest) <= ENTITY_REACH;
}

async function ownedOperation(
  start: () => Promise<unknown>,
  signal: AbortSignal | undefined,
  stop: () => void,
) {
  signal?.throwIfAborted();
  if (!signal) return start();
  let abort!: () => void;
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  let stopped = false;
  const stopOnce = () => {
    if (stopped) return;
    stopped = true;
    stop();
  };
  let operation: Promise<unknown> | undefined;
  try {
    operation = start();
    if (signal.aborted) {
      stopOnce();
      void cancelled.catch(() => undefined);
      await operation.catch(() => undefined);
      throw signal.reason;
    }
    return await Promise.race([operation, cancelled]);
  } catch (cause) {
    if (!signal.aborted) throw cause;
    stopOnce();
    if (operation) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          operation.catch(() => undefined),
          new Promise<void>((resolve) => { timer = setTimeout(resolve, OPERATION_DRAIN_MS); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    }
    throw signal.reason;
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

async function look(
  bot: Bot,
  request: Extract<RawActionRequest, { operation: "look" }>,
  evidence: Evidence,
) {
  evidence.attempted = true;
  if (request.target) {
    evidence.target = new Vec3(
      request.target.x,
      request.target.y,
      request.target.z,
    );
    await bot.lookAt(evidence.target, true);
    const delta = evidence.target.minus(eyes(bot));
    const expectedYaw = Math.atan2(-delta.x, -delta.z);
    const expectedPitch = Math.atan2(delta.y, Math.hypot(delta.x, delta.z));
    evidence.effectObserved =
      Math.abs(bot.entity.yaw - expectedYaw) < 0.001 &&
      Math.abs(bot.entity.pitch - expectedPitch) < 0.001;
  } else {
    await bot.look(request.yaw!, request.pitch!, true);
    evidence.effectObserved =
      bot.entity.yaw === request.yaw && bot.entity.pitch === request.pitch;
  }
}

async function dig(
  bot: Bot,
  request: Extract<RawActionRequest, { operation: "dig" }>,
  context: ActionContext,
  evidence: Evidence,
) {
  evidence.target = new Vec3(
    request.target.x,
    request.target.y,
    request.target.z,
  );
  const block = bot.blockAt(evidence.target);
  evidence.beforeBlock = block?.name ?? null;
  if (Reflect.get(bot.entity, "isInLava") === true)
    throw new Error(
      "[RAW_DIG_IN_LAVA] Raw digging is refused while the body is in lava.",
    );
  if (!block)
    throw new Error("[RAW_TARGET_UNLOADED] The requested block is not loaded.");
  if (!blockWithinReach(bot, evidence.target))
    throw new Error(
      `[RAW_OUT_OF_REACH] Target is beyond the ${BLOCK_REACH}-block interaction reach.`,
    );
  evidence.attempted = true;
  await ownedOperation(
    () => bot.dig(block, true),
    context.signal,
    () => bot.stopDigging(),
  );
  const after = bot.blockAt(evidence.target);
  evidence.effectObserved =
    after !== null && after.name !== evidence.beforeBlock;
  if (!evidence.effectObserved)
    throw new Error(
      "[RAW_DIG_NOT_OBSERVED] Mineflayer completed the attempt but the target block did not change.",
    );
}

async function place(
  bot: Bot,
  request: Extract<RawActionRequest, { operation: "place" }>,
  context: ActionContext,
  evidence: Evidence,
) {
  const support = new Vec3(
    request.support.x,
    request.support.y,
    request.support.z,
  );
  const face = FACES[request.face];
  const supportBlock = bot.blockAt(support);
  evidence.target = support.plus(face);
  evidence.beforeBlock = bot.blockAt(evidence.target)?.name ?? null;
  if (!blockWithinReach(bot, support))
    throw new Error(
      `[RAW_OUT_OF_REACH] Support is beyond the ${BLOCK_REACH}-block interaction reach.`,
    );
  if (!supportBlock)
    throw new Error(
      "[RAW_TARGET_UNLOADED] The requested support block is not loaded.",
    );
  const item = bot.inventory
    .items()
    .find((candidate) => candidate.name === request.blockName);
  if (!item)
    throw new Error(`[RAW_ITEM_MISSING] Bot carries no ${request.blockName}.`);
  await ownedOperation(
    () => bot.equip(item, "hand"),
    context.signal,
    () => undefined,
  );
  context.signal?.throwIfAborted();
  evidence.attempted = true;
  await ownedOperation(
    () => bot.placeBlock(supportBlock, face),
    context.signal,
    () => undefined,
  );
  evidence.effectObserved =
    bot.blockAt(evidence.target)?.name === request.blockName;
  if (!evidence.effectObserved)
    throw new Error(
      "[RAW_PLACE_NOT_OBSERVED] Mineflayer completed the attempt but the requested block was not observed at the target.",
    );
}

function swing(
  bot: Bot,
  request: Extract<RawActionRequest, { operation: "swing" }>,
  evidence: Evidence,
) {
  evidence.entityId = request.entityId;
  if (request.entityId === null) {
    evidence.attempted = true;
    bot.swingArm("right");
    return;
  }
  const entity = bot.entities[request.entityId];
  if (!entity)
    throw new Error(
      `[RAW_ENTITY_MISSING] Entity ${request.entityId} is not loaded.`,
    );
  if (!entityWithinReach(bot, entity))
    throw new Error(
      `[RAW_OUT_OF_REACH] Entity ${request.entityId} is beyond the ${ENTITY_REACH}-block interaction reach.`,
    );
  evidence.attempted = true;
  bot.attack(entity);
  evidence.effectObserved = null;
}

async function useItem(
  bot: Bot,
  request: Extract<RawActionRequest, { operation: "use_item" }>,
  context: ActionContext,
  evidence: Evidence,
) {
  const beforeHeld = bot.heldItem?.name ?? null;
  const beforeInventory = inventory(bot);
  evidence.attempted = true;
  bot.activateItem(request.hand === "off-hand");
  try {
    await waitForPhysicsTicks(
      bot,
      1,
      context.signal ?? new AbortController().signal,
    );
  } finally {
    if (bot.usingHeldItem) bot.deactivateItem();
  }
  evidence.effectObserved =
    beforeHeld !== (bot.heldItem?.name ?? null) ||
    JSON.stringify(beforeInventory) !== JSON.stringify(inventory(bot));
}

async function control(
  bot: Bot,
  request: Extract<RawActionRequest, { operation: "control" }>,
  context: ActionContext,
  evidence: Evidence,
) {
  evidence.attempted = true;
  bot.setControlState(request.state, true);
  try {
    await waitForPhysicsTicks(
      bot,
      request.ticks,
      context.signal ?? new AbortController().signal,
    );
  } finally {
    bot.setControlState(request.state, false);
  }
}

function makeResult(
  bot: Bot,
  request: RawActionRequest,
  before: ReturnType<typeof observation>,
  evidence: Evidence,
  failure?: string,
): RawActionResult {
  return {
    status: failure ? "failed" : "succeeded",
    ...(failure ? { error: failure } : {}),
    operation: request.operation,
    before,
    after: observation(bot),
    target: evidence.target ? vector(evidence.target) : null,
    beforeBlock: evidence.beforeBlock,
    afterBlock: evidence.target
      ? (bot.blockAt(evidence.target)?.name ?? null)
      : null,
    entityId: evidence.entityId,
    entityPresentAfter:
      evidence.entityId === null
        ? null
        : Boolean(bot.entities[evidence.entityId]),
    attempted: evidence.attempted,
    effectObserved: evidence.effectObserved,
  } as RawActionResult;
}

export async function executeRawAction(
  bot: Bot,
  request: RawActionRequest,
  context: ActionContext,
): Promise<RawActionResult> {
  context.signal?.throwIfAborted();
  const before = observation(bot);
  const evidence: Evidence = {
    target: null,
    beforeBlock: null,
    entityId: null,
    attempted: false,
    effectObserved: null,
  };
  context.observeProgress?.(() => ({
    baseline: before,
    checkpoint: { phase: "executing" },
    completion: {
      kind: "event",
      observed: false,
      owes: "The raw executor must return its observed after-state.",
    },
  }));
  try {
    switch (request.operation) {
      case "look":
        await look(bot, request, evidence);
        break;
      case "dig":
        await dig(bot, request, context, evidence);
        break;
      case "place":
        await place(bot, request, context, evidence);
        break;
      case "swing":
        swing(bot, request, evidence);
        break;
      case "use_item":
        await useItem(bot, request, context, evidence);
        break;
      case "control":
        await control(bot, request, context, evidence);
        break;
    }
    context.signal?.throwIfAborted();
    return makeResult(bot, request, before, evidence);
  } catch (cause) {
    context.signal?.throwIfAborted();
    const message = cause instanceof Error ? cause.message : String(cause);
    return makeResult(
      bot,
      request,
      before,
      evidence,
      message.startsWith("[RAW_") ? message : `[RAW_ACTION_FAILED] ${message}`,
    );
  }
}

export function formatRawActionResult(value: RawActionResult): string {
  const moved = Math.hypot(
    value.after.position.x - value.before.position.x,
    value.after.position.y - value.before.position.y,
    value.after.position.z - value.before.position.z,
  );
  const effect =
    value.effectObserved === null
      ? "not directly measurable"
      : value.effectObserved
        ? "yes"
        : "no";
  const lines = [
    `Raw **${value.operation}** ${value.status}.`,
    `- Native attempt made: ${value.attempted ? "yes" : "no"}; effect observed: ${effect}`,
    `- Position delta: ${moved.toFixed(3)} blocks`,
    `- Heading: yaw ${value.before.yaw.toFixed(3)} → ${value.after.yaw.toFixed(3)}, pitch ${value.before.pitch.toFixed(3)} → ${value.after.pitch.toFixed(3)}`,
  ];
  if (value.target)
    lines.push(
      `- Target: \`${value.target.x}, ${value.target.y}, ${value.target.z}\`; block ${value.beforeBlock ?? "unloaded"} → ${value.afterBlock ?? "unloaded"}`,
    );
  if (value.entityId !== null)
    lines.push(
      `- Entity ${value.entityId} present after: ${value.entityPresentAfter ? "yes" : "no"}`,
    );
  const names = new Set([
    ...Object.keys(value.before.inventory),
    ...Object.keys(value.after.inventory),
  ]);
  const changes = [...names]
    .filter(
      (name) => value.before.inventory[name] !== value.after.inventory[name],
    )
    .map(
      (name) =>
        `${name} ${value.before.inventory[name] ?? 0} → ${value.after.inventory[name] ?? 0}`,
    );
  lines.push(
    `- Inventory changes: ${changes.length ? changes.join(", ") : "none observed"}`,
  );
  if (value.status !== "succeeded")
    lines.push("", `**Observed stop:** ${value.error}`);
  return lines.join("\n");
}

export function createRawAction(bot: Bot) {
  return defineAction({
    checkpointSchema: executionCheckpointSchema,
    name: RAW_ACTION,
    description: RAW_ACTION_DESCRIPTION,
    inputSchema: rawActionInputSchema,
    resultSchema: rawActionResultSchema,
    formatResult: formatRawActionResult,
    execution: { kind: "task" },
    annotations: rawActionAnnotations,
    parse: parseRawActionRequest,
    execute: (request, context) => executeRawAction(bot, request, context),
  });
}
