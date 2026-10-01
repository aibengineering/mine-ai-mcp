import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import { z } from "zod";
import { createActions, defineAction, actionResultSchema } from "../actions/index.js";
import { notificationSummarySchema } from "../bot-data/event-log.js";
import { ActionRunner } from "../session/action-runner.js";
import { AsyncActions } from "../session/async-actions.js";
import { factsSchema } from "../survival/evidence/contract.js";
import { botFixture } from "../test-support/bot.js";
import { temporaryBotData } from "../test-support/bot-data.js";
import { createMinecraftMcpHttpApplication } from "./http.js";
import { createMinecraftMcpServer } from "./mcp.js";
import { ReferenceToolCatalogue } from "./tool-catalogue.js";

type Schema = Record<string, any>;

function resolve(ref: string, root: Schema): Schema {
  assert.match(ref, /^#\/definitions\//, "every reference must be local to this outputSchema");
  const result = ref.slice(2).split("/").reduce((value, key) => value?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  assert.ok(result && typeof result === "object", `unresolved reference ${ref}`);
  return result;
}

function checkReferences(value: unknown, root: Schema): number {
  if (!value || typeof value !== "object") return 0;
  const node = value as Schema;
  assert.equal(node.$id, undefined, "nested IDs would change the reference resolution scope");
  assert.equal(node.$defs, undefined, "draft-7 references must use definitions");
  let count = 0;
  if (node.$ref) {
    resolve(node.$ref, root);
    assert.deepEqual(Object.keys(node), ["$ref"], "draft-7 ignores siblings of $ref");
    count++;
  }
  for (const child of Object.values(node)) count += checkReferences(child, root);
  return count;
}

const annotationKeywords = ["title", "description", "default", "examples", "readOnly", "writeOnly", "deprecated"];

// Compare validation keywords and annotations after expanding references. A repeated
// ancestor is a recursive backedge, not a reason to expand indefinitely.
function contract(value: any, root: Schema, ancestors = new Set<object>()): any {
  if (Array.isArray(value)) return value.map((child) => contract(child, root, ancestors));
  if (!value || typeof value !== "object") return value;
  if (value.$ref) {
    const target = resolve(value.$ref, root);
    return ancestors.has(target) ? { recursive: true } : contract(target, root, ancestors);
  }
  const next = new Set(ancestors).add(value);
  const result: Schema = {};
  for (const [key, child] of Object.entries(value)) {
    if (["$schema", "$id", "definitions"].includes(key)) continue;
    result[key] = contract(child, root, next);
  }
  if (result.allOf?.length === 1 && Object.keys(result).every((key) => key === "allOf" || annotationKeywords.includes(key))) {
    const { allOf, ...annotations } = result;
    return { ...allOf[0], ...annotations };
  }
  // Zod can represent a nullable primitive as either a type array or anyOf.
  if (result.anyOf?.length === 2 && Object.keys(result).every((key) => key === "anyOf" || annotationKeywords.includes(key))) {
    const nil = result.anyOf.find((node: Schema) => Object.keys(node).length === 1 && node.type === "null");
    const other = result.anyOf.find((node: Schema) => node !== nil);
    if (nil && ["string", "number", "integer", "boolean"].includes(other.type) && !("enum" in other) && !("const" in other)) {
      const { anyOf: _anyOf, ...annotations } = result;
      return { ...other, ...annotations, type: [other.type, "null"].sort() };
    }
  }
  if (Array.isArray(result.type)) result.type.sort();
  return result;
}

async function connect(t: TestContext, server: McpServer): Promise<Client> {
  const client = new Client({ name: "reference-contract", version: "1" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  await client.connect(c);
  t.after(async () => { await client.close(); await server.close(); });
  return client;
}

// The public request API fetches the entire catalogue without compiling every
// large legacy output validator. Ordinary listTools/callTool are tested below.
const discover = (client: Client) => client.request({ method: "tools/list" }, ListToolsResultSchema);

for (const debugExecuteJavaScript of [false, true]) {
test(`the complete production catalogue defaults to equivalent reference schemas with an explicit inline fallback (debug=${debugExecuteJavaScript})`, async (t) => {
  const botData = temporaryBotData({ closeAfter: t });
  // Factories only: no Minecraft connection or action execution. Unused
  // execution services deliberately cannot be invoked by this test.
  const actions = createActions({ bot: botFixture(), botData,
    budgets: {} as never, frontier: {} as never, navigation: {} as never, strongholdEyeFlights: {} as never,
    combat: { policy: { declareQuarry() {}, reserveArrows() {} } } as never,
    cancelForegroundAction: () => { throw new Error("Catalogue test cannot cancel actions"); },
    observeStatusActivity: () => { throw new Error("Catalogue test cannot execute actions"); },
  }, { debugExecuteJavaScript });
  const runner = new ActionRunner();
  const runtime = { actions, run: runner.run, asyncActions: new AsyncActions(runner, runner.run),
    notificationSummary: () => ({ unreadCount: 0 }), recordActionRequest: () => 1, recordActionResponse: () => {},
  };
  const baseline = await discover(await connect(t, createMinecraftMcpServer(runtime, "TestBot", { outputSchemaReferences: false })));
  const references = await discover(await connect(t, createMinecraftMcpServer(runtime, "TestBot")));
  const explicitReferences = await discover(await connect(t, createMinecraftMcpServer(runtime, "TestBot", { outputSchemaReferences: true })));
  assert.deepEqual(explicitReferences, references);
  assert.equal(baseline.tools.length, debugExecuteJavaScript ? 39 : 37);
  for (let i = 0; i < baseline.tools.length; i++) {
    const { outputSchema: inline, ...before } = baseline.tools[i]!;
    const { outputSchema: refs, ...after } = references.tools[i]!;
    assert.deepEqual(after, before, `input and metadata changed for ${before.name}`);
    assert.ok(inline && refs);
    assert.equal(refs.type, "object");
    assert.equal(refs.$schema, inline.$schema);
    checkReferences(refs, refs);
    assert.deepEqual(contract(refs, refs), contract(inline, inline), `contract changed for ${before.name}`);
  }
  const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
  assert.ok(size(references) < size(baseline) * 0.5);
  const wait = references.tools.find((tool) => tool.name === "wait_for_action")!.outputSchema!;
  assert.ok(checkReferences(wait, wait) > 500);
  assert.ok(size(wait) < 200_000);
  const repeated = await discover(await connect(t, createMinecraftMcpServer(runtime, "TestBot", { outputSchemaReferences: true })));
  assert.deepEqual(repeated, references, "references must be stable and self-contained across sessions");
});
}

const evidenceSchema = z.strictObject({
  count: z.number().int().min(1).max(5),
  tag: z.string().min(2).max(5).regex(/^[a-z]+$/),
  kind: z.enum(["item", "block"]),
  position: z.tuple([z.number(), z.number(), z.number()]),
  facts: factsSchema,
  note: z.string().nullable().optional(),
});
const resultSchema = actionResultSchema({ left: evidenceSchema, right: evidenceSchema });
const action = defineAction({
  name: "reference_action", description: "Exercise typed action evidence", inputSchema: z.strictObject({}),
  resultSchema, execution: { kind: "information" }, parse: () => ({}), formatResult: () => "Evidence observed.",
  execute: async () => ({ status: "succeeded", left: evidence(), right: evidence() }),
});
function evidence() {
  return { count: 2, tag: "abc", kind: "item" as const, position: [0, 64, 0] as [number, number, number],
    facts: { nested: [null, true, 3, "value", { deeper: [false] }] }, note: null };
}
const outputSchema = z.strictObject({
  response: z.discriminatedUnion("format", [
    z.strictObject({ format: z.literal("markdown"), markdown: z.string() }),
    z.strictObject({ format: z.literal("json"), data: action.outputSchema }),
  ]),
  notifications: notificationSummarySchema.optional(),
});

test("inline, referenced and source-Zod validators agree on constraints, status unions, optional fields and recursive facts", async (t) => {
  const server = new McpServer({ name: "validation-contract", version: "1" });
  const catalogue = new ReferenceToolCatalogue(server);
  catalogue.registerTool(action.name, { inputSchema: z.strictObject({}), outputSchema }, async () => ({ content: [] }));
  catalogue.publish();
  const refs = (await discover(await connect(t, server))).tools[0]!.outputSchema!;
  assert.ok(checkReferences(refs, refs) > 0);
  const provider = new AjvJsonSchemaValidator();
  const inlineValidator = provider.getValidator(z.toJSONSchema(outputSchema, { target: "draft-7", io: "output" }) as typeof refs);
  const refValidator = provider.getValidator(refs);
  const cases: { label: string; value: any; valid: boolean }[] = [
    { label: "markdown", value: { response: { format: "markdown", markdown: "observed" } }, valid: true },
  ];
  for (const status of ["succeeded", "partial", "failed", "cancelled"] as const) {
    const value = { response: { format: "json", data: { action: action.name, durationMs: 1,
      result: { status, left: evidence(), right: evidence(), ...(status === "succeeded" ? {} : { error: "stopped" }) } } },
      notifications: { unreadCount: 0 } };
    cases.push({ label: status, value, valid: true });
    const mutations: [string, (value: any) => void][] = [
      ["missing response", (v) => { delete v.response; }],
      ["extra root field", (v) => { v.extra = true; }],
      ["wrong format", (v) => { v.response.format = "yaml"; }],
      ["wrong action", (v) => { v.response.data.action = "other"; }],
      ["negative duration", (v) => { v.response.data.durationMs = -1; }],
      ["fractional duration", (v) => { v.response.data.durationMs = 1.5; }],
      ["low count", (v) => { v.response.data.result.left.count = 0; }],
      ["high count", (v) => { v.response.data.result.left.count = 6; }],
      ["fractional count", (v) => { v.response.data.result.left.count = 1.5; }],
      ["short tag", (v) => { v.response.data.result.left.tag = "a"; }],
      ["long tag", (v) => { v.response.data.result.left.tag = "abcdef"; }],
      ["tag pattern", (v) => { v.response.data.result.left.tag = "AB"; }],
      ["bad enum", (v) => { v.response.data.result.left.kind = "entity"; }],
      ["tuple arity", (v) => { v.response.data.result.left.position.push(0); }],
      ["missing evidence", (v) => { delete v.response.data.result.right; }],
      ["extra evidence", (v) => { v.response.data.result.right.extra = true; }],
      ["wrong optional field", (v) => { v.response.data.result.right.note = 5; }],
      ["unknown status", (v) => { v.response.data.result.status = "pending"; }],
    ];
    if (status !== "succeeded") mutations.push(["missing error", (v) => { delete v.response.data.result.error; }]);
    for (const [label, mutate] of mutations) {
      const invalid = structuredClone(value); mutate(invalid);
      cases.push({ label: `${status}: ${label}`, value: invalid, valid: false });
    }
    const optional: any = structuredClone(value);
    delete optional.response.data.result.left.note;
    cases.push({ label: `${status}: optional absent`, value: optional, valid: true });
  }
  for (const status of ["failed", "cancelled"]) cases.push({ label: `runtime ${status}`, valid: true,
    value: { response: { format: "json", data: { action: action.name, durationMs: 0,
      result: { kind: "runtime_failure", status, error: "unavailable" } } } } });
  for (const entry of cases) {
    assert.equal(outputSchema.safeParse(entry.value).success, entry.valid, `source: ${entry.label}`);
    assert.equal(inlineValidator(entry.value).valid, entry.valid, `inline: ${entry.label}`);
    assert.equal(refValidator(entry.value).valid, entry.valid, `references: ${entry.label}`);
  }
});

function runtime() {
  const runner = new ActionRunner();
  return { actions: [action], run: runner.run, notificationSummary: () => ({ unreadCount: 0 }),
    recordActionRequest: () => 1, recordActionResponse: () => {} };
}

test("an empty session preserves the absence of a tools capability in both modes", async (t) => {
  for (const outputSchemaReferences of [false, true]) {
    const client = await connect(t, createMinecraftMcpServer({ ...runtime(), actions: [] }, "TestBot", { outputSchemaReferences }));
    assert.equal(client.getServerCapabilities()?.tools, undefined);
    await assert.rejects(discover(client), /Method not found/);
  }
});

async function exercise(client: Client) {
  const listed = await client.listTools(); // Compiles output validators in SDK 1.30.
  const schema = listed.tools[0]!.outputSchema!;
  assert.ok(checkReferences(schema, schema) > 0);
  const validator = new AjvJsonSchemaValidator().getValidator(schema);
  assert.equal(validator({ response: { format: "json", data: 1 } }).valid, false);
  for (const response_format of ["markdown", "json"]) {
    const reply = await client.callTool({ name: action.name, arguments: { rationale: "Verify references", response_format } });
    assert.equal(reply.isError, false);
    assert.equal(validator(reply.structuredContent).valid, true);
    assert.equal(outputSchema.safeParse(reply.structuredContent).success, true);
  }
  const invalid = await client.callTool({ name: action.name, arguments: { rationale: "" } });
  assert.equal(invalid.isError, true, "server input validation must remain active");
}

test("ordinary SDK in-memory discovery and calls resolve and validate reference schemas", async (t) => {
  await exercise(await connect(t, createMinecraftMcpServer(runtime(), "TestBot")));
});

test("ordinary SDK HTTP discovery, calls and a new session resolve and validate reference schemas", async (t) => {
  const application = createMinecraftMcpHttpApplication({
    createServer: () => createMinecraftMcpServer(runtime(), "TestBot"),
  });
  const listener = createServer(application.app);
  t.after(async () => {
    await application.close();
    const closed = new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
    listener.closeAllConnections();
    await closed;
  });
  listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const address = listener.address(); assert.ok(address && typeof address === "object");
  for (let session = 0; session < 2; session++) {
    const client = new Client({ name: "http-reference-contract", version: "1" });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    try { await client.connect(transport); await exercise(client); }
    finally { await transport.terminateSession(); await client.close(); }
  }
  assert.equal(application.clientSessionCount, 0);
});

test("server Zod output validation remains active and the SDK rejects invalid successful structuredContent", async (t) => {
  const server = new McpServer({ name: "invalid-output-contract", version: "1" });
  const catalogue = new ReferenceToolCatalogue(server);
  const invalid = { content: [], structuredContent: { response: { format: "json", data: 17 } }, isError: false };
  catalogue.registerTool(action.name, { inputSchema: z.strictObject({}), outputSchema }, async () => invalid);
  catalogue.publish();
  const client = await connect(t, server);
  await client.listTools();
  assert.equal((await client.callTool({ name: action.name, arguments: {} })).isError, true,
    "McpServer must still reject malformed handler output using Zod");
  // Bypass only server validation in this adversarial fixture to prove that
  // an ordinary client actively applies the discovered reference validator.
  server.server.setRequestHandler(CallToolRequestSchema, () => invalid);
  await assert.rejects(client.callTool({ name: action.name, arguments: {} }), /Structured content does not match the tool's output schema/);
});
