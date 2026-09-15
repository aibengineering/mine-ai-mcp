import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CombatItemUse } from "./item-use.js";

test("drawing a bow releases server shield use even after local posture was invalidated", async () => {
  let serverHand: "shield" | "bow" | null = null;
  let arrows = 0;
  const bot = {
    quickBarSlot: 0,
    activateItem: (offHand = false) => {
      // Native use requests cannot switch hands while another hand is active.
      serverHand ??= offHand ? "shield" : "bow";
    },
    deactivateItem: () => {
      if (serverHand === "bow") arrows++;
      serverHand = null;
    },
    setQuickBarSlot: () => {
      serverHand = null;
    },
  } as unknown as Bot;
  const use = new CombatItemUse(bot, async () => {});
  await use.raiseShield();
  use.invalidateShield(); // Refused construction did not release the native use.
  using draw = use.drawBow();
  draw.release();
  assert.equal(arrows, 1, "release must fire a bow, not merely lower the still-active shield");
  assert.equal(serverHand, null);
});

test("cleanup settles the body after the final item-release tick can deliver knockback", async () => {
  let grounded = true;
  let settledAirborne = false;
  const order: string[] = [];
  const bot = Object.assign(new EventEmitter(), {
    deactivateItem: () => order.push("release use"),
    clearControlStates: () => order.push("clear movement"),
  }) as unknown as Bot;
  const cleanup = new CombatItemUse(bot, async () => {}).neutralise(async () => {
    settledAirborne = !grounded;
    grounded = true;
    order.push("land");
  }, new AbortController().signal);
  grounded = false;
  order.push("knockback arrives");
  bot.emit("physicsTick");
  await cleanup;
  assert.equal(settledAirborne, true, "the health cancellation precedes the velocity packet");
  assert.equal(grounded, true, "no awaited cleanup remains after the physical handoff");
  assert.ok(order.indexOf("land") > order.indexOf("knockback arrives"));
  assert.ok(order.lastIndexOf("clear movement") > order.indexOf("land"));
});

test("body cancellation settles item release even when physics has stopped", async () => {
  const bot = Object.assign(new EventEmitter(), {
    deactivateItem: () => {},
    clearControlStates: () => {},
  }) as unknown as Bot;
  const owner = new AbortController();
  let settled = false;
  const cleanup = new CombatItemUse(bot, async () => {}).neutralise(async () => {
    settled = true;
  }, owner.signal);
  owner.abort(new Error("body released"));
  await cleanup;
  assert.equal(settled, true);
  assert.equal(bot.listenerCount("physicsTick"), 0);
});
