import type { Bot } from "mineflayer";
import { afterEach } from "node:test";
import { ExecutionScope } from "../execution/execution-scope.js";
import type { NavigationRuntime } from "../navigation/index.js";
import type { ResponseContext } from "../survival/control/combat/context.js";
import { createCombatController } from "../survival/control/combat/controller.js";
import { CombatExecution } from "../survival/control/combat/execution.js";
import { combatResourceRefusal } from "../survival/control/combat/preparation.js";
import { CombatPerception } from "../survival/perception/combat/observations.js";
import { CreeperClearance } from "../survival/perception/combat/creepers.js";
import { DEFAULT_COMBAT_POLICY } from "../survival/policy/combat/contract.js";
import { DEFAULT_FOOD_POLICY, DEFAULT_SURVIVAL_POLICY } from "../survival/policy/contract.js";
import { CombatPosition } from "../survival/positioning/combat/position.js";
import { EndCombat } from "../survival/responses/end/execute.js";
import { FootingRecovery } from "../survival/responses/footing.js";
import { survivalResources, type SurvivalResources } from "../survival/state/resources.js";

const resources = new Set<Disposable>();
function own<T extends Disposable>(resource: T): T {
  resources.add(resource);
  return resource;
}
export function disposeCombatTestResources(): void {
  for (const resource of resources) resource[Symbol.dispose]();
  resources.clear();
}
afterEach(disposeCombatTestResources);

/** Unit fixtures own the runtime services that production supplies from its resource stack. */
export function createTestCombatController(
  bot: Bot,
  navigation: NavigationRuntime,
  perception = own(new CombatPerception(bot)),
  footing = own(new FootingRecovery(bot, navigation.world)),
  survival: SurvivalResources = survivalResources(),
) {
  return createCombatController(bot, navigation, perception, footing, survival);
}

export class TestCombatPosition extends CombatPosition {
  constructor(bot: Bot, navigation: NavigationRuntime, target: Bot["entity"], dead: ReadonlySet<number>) {
    super(
      bot,
      navigation,
      target,
      dead,
      own(new CombatPerception(bot)),
      () => DEFAULT_COMBAT_POLICY,
      survivalResources().answered,
    );
  }
}
export class TestEndCombat extends EndCombat {
  constructor(bot: Bot, navigation: NavigationRuntime, footing: FootingRecovery,
    recordDecision: ConstructorParameters<typeof EndCombat>[7] = () => {}) {
    const scope = own(new ExecutionScope({ bot: bot.username, operation: "end_test", targetId: null }));
    const context = combatTestContext(bot);
    super(bot, navigation, footing, () => DEFAULT_SURVIVAL_POLICY, context.survival, new CombatExecution(scope), context, recordDecision);
  }
}
export function combatResourceRefusalForTest(
  bot: Bot,
  navigation: NavigationRuntime,
  target: Bot["entity"],
  policy = DEFAULT_COMBAT_POLICY,
) {
  return combatResourceRefusal(
    bot,
    navigation,
    target,
    policy,
    own(new CombatPerception(bot)),
    survivalResources().answered,
  );
}
export function combatTestContext(bot: Bot): ResponseContext {
  return {
    perception: { read: () => [], creeperClearance: new CreeperClearance(bot), tick: 0, resolvedIds: new Set() },
    survival: survivalResources(),
    policy: DEFAULT_COMBAT_POLICY,
    food: DEFAULT_FOOD_POLICY,
    resolvedIds: new Set(),
    attackerIds: new Set(),
    unreachableIds: new Set(),
  };
}
