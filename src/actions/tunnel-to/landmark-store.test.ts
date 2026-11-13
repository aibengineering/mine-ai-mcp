import assert from "node:assert/strict";
import test from "node:test";
import { persistentBotData } from "../../test-support/bot-data.js";
import { StrongholdLandmarks } from "./landmark-store.js";

test("records a landmark per kind and survives reopen, isolating search, bot, dimension and world", (t) => {
  const storage = persistentBotData(t);
  const data = storage.open("one");
  const store = new StrongholdLandmarks(data, "Digger", "overworld", "trip");
  store.set("mouth", { x: -312, y: 68, z: -1720 });
  store.set("portal_exit", { x: -270, y: -36, z: -1815 });
  data.close();

  const reopened = storage.open("one");
  const back = new StrongholdLandmarks(reopened, "Digger", "overworld", "trip");
  assert.deepEqual(back.get("mouth")?.position, { x: -312, y: 68, z: -1720 });
  assert.deepEqual(back.get("portal_exit")?.position, { x: -270, y: -36, z: -1815 });
  assert.equal(back.read().length, 2);

  for (const args of [
    ["Other", "overworld", "trip"],
    ["Digger", "the_nether", "trip"],
    ["Digger", "overworld", "another"],
  ] as const)
    assert.equal(new StrongholdLandmarks(reopened, args[0], args[1], args[2]).read().length, 0, `${args.join("/")} sees no landmarks`);
  assert.equal(storage.open("two").read("SELECT * FROM stronghold_landmarks").length, 0);
});

test("re-digging overwrites the landmark of a kind rather than accumulating rows", (t) => {
  const storage = persistentBotData(t);
  const store = new StrongholdLandmarks(storage.open("one"), "Digger", "overworld", "trip");
  store.set("mouth", { x: 1, y: 70, z: 1 });
  store.set("mouth", { x: 2, y: 69, z: 2 });
  assert.equal(store.read().length, 1);
  assert.deepEqual(store.get("mouth")?.position, { x: 2, y: 69, z: 2 });
});
