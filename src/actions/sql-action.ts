import { z } from "zod";
import type { ActionSqlQueries, SqlQueryCatalogEntry } from "../bot-data/sql-query.js";
import {
  defineAction,
  actionResultSchema,
  type OneShotAction,
  type ResumableAction,
  type Action,
  type ActionDefinition,
  type ActionResult,
} from "./action.js";

export const sqlActionSourceSchema = z.strictObject({
  queryIds: z
    .array(z.string().min(1))
    .min(1)
    .describe("Stable recipes in knowledge.action_queries that explain the data reads supporting this outcome."),
});

export type SqlActionSource = z.output<typeof sqlActionSourceSchema>;
export type SqlActionResult = ActionResult & { readonly source: SqlActionSource };

/** Build the standard settled result for an action backed by registered SQL reads. */
export function sqlActionResultSchema<const Evidence extends z.ZodRawShape>(evidence: Evidence) {
  return actionResultSchema({ ...evidence, source: sqlActionSourceSchema });
}

export type SqlAction<
  Name extends string = string,
  Request = unknown,
  Result extends SqlActionResult = SqlActionResult,
> = Action<Name, Request, Result> & {
  readonly queries: readonly SqlQueryCatalogEntry[];
};

type SqlActionDefinition<Name extends string, Request, Result extends SqlActionResult> = ActionDefinition<
  Name,
  Request,
  Result
> & {
  readonly queries: readonly SqlQueryCatalogEntry[];
};

/** Define a query-backed action, adding standard source evidence and presentation once. */
export function defineSqlAction<const Name extends string, Request, Result extends SqlActionResult>(
  definition: SqlActionDefinition<Name, Request, Result> & { execute: OneShotAction<Name, Request, Result>["execute"] },
): OneShotAction<Name, Request, Result> & { readonly queries: readonly SqlQueryCatalogEntry[] };
export function defineSqlAction<const Name extends string, Request, Result extends SqlActionResult>(
  definition: SqlActionDefinition<Name, Request, Result> & { begin: ResumableAction<Name, Request, Result>["begin"] },
): ResumableAction<Name, Request, Result> & { readonly queries: readonly SqlQueryCatalogEntry[] };
export function defineSqlAction<const Name extends string, Request, Result extends SqlActionResult>(
  definition: SqlActionDefinition<Name, Request, Result>,
): SqlAction<Name, Request, Result>;
export function defineSqlAction<const Name extends string, Request, Result extends SqlActionResult>(
  definition: SqlActionDefinition<Name, Request, Result>,
): SqlAction<Name, Request, Result> {
  if (definition.queries.length === 0) throw new TypeError(`SQL action ${definition.name} must register a query.`);
  const queryIds = definition.queries.map((query) => query.id);
  if (new Set(queryIds).size !== queryIds.length) {
    throw new TypeError(`SQL action ${definition.name} has duplicate query ids.`);
  }
  const { queries, formatResult, ...actionDefinition } = definition;
  const action = defineAction({
    ...actionDefinition,
    formatResult: (result) => `${formatResult(result)}\n\n${queryCatalogueNotice(definition.name)}`,
  });
  return { ...action, queries };
}

export function sqlActionSource(queries: readonly SqlQueryCatalogEntry[]): SqlActionSource {
  return sqlActionSourceSchema.parse({ queryIds: queries.map((query) => query.id) });
}

export function isSqlAction(action: Action): action is SqlAction {
  return "queries" in action && Array.isArray(action.queries);
}

export function actionSqlQueries(actions: readonly Action[]): ActionSqlQueries[] {
  return actions.filter(isSqlAction).map((action) => ({ actionName: action.name, queries: action.queries }));
}

function queryCatalogueNotice(actionName: string): string {
  return `Queries supporting these data are in \`knowledge.action_queries\` where \`action_name = '${actionName}'\`.`;
}
