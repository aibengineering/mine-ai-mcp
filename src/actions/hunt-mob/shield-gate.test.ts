import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../../navigation/index.js";
import { MemoryWorld } from "../../navigation/world/memory-world.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import {
  dependencies,
  died,
  fakeCombat,
  fakeNavigation,
  huntBot,
  huntRequest,
  mob,
} from "../../test-support/hunt-mob.js";
import { huntMob, huntMobDependencies } from "./hunt-mob.js";

// The shield gate. The refusal's whole value is that it lands before the bot
// walks up to the thing, so the first test counts pursuits as well as reading
// the verdict; a stop reported after the approach would be a later, lesser fact.

/** A shield loose in the inventory, which is what the loadout equips from. */
function carryingShield(bot: Bot): Bot {
  const shield = { name: "shield" } as unknown as ReturnType<Bot["inventory"]["items"]>[number];
  bot.inventory.items = () => [shield];
  return bot;
}

/**
 * One admission rule, by loadout, policy, override and quarry. A hoglin is
 * hostile only by the registry category its `type` contradicts, so it is
 * refused on the same terms as a skeleton. Every refusal is counted against
 * the pursuit as well as read from the verdict.
 */
test("the shield gate admits or refuses a hunt before the pursuit takes a step", async () => {
  const rows: ReadonlyArray<{
    readonly mobName: string;
    readonly hostile: boolean;
    readonly shield: "none" | "permitted" | "forbidden";
    readonly override?: boolean;
    /** Null when admitted; otherwise what the refusal must name to be acted on. */
    readonly names: RegExp | null;
  }> = [
    { mobName: "skeleton", hostile: true, shield: "none", names: /allow_without_shield: true/ },
    { mobName: "hoglin", hostile: true, shield: "none", names: /allow_without_shield: true/ },
    { mobName: "skeleton", hostile: true, shield: "forbidden", names: /set_survival_policy/ },
    { mobName: "skeleton", hostile: true, shield: "permitted", names: null },
    { mobName: "skeleton", hostile: true, shield: "none", override: true, names: null },
    { mobName: "chicken", hostile: false, shield: "none", names: null },
  ];
  for (const row of rows) {
    const label = `${row.mobName}, shield ${row.shield}${row.override ? ", override" : ""}`;
    const inventory = { count: 0 };
    const registry = minecraftData("1.21.4");
    const quarry = mob(7, registry.entitiesByName[row.mobName]!.id, row.mobName, 3, row.hostile ? "Hostile mobs" : undefined);
    const bot = huntBot([quarry], inventory);
    if (row.shield !== "none") carryingShield(bot);
    let pursued = 0;
    const effects = dependencies(bot, inventory, [died(2, 3)]);
    const result = await huntMob(bot, huntRequest(row.mobName, row.override), {}, {
      ...effects,
      shieldPermitted: () => row.shield !== "forbidden",
      pursue: async (pursuit) => {
        pursued += 1;
        return effects.pursue(pursuit);
      },
    });

    if (row.names === null) {
      assert.equal(result.status, "succeeded", label);
      assert.equal(result.hunt.gained, 1, label);
      continue;
    }
    assert.equal(result.status, "failed", label);
    assert.equal(result.termination, "shield_required", label);
    assert.match(result.error, /HUNT_NO_SHIELD/, label);
    assert.match(result.error, row.names, `${label}: the refusal names what overrides it`);
    assert.equal(pursued, 0, `${label}: the refusal precedes the approach`);
    assert.equal(result.hunt.targetsEngaged, 0, label);
  }
});

// A shield lost during the hunt re-enters the same gate on the next leg,
// whether the next enemy was already loaded or wanders in afterwards; the
// already-loaded case is the one that must also stop before the approach.
for (const loss of ["broken", "forbidden"] as const) {
  test(`a ${loss} shield stops the real pursuit before approaching the next loaded enemy`, async () => {
    const inventory = { count: 0 };
    const type = minecraftData("1.21.4").entitiesByName.skeleton.id;
    const bot = carryingShield(huntBot([
      mob(7, type, "skeleton", 3, "Hostile mobs"),
      mob(8, type, "skeleton", 20, "Hostile mobs"),
    ], inventory));
    const combat = { ...fakeCombat, policy: new SurvivalPolicyState(bot) };
    let approached = 0;
    let permitted = true;
    const navigation = {
      ...fakeNavigation,
      navigate: async () => {
        approached++;
        throw new Error("The unshielded hunt must stop before approaching the second enemy");
      },
    } as NavigationRuntime;
    const result = await huntMob(bot, { ...huntRequest("skeleton"), count: 2 }, {}, {
      ...dependencies(bot, inventory, [died(2, 3)]),
      pursue: huntMobDependencies(bot, navigation, combat).pursue,
      shieldPermitted: () => permitted,
      collectDropAfterDeath: async () => {
        inventory.count++;
        if (loss === "broken") bot.inventory.items = () => [];
        else permitted = false;
        return { kind: "collected" };
      },
    });

    assert.equal(approached, 0);
    assert.equal(result.termination, "shield_required");
    assert.equal(result.status, "partial");
    assert.match(result.error ?? "", /HUNT_NO_SHIELD/);
    assert.equal(result.hunt.gained, 1);
    assert.equal(result.hunt.targetDeathsObserved, 1);
    assert.equal(result.hunt.targetsEngaged, 1);
  });
}

test("the real pursuit does not select a cube that has gone down to a lava shore", async () => {
  // The 2026-10-20 basalt hunt: a cube bounced off the shelf at y 47 and the
  // pursuit followed it to the lava shore at y 33, where a pack's knockback
  // put the bot in the lava (hunts-basalt 2026-10-20T20-32-02-466Z-t00008).
  const inventory = { count: 0 };
  const type = minecraftData("1.21.4").entitiesByName.magma_cube.id;
  const cube = mob(7, type, "magma_cube", 6, "Hostile mobs");
  cube.position.y = 50;
  const bot = carryingShield(huntBot([cube], inventory));
  const world = new MemoryWorld();
  world.load({ x: 7, y: 49, z: 0 }, { stateId: 102, collisionShapes: [], traits: { liquid: "lava", empty: true } });
  let approached = 0;
  const navigation = {
    ...fakeNavigation,
    world,
    navigate: async () => {
      approached++;
      throw new Error("The hunt must not walk after a cube at a lava shore below");
    },
  } as NavigationRuntime;
  let engaged = 0;
  const combat = {
    ...fakeCombat,
    policy: new SurvivalPolicyState(bot),
    engage: async (...args: Parameters<typeof fakeCombat.engage>) => {
      engaged++;
      return fakeCombat.engage(...args);
    },
  };
  const result = await huntMob(bot, huntRequest("magma_cube"), {}, {
    ...dependencies(bot, inventory, []),
    pursue: huntMobDependencies(bot, navigation, combat).pursue,
  });
  assert.equal(approached, 0);
  assert.equal(engaged, 0);
  assert.equal(result.hunt.targetsEngaged, 0);
});

test("a shield lost while gathering drops at contact is checked again before engaging", async () => {
  const inventory = { count: 0 };
  const type = minecraftData("1.21.4").entitiesByName.skeleton.id;
  const bot = carryingShield(huntBot([mob(7, type, "skeleton", 3, "Hostile mobs")], inventory));
  let pickups = 0;
  const result = await huntMob(bot, huntRequest("skeleton"), {}, {
    ...dependencies(bot, inventory, []),
    gatherLoadedDrops: async () => {
      if (++pickups === 2) bot.inventory.items = () => [];
      return 0;
    },
  });
  assert.equal(result.termination, "shield_required");
  assert.equal(result.hunt.targetsEngaged, 0);
});

test("a hunt whose shield broke still picks up the drops already lying loaded", async () => {
  // Recorded in hunt/skeleton-hunts (hunts-skel2 t00001): the field's arrows
  // broke BoneGatherer's shield during the reflex's fights, whose kills left
  // bones lying loaded at (7.3, -60, -35.8), (54, -60, -8.9) and (20.2, -60,
  // -11). The hunt resumed at (-10.4, -60, -46.4) and refused for want of a
  // shield before picking any up. Walking to a dropped bone approaches no
  // skeleton, so the gate guarding approaches must not stand before it.
  const inventory = { count: 0 };
  const type = minecraftData("1.21.4").entitiesByName.skeleton.id;
  const bot = huntBot([mob(16, type, "skeleton", 44, "Hostile mobs")], inventory);
  let pursued = 0;
  const effects = dependencies(bot, inventory, []);
  const result = await huntMob(bot, { ...huntRequest("skeleton"), count: 3 }, {}, {
    ...effects,
    gatherLoadedDrops: async () => {
      inventory.count += 3;
      return 3;
    },
    pursue: async (pursuit) => {
      pursued++;
      return effects.pursue(pursuit);
    },
  });
  assert.equal(result.status, "succeeded", result.status === "succeeded" ? "" : result.error);
  assert.equal(result.hunt.gained, 3);
  assert.equal(pursued, 0, "no skeleton was approached");
});
