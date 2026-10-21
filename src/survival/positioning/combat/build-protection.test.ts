import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import { Vec3 } from "vec3";
import { botFixture } from "../../../test-support/bot.js";
import { buildProtection } from "./build-protection.js";

type Block = NonNullable<ReturnType<Bot["blockAt"]>>;

test("a shelter wall punches out twisting vines in its cell before placing", async () => {
  // warped-forest-pearls in confirm-slow 2026-10-21T20-55-34-976Z (t00008):
  // EnderExpedition stood at 106.5, 52, -3.5 on the warped canopy and its
  // shelter's wall cell (106, 52, -5) held twisting_vines. Vanilla does not
  // place a block into a vine's cell, but the vine has no collision and
  // breaks at the first touch, as fire does.
  const bot = botFixture({ items: [{ name: "cobblestone", count: 32 }] });
  bot.entity.position.set(106.5, 52, -3.5);
  bot.world.raycast = () => null;
  const cell = new Vec3(106, 52, -5);
  let vine = true;
  const punched: string[] = [];
  bot.blockAt = ((at: Vec3) => {
    if (at.equals(cell))
      return (vine
        ? { name: "twisting_vines", hardness: 0, boundingBox: "empty", position: cell, shapes: [] }
        : { name: "air", hardness: 0, boundingBox: "empty", position: cell, shapes: [] }) as unknown as Block;
    if (at.equals(cell.offset(0, -1, 0)))
      return { name: "warped_nylium", hardness: 0.4, boundingBox: "block", position: at,
        shapes: [[0, 0, 0, 1, 1, 1]] } as unknown as Block;
    return null;
  }) as Bot["blockAt"];
  bot.canDigBlock = () => true;
  bot.lookAt = async () => undefined;
  bot.dig = (async (block: Block) => {
    punched.push(block.name);
    vine = false;
  }) as Bot["dig"];
  bot.equip = async () => {
    throw new Error("placement reached");
  };
  const built = await buildProtection(bot, [cell], {
    signal: new AbortController().signal,
    mayContinue: () => null,
    terrain: { dig: true, place: true },
  });
  assert.deepEqual(punched, ["twisting_vines"]);
  assert.equal(built.kind, "blocked");
  assert.match(built.kind === "blocked" ? built.reason : "", /placement reached/);
});

test("with digging prohibited the vine cell is refused, not placed into", async () => {
  const bot = botFixture({ items: [{ name: "cobblestone", count: 32 }] });
  bot.entity.position.set(106.5, 52, -3.5);
  bot.world.raycast = () => null;
  const cell = new Vec3(106, 52, -5);
  bot.blockAt = ((at: Vec3) =>
    at.equals(cell)
      ? ({ name: "twisting_vines", hardness: 0, boundingBox: "empty", position: cell, shapes: [] } as unknown as Block)
      : at.equals(cell.offset(0, -1, 0))
        ? ({ name: "warped_nylium", hardness: 0.4, boundingBox: "block", position: at, shapes: [[0, 0, 0, 1, 1, 1]] } as unknown as Block)
        : null) as Bot["blockAt"];
  bot.dig = (async () => assert.fail("digging is prohibited")) as Bot["dig"];
  const built = await buildProtection(bot, [cell], {
    signal: new AbortController().signal,
    mayContinue: () => null,
    terrain: { dig: false, place: true },
  });
  assert.equal(built.kind, "blocked");
  assert.match(built.kind === "blocked" ? built.reason : "", /twisting_vines, which could not be punched out/);
});
