import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import minecraftData from "minecraft-data";
import { Vec3 } from "vec3";
import type { NavigationRuntime } from "../../navigation/index.js";
import { ActionRunner } from "../../session/action-runner.js";
import { botFixture } from "../../test-support/bot.js";
import { beginBarter, createBarterAction } from "./barter.js";
import { barterInputSchema, barterResultSchema } from "./contract.js";

function fixture(t: TestContext) {
  const lifetime = new AbortController();
  t.after(() => lifetime.abort());
  const registry = minecraftData("1.21.4");
  const gold = { name: "gold_ingot", count: 3, type: registry.itemsByName.gold_ingot!.id };
  const pearl = { name: "ender_pearl", count: 0, stackSize: 16, type: registry.itemsByName.ender_pearl!.id };
  const metadata: unknown[] = [];
  // Default adult spawn packets omit the false baby flag.
  const target = {
    id: 7,
    name: "piglin",
    isValid: true,
    position: new Vec3(1.5, 64, 0.5),
    metadata,
    equipment: [null, null] as ({ name: string } | null)[],
  };
  const entities: Record<number, unknown> = { 7: target };
  let offers = 0;
  const bot = botFixture({ entities }, {
    heldItem: gold,
    version: "1.21.4",
    activateEntity: async () => {
      offers += 1;
      gold.count -= 1;
      bot.inventory.emit("updateSlot", 0, null, gold);
      target.equipment[1] = { name: "gold_ingot" };
      events.emit("entityEquip", target);
    },
  });
  // A stack spent to nothing leaves the inventory, and a test sets how many
  // slots are free on its own.
  Object.assign(bot.inventory, {
    emptySlotCount: () => 1,
    items: () => [gold, pearl].filter((item) => item.count > 0),
  });
  /** The server's side of the connection, which sends untyped entities. */
  const events = bot as unknown as { emit(event: string, ...args: unknown[]): boolean };
  const navigation = {
    navigate: async () => {
      pearl.count += 2;
      delete entities[8];
      bot.inventory.emit("updateSlot", 1, null, pearl);
      return { status: "completed", elapsedMs: 0 };
    },
  } as unknown as NavigationRuntime;
  const spawn = () => {
    entities[8] = {
      id: 8,
      name: "item",
      isValid: true,
      position: new Vec3(2, 64, 0),
      getDroppedItem: () => ({ name: "ender_pearl", count: 2 }),
    };
    events.emit("itemDrop", entities[8]);
  };
  const complete = () => {
    spawn();
    target.equipment[1] = null;
    events.emit("entityEquip", target);
  };
  return { lifetime, events, bot, navigation, gold, pearl, target, entities, spawn, complete, offers: () => offers };
}
const request = (gold_budget = 1) =>
  barterInputSchema.parse({ piglin_id: 7, item_name: "ender_pearl", count: 2, gold_budget });
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
/** An acknowledgement window short enough that a test can let it lapse for real. */
const acknowledgementMs = 50;

test("existing desired drops satisfy a zero-gold request without activating a recipient", async (t) => {
  const f = fixture(t);
  f.spawn();
  delete f.entities[7];
  const result = await beginBarter(f.bot, f.navigation, request(0), f.lifetime.signal)({});
  assert.equal(result.status, "succeeded");
  assert.equal(f.offers(), 0);
  assert.equal(result.barter.goldSpent, 0);
  assert.equal(result.barter.gained, 2);
  barterResultSchema.parse(result);
});

test("a consumed offer survives cancellation and resumption without spending twice", async (t) => {
  const f = fixture(t);
  const run = beginBarter(f.bot, f.navigation, request(), f.lifetime.signal);
  const cancel = new AbortController();
  const pending = run({ signal: cancel.signal });
  await turn();
  assert.equal(f.offers(), 1);
  cancel.abort("reflex takeover");
  const interrupted = await pending;
  assert.equal(interrupted.barter.goldSpent, 1);
  assert.equal(interrupted.barter.goldOffers, 1);
  const resumed = run({});
  await turn();
  f.complete();
  const result = await resumed;
  assert.equal(result.status, "succeeded");
  assert.equal(f.offers(), 1);
  assert.equal(f.bot.listenerCount("entityEquip"), 0);
  assert.equal(f.bot.listenerCount("entityGone"), 0);
});

test("a gone recipient settles an accepted exchange without inventing completion", async (t) => {
  const f = fixture(t);
  const pending = beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  await turn();
  f.target.isValid = false;
  delete f.entities[7];
  f.events.emit("entityGone", f.target as never);
  const result = await pending;
  assert.equal(result.status, "partial");
  assert.equal(result.barter.goldSpent, 1);
  assert.equal(f.offers(), 1);
});

test("invalid and baby recipients cannot consume a gold offer", async (t) => {
  for (const invalid of ["gone", "baby", "unknown"] as const) {
    const f = fixture(t);
    if (invalid === "gone") delete f.entities[7];
    else
      f.target.metadata[f.bot.registry.entitiesByName.piglin!.metadataKeys!.indexOf("baby")] =
        invalid === "baby" ? true : "unsupported";
    const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
    assert.equal(result.status, "failed", `${invalid} recipient`);
    assert.equal(f.offers(), 0, `${invalid} recipient`);
  }
});
function runnerAction(f: ReturnType<typeof fixture>) {
  return {
    ...createBarterAction(f.bot, f.navigation, { acknowledgementMs }),
    execution: { kind: "resumable_task" as const },
  };
}

// Whatever the reflex changes while it holds the body, the resumed barter
// reads the world rather than its own memory: pearls arriving then satisfy the
// request, and gold that left then (the piglin took it late) is the offer
// already made, not a second one.
test("runner takeover preserves a pending offer and reconciles what the reflex saw", async (t) => {
  const rows = [
    { label: "desired gain during the reflex", pickedUpDuringReflex: false },
    { label: "gold and desired gain during the reflex", pickedUpDuringReflex: true },
  ];
  for (const row of rows) {
    const f = fixture(t);
    if (row.pickedUpDuringReflex) f.bot.activateEntity = async () => {};
    const runner = new ActionRunner();
    const pending = runner.run(runnerAction(f), request());
    await turn();
    assert.equal(f.offers(), row.pickedUpDuringReflex ? 0 : 1, row.label);
    const claim = runner.claim("hostile_reflex", "move away", async () => {
      if (row.pickedUpDuringReflex) f.gold.count -= 1;
      f.pearl.count = 2;
      return { value: null, continuation: { kind: "resume" as const } };
    });
    assert.equal(claim.kind, "claimed", row.label);
    const output = await pending;
    assert.equal(output.result.status, "succeeded", row.label);
    if (!("barter" in output.result)) throw new Error("expected barter evidence");
    assert.equal(output.result.barter.inventoryBefore, 0, row.label);
    assert.equal(output.result.barter.goldOffers, 1, row.label);
    assert.equal(output.result.barter.goldSpent, 1, row.label);
    assert.equal(f.offers(), row.pickedUpDuringReflex ? 0 : 1, `${row.label}: no second offer`);
    assert.equal(f.bot.listenerCount("entityEquip"), 0, row.label);
    assert.equal(f.bot.inventory.listenerCount("updateSlot"), 0, row.label);
  }
});

for (const stop of ["cancel", "disconnect"] as const) {
  test(`runner ${stop} settles a pending exchange and removes attempt listeners`, async (t) => {
    const f = fixture(t);
    const runner = new ActionRunner();
    const pending = runner.run(runnerAction(f), request());
    await turn();
    if (stop === "cancel") runner.cancelActive("operator cancelled");
    else runner.disconnect("connection ended");
    const output = await pending;
    await turn();
    assert.notEqual(output.result.status, "succeeded");
    assert.equal(f.offers(), 1);
    assert.equal(f.bot.listenerCount("entityEquip"), 0);
    assert.equal(f.bot.listenerCount("entityGone"), 0);
    assert.equal(f.bot.inventory.listenerCount("updateSlot"), 0);
  });
}

test("a nonreward output settles immediately and cannot exceed the one-gold budget", async (t) => {
  const f = fixture(t);
  const pending = beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  await turn();
  f.entities[9] = {
    id: 9,
    name: "item",
    isValid: true,
    position: new Vec3(2, 64, 0),
    getDroppedItem: () => ({ name: "gravel", count: 8 }),
  };
  f.events.emit("itemDrop", f.entities[9]);
  f.target.equipment[1] = null;
  f.events.emit("entityEquip", f.target);
  const result = await pending;
  assert.equal(result.status, "partial");
  assert.equal(result.barter.gained, 0);
  assert.equal(result.barter.goldOffers, 1);
  assert.equal(result.barter.goldSpent, 1);
  assert.match(result.error!, /budget exhausted/);
});

test("a recipient moving out of reach while equipping receives no reserved offer", async (t) => {
  const f = fixture(t);
  f.bot.equip = async () => {
    f.target.position.x = 20;
  };
  const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  assert.equal(result.status, "failed");
  assert.equal(result.barter.goldOffers, 0);
  assert.equal(f.offers(), 0);
});

test("gold hand release without a new output does not make another offer or report success", async (t) => {
  const f = fixture(t);
  // With no output to see, the offer's acknowledgement window lapses.
  const pending = beginBarter(f.bot, f.navigation, request(2), f.lifetime.signal, { acknowledgementMs })({});
  await turn();
  f.target.equipment[1] = null;
  f.events.emit("entityEquip", f.target);
  const result = await pending;
  assert.equal(result.status, "partial");
  assert.equal(result.barter.goldOffers, 1);
  assert.equal(result.barter.gained, 0);
  assert.match(result.error!, /no new nearby item output/);
});

test("full inventory without a partial requested stack stops before offering any gold", async (t) => {
  for (const carriedPearls of [0, 16]) {
    const f = fixture(t);
    f.pearl.count = carriedPearls;
    f.bot.inventory.emptySlotCount = () => 0;
    const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
    const carrying = `carrying ${carriedPearls} pearls`;
    assert.equal(result.status, "failed", carrying);
    assert.equal(result.barter.goldOffers, 0, carrying);
    assert.equal(result.barter.goldSpent, 0, carrying);
    assert.equal(f.offers(), 0, carrying);
    assert.match(result.error!, /no free slot or compatible partial stack for ender_pearl/, carrying);
  }
});

test("a partial requested stack permits barter even without an empty slot", async (t) => {
  const f = fixture(t);
  f.pearl.count = 14;
  f.bot.inventory.emptySlotCount = () => 0;
  const pending = beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  await turn();
  assert.equal(f.offers(), 1);
  f.complete();
  const result = await pending;
  assert.equal(result.status, "succeeded");
  assert.equal(result.barter.inventoryBefore, 14);
  assert.equal(result.barter.inventoryAfter, 16);
  assert.equal(result.barter.goldSpent, 1);
});

test("capacity is checked again after equipping before the gold offer", async (t) => {
  const f = fixture(t);
  f.bot.equip = async () => {
    f.bot.inventory.emptySlotCount = () => 0;
  };
  const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  assert.equal(result.status, "failed");
  assert.equal(f.offers(), 0);
  assert.equal(result.barter.goldOffers, 0);
  assert.match(result.error!, /no free slot/);
});

test("consuming the last carried ingot frees the slot needed for its reward", async (t) => {
  const f = fixture(t);
  f.gold.count = 1;
  f.bot.inventory.emptySlotCount = () => (f.gold.count === 0 ? 1 : 0);
  const pending = beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
  await turn();
  assert.equal(f.offers(), 1);
  assert.equal(f.gold.count, 0);
  f.complete();
  const result = await pending;
  assert.equal(result.status, "succeeded");
  assert.equal(result.barter.goldSpent, 1);
  assert.equal(result.barter.gained, 2);
});

test("a partial pickup revisits the remaining desired stack before another gold offer", async (t) => {
  const f = fixture(t);
  f.spawn();
  let pickups = 0;
  const navigate: NavigationRuntime["navigate"] = async () => {
    pickups++;
    f.pearl.count++;
    if (pickups === 2) delete f.entities[8];
    f.bot.inventory.emit("updateSlot", 1, null, null);
    return { status: "completed", elapsedMs: 0 } as never;
  };
  f.bot.activateEntity = async () => {
    throw new Error("Gold offered while pearls remain on the ground");
  };
  const result = await beginBarter(f.bot, { ...f.navigation, navigate }, request(), f.lifetime.signal)({});
  assert.equal(result.status, "succeeded");
  assert.equal(pickups, 2);
  assert.equal(result.barter.goldOffers, 0);
});

// Pearls that appear while the bot equips gold, on the ground or already
// picked up, are counted before any gold is reserved.
test("desired items seen while equipping satisfy the request before reserving gold", async (t) => {
  const rows = [
    { label: "a desired drop on the ground", arrive: (f: ReturnType<typeof fixture>) => f.spawn() },
    {
      label: "desired items already in the inventory",
      arrive: (f: ReturnType<typeof fixture>) => {
        f.pearl.count = 2;
        f.bot.inventory.emit("updateSlot", 1, null, null);
      },
    },
  ];
  for (const row of rows) {
    const f = fixture(t);
    f.bot.equip = async () => row.arrive(f);
    f.bot.activateEntity = async () => {
      throw new Error(`Gold offered after ${row.label} became observable`);
    };
    const result = await beginBarter(f.bot, f.navigation, request(), f.lifetime.signal)({});
    assert.equal(result.status, "succeeded", row.label);
    assert.equal(result.barter.goldOffers, 0, row.label);
    assert.equal(result.barter.goldSpent, 0, row.label);
    assert.equal(result.barter.gained, 2, row.label);
  }
});

test("an uncollectable remainder stops barter without another gold offer", async (t) => {
  const f = fixture(t);
  f.spawn();
  let pickups = 0;
  const navigate: NavigationRuntime["navigate"] = async () => {
    pickups++;
    if (pickups === 1) {
      f.pearl.count++;
      f.bot.inventory.emit("updateSlot", 1, null, null);
    }
    return { status: "completed", elapsedMs: 0 } as never;
  };
  f.bot.activateEntity = async () => {
    throw new Error("Gold offered while an uncollectable remainder exists");
  };
  const result = await beginBarter(f.bot, { ...f.navigation, navigate }, request(), f.lifetime.signal)({});
  assert.equal(result.status, "partial");
  assert.equal(pickups, 2);
  assert.equal(result.barter.goldOffers, 0);
  assert.equal(result.barter.gained, 1);
  assert.ok("error" in result);
  assert.match(result.error, /Could not collect observed ender_pearl #8/);
});

test("an incidental reward observed entirely during takeover allows the next reserved offer", async (t) => {
  const f = fixture(t);
  const runner = new ActionRunner();
  const activate = f.bot.activateEntity;
  let offered = 0;
  f.bot.activateEntity = async (target) => {
    offered++;
    await activate(target);
    if (offered === 2) {
      f.pearl.count = 2;
      f.complete();
    }
  };
  const pending = runner.run(runnerAction(f), request(2));
  await turn();
  const claim = runner.claim("fixture_reflex", "Wait through incidental output", async () => {
    f.entities[9] = {
      id: 9,
      name: "item",
      isValid: true,
      position: new Vec3(2, 64, 0),
      getDroppedItem: () => ({ name: "blackstone", count: 9 }),
    };
    f.events.emit("itemDrop", f.entities[9]);
    f.target.equipment[1] = null;
    f.events.emit("entityEquip", f.target);
    delete f.entities[9];
    return { value: null, continuation: { kind: "resume" as const } };
  });
  assert.equal(claim.kind, "claimed");
  const result = await pending;
  assert.equal(offered, 2);
  assert.equal(result.result.status, "succeeded");
  assert.equal(f.bot.listenerCount("itemDrop"), 0);
  assert.equal(f.bot.inventory.listenerCount("updateSlot"), 0);
});
