/** Record client controls and native posture to diagnose movement during the hunt.
 * These observations do not add posture conditions to its goal. */
import type { ClientCompletion } from "mine-labs/client";

import { run as hunt } from "./hunter.ts";
import type { MineAiScenarioContext } from "./scenario-client.ts";

/** Entity flag bit the server sets while it believes the player is sneaking. */
const SNEAKING_FLAG = 0x02;
/** The pose the server reports for a crouched player; the bot's own pose is absent until it first changes. */
const CROUCHING_POSE = 5;

interface PostureRecord {
  ticks: number;
  /** Ticks the client's sneak control was held. */
  sneakTicks: number;
  /** Longest run of ticks with the sneak control held. */
  longestSneak: number;
  /** Ticks the server flagged the bot sneaking or posed it crouching. */
  crouchedTicks: number;
  /** Longest run of server-side crouch while the client held no sneak control. */
  longestUnownedCrouch: number;
  /** Horizontal blocks walked with the sneak control held. */
  sneakDistance: number;
  /** Sneak control changes seen, each logged with its caller. */
  writes: number;
}

function watchPosture(context: MineAiScenarioContext): { close(): PostureRecord } {
  const { bot } = context;
  const record: PostureRecord = {
    ticks: 0,
    sneakTicks: 0,
    longestSneak: 0,
    crouchedTicks: 0,
    longestUnownedCrouch: 0,
    sneakDistance: 0,
    writes: 0,
  };
  let sneakRun = 0;
  let unownedRun = 0;
  let previous = bot.entity.position.clone();
  let lastWriter = "none";
  /** One span per side, logged when it ends, so a stretch shorter than a sample still leaves a line. */
  const spans = { control: 0, server: 0 };
  const endSpan = (side: keyof typeof spans, held: boolean) => {
    if (held) spans[side]++;
    else if (spans[side] > 0) {
      context.log(`crouch-span ${JSON.stringify({ side, ticks: spans[side], endedAt: record.ticks, lastWriter })}`);
      spans[side] = 0;
    }
  };
  const observe = () => {
    record.ticks++;
    const sneaking = bot.getControlState("sneak");
    const flags = bot.entity.metadata?.[0];
    const pose = bot.entity.metadata?.[6] as unknown;
    const crouched = (typeof flags === "number" && (flags & SNEAKING_FLAG) !== 0) || pose === CROUCHING_POSE;
    endSpan("control", sneaking);
    endSpan("server", crouched);
    if (sneaking) {
      record.sneakTicks++;
      record.longestSneak = Math.max(record.longestSneak, ++sneakRun);
      record.sneakDistance += Math.hypot(bot.entity.position.x - previous.x, bot.entity.position.z - previous.z);
    } else sneakRun = 0;
    if (crouched) record.crouchedTicks++;
    if (crouched && !sneaking) record.longestUnownedCrouch = Math.max(record.longestUnownedCrouch, ++unownedRun);
    else unownedRun = 0;
    previous = bot.entity.position.clone();
    if (record.ticks % 20 === 0)
      context.log(
        `hunt-posture ${JSON.stringify({ ticks: record.ticks, sneak: sneaking, crouched, sneakRun, unownedRun, position: previous, entityFlags: flags, pose, usingItem: bot.usingHeldItem })}`,
      );
  };
  const setControl = bot.setControlState;
  bot.setControlState = (control, state) => {
    if (control === "sneak" && bot.getControlState(control) !== state) {
      record.writes++;
      const stack = new Error().stack ?? "";
      // The frame above this hook is the writer.
      lastWriter = `${state ? "held" : "released"} by ${stack.split("\n")[2]?.trim().replace(/^at /, "") ?? "unknown"}`;
      context.log(
        `sneak-writer ${JSON.stringify({ ticks: record.ticks, state, position: bot.entity.position, stack })}`,
      );
    }
    setControl.call(bot, control, state);
  };
  bot.on("physicsTick", observe);
  return {
    close: () => {
      endSpan("control", false);
      endSpan("server", false);
      bot.off("physicsTick", observe);
      bot.setControlState = setControl;
      return record;
    },
  };
}

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const posture = watchPosture(context);
  let result: ClientCompletion;
  let record: PostureRecord;
  try {
    result = await hunt(context);
  } finally {
    record = posture.close();
  }
  const detail = `${result.detail}; posture ${JSON.stringify(record)}`;
  context.log(`posture ${JSON.stringify(record)}`);
  return { ...result, detail };
}
