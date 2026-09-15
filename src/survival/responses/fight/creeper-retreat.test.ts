import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { retreatFromCreepers } from "./creeper-retreat.js";
import { CreeperClearance } from "../../perception/combat/creepers.js";

test("an escape with no physical progress expires without claiming clearance", async () => {
  const bot = botFixture();
  bot.entity.position.set(0, 64, 0);
  bot.entities[7] = { id: 7, name: "creeper", width: 0.6, height: 1.7, isValid: true, position: new Vec3(3, 64, 0) } as typeof bot.entity;
  bot.blockAt = (position => ({ name: position.y < 64 ? "stone" : "air", boundingBox: position.y < 64 ? "block" : "empty" })) as typeof bot.blockAt;
  const controls = new Map<string, boolean>();
  bot.setControlState = (control, value) => { controls.set(control, value); };
  bot.lookAt = async () => {};
  let ticks = 0;
  const clearance = new CreeperClearance(bot);
  const timer = setInterval(() => { ticks++; bot.emit("physicsTick"); }, 1);
  try {
    assert.equal(await retreatFromCreepers(bot, new AbortController().signal, () => false,
      { clearance, tick: () => ticks, dead: new Set() }), "expired");
    assert.equal(clearance.pending, true);
    assert.equal(controls.get("forward"), false);
    assert.equal(controls.get("sprint"), false);
  } finally { clearInterval(timer); }
  const abort = new AbortController();
  const retreat = retreatFromCreepers(bot, abort.signal, () => false);
  await Promise.resolve();
  abort.abort(new Error("stop without another physics tick"));
  await assert.rejects(retreat, /stop without another physics tick/);
  assert.equal(controls.get("forward"), false);
});
