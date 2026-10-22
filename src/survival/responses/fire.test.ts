import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { observeMineflayerBlock } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { botFixture, registry } from "../../test-support/bot.js";
import { isInLava } from "../perception/body.js";
import { nearbyFireEscape } from "../positioning/fire-escape.js";
import { escapeFire } from "./fire.js";

test("lava contact includes the shallow body overlap missed by the swimming flag", () => {
  let level: number | string = 0;
  const bot = {
    entity: { position: new Vec3(0.761841334797, 63.875, 0.5), width: 0.6, height: 1.8, isInLava: false },
    blockAt: (at: Vec3) =>
      at.floored().equals(new Vec3(1, 63, 0)) ? { name: "lava", getProperties: () => ({ level }) } : { name: "air" },
  } as unknown as Bot;
  assert.equal(isInLava(bot), true);
  bot.entity.position.x = 0.69;
  assert.equal(isInLava(bot), false, "beside lava without body overlap is safe");
  bot.entity.position.x = 0.76;
  bot.entity.position.y = 63.95;
  assert.equal(isInLava(bot), false, "above the source surface is safe");
  bot.entity.position.y = 63.875;
  level = 7;
  assert.equal(isInLava(bot), false, "a low flowing layer does not fill the whole cell");
  level = "7";
  assert.equal(isInLava(bot), false, "Prismarine string levels retain the same shallow surface");
  level = "8";
  assert.equal(isInLava(bot), true, "a falling stream fills back up to source height");
});

test("a burning body landing on the lip of its chosen bank walks onto the bank before releasing", async () => {
  // lava-escapes, 2026-10-21: PocketBot climbed out of its one-cell pocket
  // onto the east bank, which has water a step beyond, and landed at x 0.78,
  // its body still 0.28 over the lava cell. Released there, it found no way
  // to the water: from the lip the pocket lies under the straight way to it.
  // From the bank's centre it does not, and the burn ends a step later.
  const flags = registry.entitiesByName.player!.metadataKeys!.indexOf("shared_flags");
  const controls: Record<string, boolean> = {};
  const bot = botFixture(
    { blocks: { "0,64,0": "lava", "2,64,0": "water" }, groundY: 64 },
    {
      stopDigging() {},
      deactivateItem() {},
      clearControlStates() {
        for (const control of Object.keys(controls)) controls[control] = false;
      },
      setControlState(control: string, state: boolean) {
        controls[control] = state;
      },
    },
  );
  const metadata: unknown[] = [];
  metadata[flags] = 1;
  Object.assign(bot.entity, { metadata, isInLava: true, onGround: false });
  const world = new MemoryWorld();
  for (let x = -3; x <= 4; x++)
    for (let z = -3; z <= 3; z++)
      for (let y = 63; y <= 67; y++) {
        const at = new Vec3(x, y, z);
        world.load(at, observeMineflayerBlock(bot.blockAt(at)!));
      }
  let outcome: string | null = null;
  const escape = escapeFire(bot, world, new AbortController().signal).then((result) => (outcome = result));
  const tick = async (x: number, y: number, state: { inLava?: boolean; onGround: boolean }) => {
    bot.entity.position.set(x, y, 0.5);
    Object.assign(bot.entity, { isInLava: state.inLava ?? false, onGround: state.onGround });
    bot.emit("physicsTick");
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  await tick(0.74, 65.09, { onGround: false });
  await tick(0.78, 65, { onGround: true });
  assert.equal(outcome, null, "the lip is not the bank");
  assert.equal(controls.right, true, "still walking east onto the bank");
  await tick(1.5, 65, { onGround: true });
  await escape;
  assert.equal(outcome, "escaped");
  assert.deepEqual(nearbyFireEscape(bot, world), new Vec3(2.5, 64, 0.5), "the water is a step from the bank");
});
