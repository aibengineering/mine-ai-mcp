import type { Bot } from "mineflayer";

export interface CraftTarget {
  readonly id: number;
  readonly name: string;
  readonly count: number;
}

export interface CraftMaterial {
  readonly item: string;
  readonly count: number;
}

export interface CraftStep {
  readonly item: string;
  readonly count: number;
  readonly applications: number;
  readonly ingredients: CraftMaterial[];
  readonly requiresCraftingTable: boolean;
}

export interface CraftPlanEvidence {
  readonly status: "ready" | "missing_materials" | "uncraftable" | "planner_failed";
  readonly steps: CraftStep[];
  /** Every raw leaf material the selected recipe paths require, whether carried or missing. */
  readonly requiredMaterials: CraftMaterial[];
  /** Carried leaf materials the simulated batch reserves before any crafting begins. */
  readonly carriedMaterials: CraftMaterial[];
  readonly missingMaterials: CraftMaterial[];
  readonly requiresCraftingTable: boolean;
  readonly tree: string;
}

type MineflayerRecipe = ReturnType<Bot["recipesAll"]>[number];

export interface CraftApplication {
  readonly recipe: MineflayerRecipe;
  readonly applications: number;
}

export type CraftPreparation =
  | { readonly kind: "ready"; readonly plan: CraftPlanEvidence; readonly applications: readonly CraftApplication[] }
  | { readonly kind: "missing_materials"; readonly plan: CraftPlanEvidence }
  | { readonly kind: "uncraftable"; readonly plan: CraftPlanEvidence; readonly items: readonly string[] }
  | { readonly kind: "planner_failed"; readonly plan: CraftPlanEvidence; readonly items: readonly string[] };

interface PlanningState {
  readonly available: Map<number, number>;
  readonly craftedSurplus: Map<number, number>;
  readonly required: Map<number, number>;
  readonly carried: Map<number, number>;
  readonly missing: Map<number, number>;
  readonly applications: CraftApplication[];
}

type ItemSource =
  | { readonly kind: "inventory" }
  | { readonly kind: "missing"; readonly count: number }
  | { readonly kind: "recipe"; readonly ingredients: readonly PlannedItem[] };

interface PlannedItem {
  readonly id: number;
  readonly count: number;
  readonly sources: readonly ItemSource[];
}

interface PlannedCandidate {
  readonly state: PlanningState;
  readonly item: PlannedItem;
}

interface PlannedTarget {
  readonly target: CraftTarget;
  readonly root?: PlannedItem;
}

function copyState(state: PlanningState): PlanningState {
  return {
    available: new Map(state.available),
    craftedSurplus: new Map(state.craftedSurplus),
    required: new Map(state.required),
    carried: new Map(state.carried),
    missing: new Map(state.missing),
    applications: [...state.applications],
  };
}

function addCount(counts: Map<number, number>, itemId: number, count: number): void {
  counts.set(itemId, (counts.get(itemId) ?? 0) + count);
}

function itemName(bot: Bot, itemId: number): string {
  return bot.registry.items[itemId]?.name ?? `item_${itemId}`;
}

function recipeInputs(recipe: MineflayerRecipe): readonly { id: number; count: number }[] {
  return recipe.delta.filter((item) => item.count < 0);
}

function missingScore(state: PlanningState): readonly [number, number, number] {
  const missingUnits = [...state.missing.values()].reduce((total, count) => total + count, 0);
  return [missingUnits, state.missing.size, state.applications.length];
}

function isBetterCandidate(candidate: PlannedCandidate, current: PlannedCandidate | null): boolean {
  if (!current) return true;
  const candidateScore = missingScore(candidate.state);
  const currentScore = missingScore(current.state);
  for (let index = 0; index < candidateScore.length; index += 1) {
    if (candidateScore[index] !== currentScore[index]) return candidateScore[index] < currentScore[index];
  }
  return false;
}

/** Plan one requirement against a simulated inventory and retain its selected recipe tree. */
function planNeededItem(
  bot: Bot,
  initial: PlanningState,
  itemId: number,
  count: number,
  ancestors: ReadonlySet<number>,
  useInventory: boolean,
): PlannedCandidate | null {
  const state = copyState(initial);
  const sources: ItemSource[] = [];
  let remaining = count;

  if (useInventory) {
    const available = state.available.get(itemId) ?? 0;
    const consumed = Math.min(available, remaining);
    if (consumed > 0) {
      state.available.set(itemId, available - consumed);
      const crafted = state.craftedSurplus.get(itemId) ?? 0;
      const consumedSurplus = Math.min(crafted, consumed);
      state.craftedSurplus.set(itemId, crafted - consumedSurplus);
      const consumedInventory = consumed - consumedSurplus;
      if (consumedInventory > 0) {
        addCount(state.required, itemId, consumedInventory);
        addCount(state.carried, itemId, consumedInventory);
      }
      sources.push({ kind: "inventory" });
      remaining -= consumed;
    }
  }

  if (remaining === 0) return { state, item: { id: itemId, count, sources } };
  if (ancestors.has(itemId)) return null;

  const recipes = bot.recipesAll(itemId, null, true);
  if (recipes.length === 0) {
    addCount(state.required, itemId, remaining);
    addCount(state.missing, itemId, remaining);
    sources.push({ kind: "missing", count: remaining });
    return { state, item: { id: itemId, count, sources } };
  }

  const nextAncestors = new Set(ancestors).add(itemId);
  let best: PlannedCandidate | null = null;

  for (const recipe of recipes) {
    const applications = Math.ceil(remaining / recipe.result.count);
    let candidateState = copyState(state);
    const ingredients: PlannedItem[] = [];
    let cyclic = false;

    for (const ingredient of recipeInputs(recipe)) {
      const planned = planNeededItem(
        bot,
        candidateState,
        ingredient.id,
        -ingredient.count * applications,
        nextAncestors,
        true,
      );
      if (!planned) {
        cyclic = true;
        break;
      }
      candidateState = planned.state;
      ingredients.push(planned.item);
    }
    if (cyclic) continue;

    candidateState.applications.push({ recipe, applications });
    const surplus = recipe.result.count * applications - remaining;
    if (surplus > 0) {
      addCount(candidateState.available, itemId, surplus);
      addCount(candidateState.craftedSurplus, itemId, surplus);
    }

    const candidate: PlannedCandidate = {
      state: candidateState,
      item: { id: itemId, count, sources: [...sources, { kind: "recipe", ingredients }] },
    };
    if (isBetterCandidate(candidate, best)) best = candidate;
  }

  return best;
}

function materials(bot: Bot, counts: ReadonlyMap<number, number>): CraftMaterial[] {
  return [...counts]
    .filter(([, count]) => count > 0)
    .map(([id, count]) => ({ item: itemName(bot, id), count }))
    .sort((left, right) => left.item.localeCompare(right.item));
}

function steps(bot: Bot, applications: readonly CraftApplication[]): CraftStep[] {
  return applications.map(({ recipe, applications: count }) => ({
    item: itemName(bot, recipe.result.id),
    count: recipe.result.count * count,
    applications: count,
    ingredients: recipeInputs(recipe).map((ingredient) => ({
      item: itemName(bot, ingredient.id),
      count: -ingredient.count * count,
    })),
    requiresCraftingTable: recipe.requiresTable,
  }));
}

function recipeTree(bot: Bot, targets: readonly PlannedTarget[]): string {
  const sections = targets.map(({ target, root }) => {
    const lines = [`${target.name} x${target.count}`];
    if (!root) return lines[0];

    const appendIngredients = (item: PlannedItem, prefix: string): void => {
      const ingredients = item.sources.flatMap((source) => (source.kind === "recipe" ? source.ingredients : []));
      ingredients.forEach((ingredient, index) => {
        const last = index === ingredients.length - 1;
        const missing = ingredient.sources
          .filter((source) => source.kind === "missing")
          .reduce((total, source) => total + source.count, 0);
        lines.push(
          `${prefix}${last ? "└─" : "├─"} ${itemName(bot, ingredient.id)} x${ingredient.count}${missing > 0 ? ` - missing ${missing}` : ""}`,
        );
        appendIngredients(ingredient, `${prefix}${last ? "   " : "│  "}`);
      });
    };

    appendIngredients(root, "");
    return lines.join("\n");
  });
  return sections.join("\n\n");
}

function evidence(
  bot: Bot,
  status: CraftPlanEvidence["status"],
  state: PlanningState,
  targets: readonly PlannedTarget[],
): CraftPlanEvidence {
  return {
    status,
    steps: steps(bot, state.applications),
    requiredMaterials: materials(bot, state.required),
    carriedMaterials: materials(bot, state.carried),
    missingMaterials: materials(bot, state.missing),
    requiresCraftingTable: state.applications.some(({ recipe }) => recipe.requiresTable),
    tree: recipeTree(bot, targets),
  };
}

/**
 * Plan an all-or-nothing crafting batch without mutating the bot.
 * Earlier targets reserve their requested output while intermediate surplus
 * remains available to later targets.
 */
export function planCraftingFromInventory(bot: Bot, targets: readonly CraftTarget[]): CraftPreparation {
  const available = new Map<number, number>();
  for (const item of bot.inventory.items()) addCount(available, item.type, item.count);
  let state: PlanningState = {
    available,
    craftedSurplus: new Map(),
    required: new Map(),
    carried: new Map(),
    missing: new Map(),
    applications: [],
  };
  const plannedTargets: PlannedTarget[] = [];
  const uncraftable: string[] = [];
  const plannerFailures: string[] = [];

  for (const target of targets) {
    if (bot.recipesAll(target.id, null, true).length === 0) {
      uncraftable.push(target.name);
      plannedTargets.push({ target });
      continue;
    }

    const planned = planNeededItem(bot, state, target.id, target.count, new Set(), false);
    if (!planned) {
      plannerFailures.push(target.name);
      plannedTargets.push({ target });
      continue;
    }
    state = planned.state;
    plannedTargets.push({ target, root: planned.item });
  }

  if (uncraftable.length > 0) {
    return {
      kind: "uncraftable",
      items: uncraftable,
      plan: evidence(bot, "uncraftable", state, plannedTargets),
    };
  }
  if (plannerFailures.length > 0) {
    return {
      kind: "planner_failed",
      items: plannerFailures,
      plan: evidence(bot, "planner_failed", state, plannedTargets),
    };
  }
  if (state.missing.size > 0) {
    return { kind: "missing_materials", plan: evidence(bot, "missing_materials", state, plannedTargets) };
  }
  return {
    kind: "ready",
    plan: evidence(bot, "ready", state, plannedTargets),
    applications: state.applications,
  };
}
