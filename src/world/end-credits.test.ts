import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { botFixture } from "../test-support/bot.js";
import { acknowledgeEndCredits } from "./end-credits.js";

for (const legacy of [false, true]) {
  test(`first-credit value zero sends one normal ${legacy ? "legacy" : "modern"} respawn acknowledgement`, () => {
    const writes: unknown[] = [];
    const client = Object.assign(new EventEmitter(), { write: (...args: unknown[]) => writes.push(args) });
    const bot = botFixture({}, { _client: client, supportFeature: () => legacy });
    acknowledgeEndCredits(bot);
    acknowledgeEndCredits(bot);
    // Native vanilla 1.21.4 exit: the player stays alive in the End until this
    // packet is acknowledged. bot.respawn() would early-return while alive.
    client.emit("game_state_change", { reason: 4, gameMode: 0 });
    assert.deepEqual(writes, [["client_command", legacy ? { payload: 0 } : { actionId: 0 }]]);
    for (const packet of [{ reason: 4, gameMode: 1 }, { reason: 3, gameMode: 0 }, { reason: 4, gameMode: 2 }])
      client.emit("game_state_change", packet);
    assert.equal(writes.length, 1, "Mineflayer already handles value one; ignore unrelated events");
    bot.emit("end", "fixture stopped");
    client.emit("game_state_change", { reason: 4, gameMode: 0 });
    assert.equal(writes.length, 1, "detach when the connection ends");
  });
}
