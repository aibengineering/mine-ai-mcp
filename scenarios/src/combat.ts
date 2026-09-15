import type { Bot } from "mineflayer";
import type { NavigationRuntime } from "../../src/navigation/index.ts";
import type { ResponseContext } from "../../src/survival/control/combat/context.ts";
import { createCombatController } from "../../src/survival/control/combat/controller.ts";
import { CombatPerception } from "../../src/survival/perception/combat/observations.ts";
import { FootingRecovery } from "../../src/survival/responses/footing.ts";
import { survivalResources } from "../../src/survival/state/resources.ts";

/** A primitive scenario explicitly owns the services normally owned by the production runtime. */
export class ScenarioCombat implements Disposable {
  readonly perception: CombatPerception;
  readonly footing: FootingRecovery;
  readonly controller: ReturnType<typeof createCombatController>;
  readonly survival = survivalResources();
  readonly context: ResponseContext;
  constructor(bot: Bot, navigation: NavigationRuntime) {
    this.perception = new CombatPerception(bot);
    this.footing = new FootingRecovery(bot, navigation.world);
    this.controller = createCombatController(bot, navigation, this.perception, this.footing, this.survival);
    const controller = this.controller;
    this.context = {
      perception: this.perception,
      survival: this.survival,
      resolvedIds: this.perception.resolvedIds,
      attackerIds: this.perception.attackerIds,
      unreachableIds: new Set(),
      get policy() {
        return controller.policy.combat;
      },
      get food() {
        return controller.policy.food;
      },
    };
  }
  [Symbol.dispose]() {
    this.footing[Symbol.dispose]();
    this.perception[Symbol.dispose]();
  }
}
