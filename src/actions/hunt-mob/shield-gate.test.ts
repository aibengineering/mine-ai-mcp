import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";
import assert from "node:assert/strict";
import test from "node:test";
import type { NavigationRuntime } from "../../navigation/index.js";
import { SurvivalPolicyState } from "../../survival/state/survival-policy.js";
import {
  dependencies,
  died,
  fakeCombat,
  fakeNavigation,
  huntBot,
  huntRequest,
  mob,
  pursueLoaded,
} from "../../test-support/hunt-mob.js";
import { parseHuntMobRequest } from "./contract.js";
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

/** A skeleton by `kind`, a hoglin only by the registry category its `type` contradicts. */
for (const mobName of ["skeleton", "hoglin"])
  test(`a shieldless ${mobName} hunt is refused before the pursuit takes a step`, async () => {
    const inventory = { count: 0 };
    const registry = minecraftData("1.21.4");
    const bot = huntBot([mob(7, registry.entitiesByName[mobName]!.id, mobName, 3, "Hostile mobs")], inventory);
    let pursued = 0;
    const result = await huntMob(bot, huntRequest(mobName), {}, {
      ...dependencies(bot, inventory, []),
      pursue: async (pursuit) => {
        pursued += 1;
        return pursueLoaded(bot)(pursuit);
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.termination, "shield_required");
    assert.match(result.error, /HUNT_NO_SHIELD/);
    assert.match(result.error, /allow_without_shield: true/, "the refusal names the parameter that overrides it");
    assert.equal(pursued, 0, "the refusal precedes the approach");
    assert.equal(result.hunt.targetsEngaged, 0);
  });

test("a carried shield the policy forbids is refused on the same terms as no shield at all", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = carryingShield(huntBot([mob(7, registry.entitiesByName.skeleton.id, "skeleton", 3, "Hostile mobs")], inventory));
  const result = await huntMob(bot, huntRequest("skeleton"), {}, {
    ...dependencies(bot, inventory, []),
    shieldPermitted: () => false,
  });

  assert.equal(result.status, "failed");
  assert.equal(result.termination, "shield_required");
  assert.match(result.error, /HUNT_NO_SHIELD/);
  assert.match(result.error, /set_survival_policy/, "a forbidden shield names the policy that forbade it");
});

test("a carried, permitted shield admits the hostile hunt without the override", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = carryingShield(huntBot([mob(7, registry.entitiesByName.skeleton.id, "skeleton", 3, "Hostile mobs")], inventory));
  const result = await huntMob(bot, huntRequest("skeleton"), {}, dependencies(bot, inventory, [died(2, 3)]));

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
});

test("allow_without_shield admits the hunt a missing shield would have refused", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot([mob(7, registry.entitiesByName.skeleton.id, "skeleton", 3, "Hostile mobs")], inventory);
  const result = await huntMob(bot, huntRequest("skeleton", true), {}, dependencies(bot, inventory, [died(2, 3)]));

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
});

test("passive quarry is never asked for a shield", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const bot = huntBot([mob(7, registry.entitiesByName.chicken.id, "chicken", 3)], inventory);
  const result = await huntMob(bot, huntRequest("chicken"), {}, dependencies(bot, inventory, [died(2, 3)]));

  assert.equal(result.status, "succeeded");
  assert.equal(result.hunt.gained, 1);
});

test("a shield lost mid-hunt refuses the next leg rather than the drop already collected", async () => {
  const inventory = { count: 0 };
  const registry = minecraftData("1.21.4");
  const type = registry.entitiesByName.skeleton.id;
  const bot = carryingShield(huntBot([mob(7, type, "skeleton", 3, "Hostile mobs")], inventory));
  const result = await huntMob(
    bot,
    { ...huntRequest("skeleton"), count: 2, observeForMs: 5_000 },
    {},
    {
      ...dependencies(bot, inventory, [died(2, 3)]),
      // The shield breaks on the kill, and a second skeleton wanders in during
      // the observation window, so the next leg re-enters the gate carrying
      // nothing to block with.
      collectDropAfterDeath: async () => {
        inventory.count += 1;
        bot.inventory.items = () => [];
        setTimeout(() => {
          bot.entities[8] = mob(8, type, "skeleton", 5, "Hostile mobs");
          bot.emit("entitySpawn", bot.entities[8]!);
        }, 0);
        return { kind: "collected" };
      },
    },
  );

  assert.equal(result.termination, "shield_required");
  assert.equal(result.status, "partial", "the drop already collected is not erased by the refusal");
  assert.equal(result.hunt.gained, 1);
  assert.equal(result.hunt.targetDeathsObserved, 1, "the leg fought while shielded still happened");
});

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

test("the default request does not opt out of the shield gate", () => {
  assert.equal(parseHuntMobRequest({ mob_name: "skeleton", drop_name: "bone" }).allowWithoutShield, false);
  assert.equal(
    parseHuntMobRequest({ mob_name: "skeleton", drop_name: "bone", allow_without_shield: true }).allowWithoutShield,
    true,
  );
});
