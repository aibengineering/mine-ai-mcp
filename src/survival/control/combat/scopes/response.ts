import type { Bot } from "mineflayer";
import type { SurvivalPolicy } from "../../../policy/contract.js";
import { recoveryHealth } from "../../../policy/combat/health.js";
import { responsePermissions } from "../../../policy/combat/permissions.js";
import type { AnsweredScope } from "../../../state/answered.js";
import type { SurvivalResources } from "../../../state/resources.js";
import { recoveryScope } from "./recovery.js";

export type CombatResponse = "fight" | "hide" | "evade" | "deflect";

export function responseScope(
  bot: Bot,
  policy: () => Readonly<Pick<SurvivalPolicy, "combat" | "food">>,
  kind: CombatResponse,
  targetId?: number,
): AnsweredScope {
  const origin = bot.entity.position.floored();
  return {
    capability: `combat.${kind}`,
    response: kind,
    scope: kind === "fight" || kind === "deflect" ? `target:${targetId}:cell:${origin}` : `cell:${origin}`,
    permissions: () => ({
      ...responsePermissions(policy().combat, kind),
      ...((kind === "fight" || kind === "hide") && { rawFood: { ...policy().food.raw } }),
    }),
    facts: () => {
      const cells: (number | null)[] = [];
      for (let x = -1; x <= 1; x++)
        for (let z = -1; z <= 1; z++)
          for (let y = -3; y <= 2; y++) cells.push(bot.blockAt(origin.offset(x, y, z))?.stateId ?? null);
      const items = bot.inventory.items();
      return {
        cells,
        target: targetId === undefined ? null : (bot.entities[targetId]?.position.floored().toString() ?? null),
        weapons:
          kind === "fight"
            ? items
                .filter((item) => /bow|arrow|sword|axe|shield/.test(item.name))
                .map((item) => ({ name: item.name, available: item.count > 0 }))
                .sort((a, b) => a.name.localeCompare(b.name))
            : [],
        material:
          kind === "hide"
            ? items
                .filter((item) => bot.registry.blocksByName[item.name])
                .map((item) => ({ name: item.name, count: item.count }))
                .sort((a, b) => a.name.localeCompare(b.name))
            : [],
      };
    },
  };
}

export function answeredResponses(
  bot: Bot,
  policy: () => Readonly<Pick<SurvivalPolicy, "combat" | "food">>,
  survival: SurvivalResources,
): Set<string> {
  const blocked = new Set<string>();
  for (const kind of ["hide", "evade"] as const) {
    const scope = responseScope(bot, policy, kind);
    if (survival.answered.find(scope.capability, scope.scope)) blocked.add(kind);
  }
  const recovery = recoveryScope(bot, policy, recoveryHealth(policy().combat));
  if (survival.answered.find(recovery.capability, recovery.scope)) blocked.add("recovery");
  return blocked;
}
