import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { physicsEveryMillisecond } from "../../../test-support/physics.js";
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
  {
    // Physics stops here: the cancellation below must settle without another tick.
    using _physics = physicsEveryMillisecond(bot, () => ticks++);
    assert.equal(await retreatFromCreepers(bot, new AbortController().signal, () => false,
      { clearance, tick: () => ticks, dead: new Set() }), "expired");
    assert.equal(clearance.pending, true);
    assert.equal(controls.get("forward"), false);
    assert.equal(controls.get("sprint"), false);
  }
  const abort = new AbortController();
  const retreat = retreatFromCreepers(bot, abort.signal, () => false);
  await Promise.resolve();
  abort.abort(new Error("stop without another physics tick"));
  await assert.rejects(retreat, /stop without another physics tick/);
  assert.equal(controls.get("forward"), false);
});

test("a retreat releases sprint even when enabling forward movement fails", async () => {
  const controls = new Map<string, boolean>();
  const bot = botFixture({}, {
    setControlState: (control: string, state: boolean) => {
      if (control === "forward" && state) throw new Error("forward rejected");
      controls.set(control, state);
    },
  });

  await assert.rejects(retreatFromCreepers(bot, new AbortController().signal, () => false), /forward rejected/);

  // Both controls end released; the order is only DisposableStack's unwinding.
  assert.equal(controls.get("forward"), false);
  assert.equal(controls.get("sprint"), false);
});
