# Compact output schemas and the inline fallback

`createMinecraftMcpServer(runtime, username)` and the normal host publish compact
output schemas by default. To restore the SDK's previous conversion strategy,
use `createMinecraftMcpServer(runtime, username, { outputSchemaReferences: false })`
or add `--inline-output-schemas` to the normal host command:

```sh
bun src/server/host.ts --inline-output-schemas
```

The fallback affects all protocol sessions created by that host. It retains
existing references for recursive or explicitly identified schemas; it does not
promise a completely reference-free catalogue. There is no dependency or
protocol-version change.

By default, `tools/list` uses Zod's
[`reused: "ref"`](https://zod.dev/json-schema#reused) conversion in output mode,
targeting the same draft-7 dialect as the SDK. Repeated schema nodes move into
each tool's own `definitions` object. References look like
`#/definitions/__schema0` and `#/definitions/MineAiProgress`. Definition numbering
is an implementation detail, not a new public identifier. There are no external
references, references between tools, or `$defs` paths. Recursive facts retain
their recursive references.

The JSON representation changes; the accepted response values do not. Tool
names, descriptions, annotations, input schemas, response fields, constraints,
required/optional fields, and unions are preserved. Registration, input parsing,
action execution, and output validation still use the original Zod schemas and
the SDK's ordinary `registerTool`/`tools/call` path. Only listing uses a custom
handler, installed through the supported `McpServer.server.setRequestHandler`
API. It tracks the public registration handles for the factory's fixed tool
catalogue, without accessing SDK private registries or patching dependencies.

## Host compatibility limits

Actual Claude Code, Claude Desktop and Codex host compatibility with the complete
generated catalogue remains unverified. The default prioritizes lower discovery
cost; use the inline fallback when a host cannot resolve the compact schemas.
The fallback cannot fix every host issue: both formats retain the existing
draft-7 dialect and some recursive references. A smaller schema is still unusable
if the host cannot resolve it.

- The repository tests verify all 37 normal tool contracts and both optional
  debug tools after reference
  expansion, resolve every reference within its containing output schema, and
  check valid/invalid results against both JSON Schema representations and
  source Zod. Installed SDK 1.30 clients exercise discovery, Markdown and JSON
  calls, async pending/settled results, reconnection, HTTP sessions, server-side
  validation, and client rejection of malformed successful structured output.
  Raw discovery requests in the full-catalogue comparison deliberately avoid
  compiling every legacy validator; ordinary client validation is tested
  separately. Isolated HTTP qualification also passed with the official SDK
  1.31.0 and split client 2.2.0 packages, including actively validated successful
  Markdown/JSON output and rejection of invalid input. These packages were
  diagnostic copies; the project's dependencies remain unchanged.
- Codex's [pinned source regression test](https://github.com/openai/codex/blob/875bf9209bd9aeb0a5f102888ccd90b2b59cc3c9/codex-rs/code-mode-protocol/src/description.rs#L686-L727)
  demonstrates local `#/definitions` resolution when rendering an MCP output
  schema. Its renderer extracts the `structuredContent` schema before resolving
  references. Expansion limits can reduce generated types to `unknown`; that
  alone does not demonstrate a tool-call failure. This is source evidence, not
  a live-host qualification of this catalogue. An installed Codex
  `0.159.0-alpha.3` app-server diagnostic could not initialize in the execution
  environment because of read-only state paths; no model turn was started.
- Claude Code documents [multiple MCP client runtimes](https://code.claude.com/docs/en/mcp#mcp-client-runtimes).
  Reports for [2.1.205](https://github.com/anthropics/claude-code/issues/76040)
  and [2.1.207](https://github.com/anthropics/claude-code/issues/77106) describe
  output-schema reference failures, including recursive schemas. A
  [Desktop 1.28929.0 report](https://github.com/anthropics/claude-code/issues/86142)
  describes draft-7 rejection, and a
  [Windows Desktop/Cowork bridge report](https://github.com/anthropics/claude-code/issues/87633)
  describes a surface-specific failure. These are reported bugs, not proof that
  every simple local reference fails or that current releases are fixed.

Qualification must record the host version, runtime and surface; successful
`tools/list`; Markdown and JSON calls; recursive facts and representative async
outputs; and whether the host validates or ignores `outputSchema`. MCP output
schema support must not be inferred from model strict structured-output or input
schema support. Preserve the inline fallback. Do not relabel the schema dialect
without regenerating and revalidating its semantics.
