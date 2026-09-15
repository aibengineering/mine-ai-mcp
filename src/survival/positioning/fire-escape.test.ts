import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { observeMineflayerBlock } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { botFixture } from "../../test-support/bot.js";
import { isInFire } from "../perception/body.js";
import { clearFireEscape, fireEscapeDeparture, nearbyFireEscape } from "./fire-escape.js";

test("a newly burning occupied cell has a dry escape through navigation's observed geometry", () => {
  const cells: Record<string, string> = { "0,64,0": "soul_fire", "1,64,0": "fire", "-1,64,0": "cactus" };
  const bot = botFixture({ blocks: cells, groundY: 63 });
  const world = new MemoryWorld();
  const refresh = () => {
    for (let x = -5; x <= 5; x++)
      for (let z = -5; z <= 5; z++)
        for (let y = 62; y <= 66; y++) {
          const at = new Vec3(x, y, z);
          world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
        }
  };
  refresh();
  assert.equal(isInFire(bot), true, "metadata need not report burning yet");
  const target = nearbyFireEscape(bot, world);
  assert.ok(target, "the occupied source does not make every exit path unreachable");
  assert.equal(clearFireEscape(bot, world, new Vec3(2.5, 64, 0.5)), false, "do not cross a second fire cell");
  assert.equal(clearFireEscape(bot, world, new Vec3(-2.5, 64, 0.5)), false, "reuse navigation's non-fire hazard facts");
  cells[`${Math.floor(target.x)},64,${Math.floor(target.z)}`] = "soul_fire";
  refresh();
  assert.equal(clearFireEscape(bot, world, target), false, "a destination igniting after selection invalidates it");
  bot.entity.position.set(0.75, 64, 2.5);
  assert.equal(isInFire(bot), false);
  assert.equal(
    nearbyFireEscape(bot, world),
    null,
    "dry ground is not an extinguishing destination for residual burning",
  );
});

test("fire contact includes shoulder overlap but excludes mere boundary contact", () => {
  const bot = botFixture({ blocks: { "1,65,0": "soul_fire" }, position: new Vec3(0.76, 64, 0.5) });
  assert.equal(isInFire(bot), true);
  bot.entity.position.x = 0.7;
  assert.equal(isInFire(bot), false);
});

test("a raised escape does not hide a new fire cell below its jump clearance", () => {
  const bot = botFixture({ blocks: { "0,64,0": "soul_fire", "1,64,0": "fire", "2,64,0": "stone" }, groundY: 63 });
  const world = new MemoryWorld();
  for (let x = -1; x <= 3; x++)
    for (let z = -1; z <= 1; z++)
      for (let y = 63; y <= 67; y++) {
        const at = new Vec3(x, y, z);
        world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
      }
  assert.equal(clearFireEscape(bot, world, new Vec3(2.5, 65, 0.5)), false);
});

test("a lava escape retains its departure while the body is airborne above the pool", () => {
  const cells: Record<string, string> = { "0,64,0": "lava", "1,64,0": "stone" };
  const bot = botFixture({ blocks: cells, groundY: 63 });
  Reflect.set(bot.entity, "isInLava", true);
  const world = new MemoryWorld();
  for (let x = -1; x <= 2; x++)
    for (let z = -1; z <= 1; z++)
      for (let y = 63; y <= 68; y++) {
        const at = new Vec3(x, y, z);
        world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
      }
  const departure = fireEscapeDeparture(bot);
  const target = new Vec3(1.5, 65, 0.5);
  assert.equal(clearFireEscape(bot, world, target, departure), true);
  bot.entity.position.set(0.7, 65.2, 0.5);
  bot.entity.onGround = false;
  Reflect.set(bot.entity, "isInLava", false);
  assert.equal(clearFireEscape(bot, world, target, departure), true, "the admitted bank remains reachable mid-jump");
  for (const hazard of ["fire", "lava"]) {
    cells["1,65,0"] = hazard;
    world.load(new Vec3(1, 65, 0), observeMineflayerBlock(bot.blockAt(new Vec3(1, 65, 0))!));
    assert.equal(clearFireEscape(bot, world, target, departure), false, `${hazard} invalidates the destination`);
  }
});
