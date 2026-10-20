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

/**
 * The playthrough observation behind creeper-retreat-interception: escaping a
 * fuse froze crowd awareness, so a mob that stepped into the escape line after
 * the heading was committed was run straight into. Here a held husk appears
 * 2.5 blocks down the committed line on the third tick of a retreat from a
 * creeper three blocks east.
 */
test("a hostile stepping into the committed escape line turns the retreat around it, never toward the fuse", async () => {
  const bot = botFixture();
  bot.entity.position.set(0, 64, 0);
  const creeper = new Vec3(3, 64, 0);
  bot.entities[7] = { id: 7, name: "creeper", kind: "Hostile mobs", width: 0.6, height: 1.7, isValid: true, position: creeper } as typeof bot.entity;
  bot.blockAt = (position => ({ name: position.y < 64 ? "stone" : "air", boundingBox: position.y < 64 ? "block" : "empty" })) as typeof bot.blockAt;
  let ticks = 0;
  const headings: { tick: number; heading: Vec3 }[] = [];
  bot.lookAt = async (point) => {
    headings.push({ tick: ticks, heading: point.minus(bot.entity.position.offset(0, bot.entity.height, 0)).scaled(1 / 4) });
  };
  let husk: Vec3 | null = null;
  {
    using _physics = physicsEveryMillisecond(bot, () => {
      ticks++;
      if (ticks !== 3) return;
      const committed = headings.at(-1)!.heading;
      husk = bot.entity.position.plus(committed.scaled(2.5));
      bot.entities[8] = { id: 8, name: "husk", kind: "Hostile mobs", width: 0.6, height: 1.95, isValid: true, position: husk } as typeof bot.entity;
    });
    assert.equal(await retreatFromCreepers(bot, new AbortController().signal, () => ticks >= 20), "interrupted");
  }

  const before = headings.filter(({ tick }) => tick < 3);
  const after = headings.filter(({ tick }) => tick >= 3);
  assert.ok(before.length > 0 && after.length > 0);
  // Committed straight away from the fuse, which is the line the husk entered.
  assert.ok(before.every(({ heading }) => heading.x < -0.99));
  const away = bot.entity.position.minus(creeper);
  for (const { heading } of after) {
    const toward = husk!.minus(bot.entity.position);
    const along = Math.min(Math.max(toward.dot(heading), 0), 2.5);
    const miss = toward.minus(heading.scaled(along)).norm();
    assert.ok(miss >= 1.2, `heading ${heading} passes ${miss.toFixed(2)} from the husk`);
    assert.ok(heading.dot(away) >= -1e-9, `heading ${heading} turns toward the fuse`);
  }
});
