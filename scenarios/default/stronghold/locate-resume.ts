import assert from "node:assert/strict";
import path from "node:path";
import { writeFileSync } from "node:fs";
import type { BotEvents } from "mineflayer";
import type { ClientCompletion } from "mine-labs/client";
import {
  ActionRunner,
  SqlBotData,
  StrongholdEyeFlights,
  createLocateStrongholdAction,
} from "@aibengineering/mine-ai-mcp";
import type { MineAiScenarioContext } from "../../src/scenario-client.ts";

export async function run(context: MineAiScenarioContext): Promise<ClientCompletion> {
  const { bot, navigation, signal, log } = context;
  const root = process.env.MINE_LABS_ARTIFACTS_DIR;
  if (!root) throw new Error("Mine Labs did not supply its artifacts directory.");
  const options = {
    storage: { kind: "persistent" as const, root: path.join(root, "stronghold-data") },
    identity: { worldId: "stronghold-8674349", scope: { kind: "bot" as const, botId: bot.username } },
  };
  let data = SqlBotData.create(options);
  let flights = new StrongholdEyeFlights(bot);
  const runner = new ActionRunner();
  const countEyes = () =>
    bot.inventory
      .items()
      .filter((item) => item.name === "ender_eye")
      .reduce((sum, item) => sum + item.count, 0);
  const throws = () => data.read("SELECT * FROM stronghold_throws ORDER BY rowid");
  const snapshots: unknown[] = [];
  const droppedEyes = new Set<number>();
  const surfaceEyes = new Set<number>();
  const dropPositions: unknown[] = [];
  const recoveredEyes = new Set<number>();
  const observeDrop: BotEvents["itemDrop"] = (entity) => {
    if (entity.getDroppedItem()?.name !== "ender_eye" || droppedEyes.has(entity.id)) return;
    droppedEyes.add(entity.id);
    dropPositions.push({ id: entity.id, position: entity.position.clone() });
    // The survey floor is y=64. A local refinement can descend through it
    // before becoming an item; recovery of those buried drops is not assured.
    if (entity.position.y >= 64) surfaceEyes.add(entity.id);
  };
  const observePickup: BotEvents["playerCollect"] = (collector, entity) => {
    if (collector.id === bot.entity.id && droppedEyes.has(entity.id)) recoveredEyes.add(entity.id);
  };
  bot.on("itemDrop", observeDrop);
  bot.on("playerCollect", observePickup);
  try {
    await bot.waitForChunksToLoad();
    const before = countEyes();
    assert.equal(before, 16);
    for (const stage of ["airborne", "second-bearing"] as const) {
      const action = createLocateStrongholdAction(bot, navigation, data, flights);
      const stop = new AbortController();
      const cancel: BotEvents["entityMoved"] = (entity) => {
        if (entity.name !== "eye_of_ender") return;
        if (stage === "airborne" && entity.position.distanceTo(bot.entity.position) > 4)
          stop.abort("Scenario: cancel during first eye flight.");
      };
      const gone: BotEvents["entityGone"] = (entity) => {
        if (stage === "second-bearing" && entity.name === "eye_of_ender" && throws().length === 2)
          queueMicrotask(() => stop.abort("Scenario: cancel after second bearing."));
      };
      bot.on("entityMoved", cancel);
      bot.on("entityGone", gone);
      try {
        const output = await runner.run(action, { search_id: "resume" }, AbortSignal.any([signal, stop.signal]));
        assert.equal(output.result.status, "cancelled", JSON.stringify(output));
      } finally {
        bot.off("entityMoved", cancel);
        bot.off("entityGone", gone);
      }
      await flights.wait(signal);
      const rows = throws();
      assert.equal(rows.length, stage === "airborne" ? 1 : 2);
      assert.ok(rows.every((row) => row.state === "observed" && row.bearing_degrees !== null));
      snapshots.push({ stage, rows, eyes: countEyes() });
      log(`${stage}: ${rows.length} durable bearings; ${countEyes()} eyes remain.`);
      flights[Symbol.dispose]();
      data.close();
      data = SqlBotData.create(options);
      assert.deepEqual(throws(), rows, "Reopening SQLite must preserve every measured coordinate.");
      flights = new StrongholdEyeFlights(bot);
    }
    const saved = throws();
    const action = createLocateStrongholdAction(bot, navigation, data, flights);
    const estimated = await runner.run(action, { search_id: "resume" }, signal);
    assert.equal(estimated.result.status, "succeeded", JSON.stringify(estimated));
    assert.ok("phase" in estimated.result && estimated.result.phase === "estimate");
    assert.ok("confirmation" in estimated.result && estimated.result.confirmation === null);
    assert.deepEqual(throws(), saved, "Estimate reuses the two saved bearings.");
    const departure = bot.entity.position.clone();
    const blocked = await runner.run(action, { search_id: "resume", phase: "locate" }, signal);
    assert.ok(
      "error" in blocked.result && blocked.result.error.includes("STRONGHOLD_MISSING_SUPPLIES"),
      JSON.stringify(blocked),
    );
    assert.ok(bot.entity.position.distanceTo(departure) < 1, "Supply warning must not start the journey.");
    assert.deepEqual(throws(), saved);
    snapshots.push({ stage: "estimated-and-blocked", estimated, blocked });
    const output = await runner.run(
      action,
      { search_id: "resume", phase: "locate", continue_without_recommended_items: true },
      signal,
    );
    log(JSON.stringify(output));
    assert.equal(output.result.status, "succeeded", JSON.stringify(output));
    assert.deepEqual(throws().slice(0, 2), saved, "Departure preserves the initial measurements.");
    assert.equal(throws().length, 3, "One local refinement throw follows the initial pair.");
    // Native randomness may shatter an eye. Require reachable drop coverage
    // and inventory evidence, including recovery after cancellation.
    const remainingEyes = countEyes();
    assert.ok(surfaceEyes.size > 0, "No native surface eye survived; rerun to exercise pickup.");
    for (const id of surfaceEyes) assert.ok(recoveredEyes.has(id), `Surface eye #${id} must reach this bot.`);
    assert.equal(remainingEyes, before - 3 + recoveredEyes.size, "Inventory must prove recovered stock.");
    assert.ok("confirmation" in output.result && output.result.confirmation);
    const confirmation = output.result.confirmation;
    assert.equal(confirmation.position.y, -22);
    assert.ok(confirmation.position.x >= 269 && confirmation.position.x <= 273);
    assert.ok(confirmation.position.z >= -1598 && confirmation.position.z <= -1594);
    const events = data.read("SELECT * FROM events WHERE event_type = 'stronghold_located'");
    assert.equal(events.length, 1);
    assert.deepEqual(JSON.parse(String(events[0]!.payload_json)).confirmation, confirmation);
    snapshots.push({ stage: "confirmed", output, events, eyes: countEyes() });
    return {
      status: "succeeded",
      detail: `Cancelled twice and reopened SQLite twice; reused both native bearings and made one local refinement; frame at ${JSON.stringify(confirmation.position)}; ${countEyes()} eyes remain.`,
    };
  } finally {
    bot.off("itemDrop", observeDrop);
    bot.off("playerCollect", observePickup);
    writeFileSync(
      path.join(root, "stronghold-evidence.json"),
      JSON.stringify({ snapshots, throws: throws(), dropPositions, surfaceEyes: [...surfaceEyes], droppedEyes: [...droppedEyes], recoveredEyes: [...recoveredEyes] }, null, 2),
    );
    flights[Symbol.dispose]();
    data.close();
  }
}
