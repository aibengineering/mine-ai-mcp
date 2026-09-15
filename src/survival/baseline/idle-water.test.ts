import assert from "node:assert/strict";
import test from "node:test";
import { waterFixture } from "../../test-support/water.js";
import { attachIdleWaterControl } from "./idle-water.js";

test("asserts jump while idle in water and releases it once dry", async (t) => {
  const fixture = waterFixture(t);
  const control = attachIdleWaterControl(fixture.bot, { active: false }, fixture.reflex.runner);

  fixture.entity.isInWater = true;
  fixture.bot.emit("physicsTick");
  fixture.bot.emit("physicsTick");
  fixture.entity.isInWater = false;
  fixture.bot.emit("physicsTick");

  assert.deepEqual(
    fixture.controls.filter(([control]) => control === "jump"),
    [
      ["jump", true],
      ["jump", true],
      ["jump", false],
    ],
  );

  await control[Symbol.dispose]();
  assert.equal(
    fixture.bot.listenerCount("physicsTick"),
    0,
    "The baseline did not register an unrelated breathing reflex.",
  );
});

test("an idle body resists current after a cancelled interaction and yields to the next owner", async (t) => {
  const fixture = waterFixture(t);
  const control = attachIdleWaterControl(
    fixture.bot,
    {
      get active() {
        return fixture.isMoving();
      },
    },
    fixture.reflex.runner,
  );
  fixture.entity.isInWater = true;
  fixture.bot.emit("physicsTick");
  fixture.entity.position.x += 0.3;
  fixture.bot.emit("physicsTick");
  assert.ok(fixture.controls.some(([key, active]) => key === "left" && active));
  fixture.setMoving(true);
  const before = fixture.controls.length;
  fixture.bot.emit("physicsTick");
  assert.equal(fixture.controls.length, before, "idle holding must not overwrite the new route's controls");
  await control[Symbol.dispose]();
});

test("relinquishes jump without writing false when Pathfinder starts moving", async (t) => {
  const fixture = waterFixture(t);
  const control = attachIdleWaterControl(
    fixture.bot,
    {
      get active() {
        return fixture.isMoving();
      },
    },
    fixture.reflex.runner,
  );

  fixture.entity.isInWater = true;
  fixture.bot.emit("physicsTick");
  fixture.setMoving(true);
  fixture.bot.emit("physicsTick");
  await control[Symbol.dispose]();

  assert.deepEqual(
    fixture.controls.filter(([control]) => control === "jump"),
    [["jump", true]],
  );
});

test("observes the current Mineflayer entity rather than retaining a stale one", async (t) => {
  const fixture = waterFixture(t);
  const control = attachIdleWaterControl(fixture.bot, { active: false }, fixture.reflex.runner);

  Object.assign(fixture.bot, { entity: { ...fixture.entity, isInWater: true } });
  fixture.bot.emit("physicsTick");
  await control[Symbol.dispose]();

  assert.deepEqual(
    fixture.controls.filter(([control]) => control === "jump"),
    [
      ["jump", true],
      ["jump", false],
    ],
  );
});

test("close releases jump when the attachment still owns it", async (t) => {
  const fixture = waterFixture(t);
  const control = attachIdleWaterControl(fixture.bot, { active: false }, fixture.reflex.runner);

  fixture.entity.isInWater = true;
  fixture.bot.emit("physicsTick");
  await control[Symbol.dispose]();
  await control[Symbol.dispose]();

  assert.deepEqual(
    fixture.controls.filter(([control]) => control === "jump"),
    [
      ["jump", true],
      ["jump", false],
    ],
  );
  assert.equal(
    fixture.bot.listenerCount("physicsTick"),
    0,
    "The baseline did not register an unrelated breathing reflex.",
  );
});
