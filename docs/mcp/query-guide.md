# Bot data query guide

Use `query_bot_data` to inspect remembered world facts, durable events,
and the connected Minecraft version through read-only SQLite queries.

For storage locations, schema tables, and basic examples, see [Bot data](bot-data.md).
This guide covers schema discovery, reusable action queries, and interpreting results.

## Discover the schema

The action-specific input is `sql`. MCP calls also require the common `rationale`
field described in the [tool overview](README.md). Start with the dictionary when
table or column names are unfamiliar:

```sql
SELECT database_name, table_name, column_name, description
FROM data_dictionary
ORDER BY database_name, table_name, column_name;
```

## Queryable databases

The bot-data connection presents two schemas:

| Schema      | Meaning                                                                                                                            |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `main`      | The selected bot-owned or shared world memory, including observed chunks, storage containers, biome/material sets, water coverage, and frontier flags. |
| `knowledge` | Disposable connected-version registry tables plus `action_queries`, the canonical read recipes registered by query-backed actions. |

An unqualified temporary `data_dictionary` table combines the semantic bot-data
dictionary with the knowledge schema discovered through SQLite introspection,
and adds `database_name`. Queries should qualify tables when joining schemas,
for example `main.frontier_chunk_materials` and `knowledge.blocks`. The host
owns the connection and its knowledge attachment; model SQL cannot attach
another database or see storage paths.

When an action result contains `source.queryIds`, inspect its registered recipes
without expanding every normal action response:

```sql
SELECT query_id, produces, parameter_names, sql
FROM knowledge.action_queries
WHERE action_name = 'view_frontier'
ORDER BY query_id;
```

`parameter_names` is a JSON array matching the positional `?` placeholders in
the stored SQL. The recipes describe the authoritative reads supporting an
action and are intended to be copied, rebound, or modified as needed; they are
not an exhaustive trace of internal SQLite bookkeeping.

Knowledge table and column names are derived from registry property names in
`snake_case`; for example `blocksArray` becomes `knowledge.blocks` and
`displayName` becomes `display_name`. Nested arrays and objects, including block
drops and recipe ingredients, remain JSON text and can be inspected with
SQLite's `json_each` and `json_extract`. This deliberately exposes what the
connected registry supplies instead of maintaining a parallel TypeScript model
of Minecraft data.

## Query workflow

1. Call the tool when a decision depends on remembered world facts or exact
   connected-version game facts.
2. If the relevant names or joins are unclear, query `data_dictionary` first.
3. Run the narrow query needed for the decision.
4. If `truncated` is true, refine the predicate or aggregation rather than
   assuming the returned rows are complete.

Keep recursive CTEs explicitly bounded and avoid unfiltered cross joins over
large tables. A query failure describes the query or runtime, not the Minecraft world.
Refine the query before retrying; a failed runtime must first be restarted.

Typical questions map naturally onto that loop:

- “Where am I within the remembered map?” should normally start with
  `view_frontier`; its structured result provides query IDs that can be looked up in
  `knowledge.action_queries` to refine the map or inspect individual chunks.
- “Have we seen the biome or material I need?” reads the frontier tables.
- “Which remembered chunks lie on the unexplored boundary?” filters
  `main.frontier_chunks` by `is_frontier = 1`.
- “Where did we last see iron ingots?” filters
  `main.observed_container_items` by `item_name = 'iron_ingot'`; the row carries
  the location, quantity, observer, and observation time.
- “What does this block drop, and can I craft the result?” reads the block's
  JSON `drops`, joins those IDs to `knowledge.items`, and inspects
  `knowledge.recipes`.
- “What is that entity type?” reads the runtime-derived `knowledge.entities`
  table.

The model should not call SQL merely to repeat facts already present in its
current observation, and the tool description should not prescribe an action
after a query. SQL returns facts; the model decides what to do with them.

The derived `main.frontier_map_chunks` view supplies one compact row per
remembered chunk: coordinates, frontier flag, water coverage, dominant biome,
and sorted biome and material lists. The ASCII renderer uses nearby flagged
chunks to mark their unobserved cardinal neighbours. This keeps the stored model
to one canonical chunk record instead of creating a second map representation.

## Result and correction path

A successful call uses the same measured action envelope as every other
capability, with compact column-oriented rows as its action-owned evidence:

```ts
{
  action: "query_bot_data";
  durationMs: number;
  result: {
    status: "succeeded";
    query: {
      columns: string[];
      rows: (string | number | null)[][];
      returnedRows: number;
      truncated: boolean;
    };
  };
}
```

Array rows preserve duplicate selected column names and avoid repeating keys in
every row. Integers outside JavaScript's safe range become decimal strings.
BLOBs are rejected with a suggestion to select `hex(...)`; non-finite numbers
are rejected rather than silently changing meaning during JSON serialization.

SQL syntax, authorization, and result-shape failures use the generic failed
action result and are marked as MCP tool errors with factual messages. That lets
the model repair a query. MCP calls return an action-owned Markdown table by
default, accompanied only by a structured format marker. Callers may set
`response_format: "json"` to receive the result under
`structuredContent.response.data` with no text block; the action result is not
duplicated.

## Enforcement and bounds

The description is not the security boundary. Model SQL runs synchronously on
the same `SqlBotData` connection used by trusted frontier reads and writes. The
connection normally rests in query-only mode; a trusted host transaction opens
the brief writable window, while a model query adds a stricter SQLite authorizer
for the duration of its read. Connected-version knowledge is attached once at
startup. Temporary mode uses the same path against its original in-memory
database, so it creates no files, copies, or snapshots.

Each query is constrained by all of the following:

- exactly one statement and at most 16 KiB of SQL;
- a SQLite authorizer allowlist for reads, functions, SELECT, and recursive
  SELECT only;
- `query_only`, defensive mode, disabled double-quoted string literals, and
  disabled extension loading;
- at most 100 returned rows and 64 KiB of complete serialized result data.

SQL execution is synchronous and has no per-query progress interrupt. An
expensive query can block the runtime's event loop. The standard host runs that
runtime in a child process: its supervisor detects missed heartbeats, terminates
the unresponsive runtime, and reports `RUNTIME_UNRESPONSIVE`. This is runtime
failure handling, not a query timeout that leaves the same connection usable.
A directly embedded runtime does not gain that process supervision.

Keep queries focused. The implementation and limits are defined in
[the query contract](../../src/actions/query-bot-data/contract.ts),
[SQL execution](../../src/bot-data/sql-bot-data.ts), and
[host supervision](../../src/server/runtime-supervisor.ts).
