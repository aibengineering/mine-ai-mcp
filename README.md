# Mine AI MCP

Batteries-included MCP runtime for letting AI play Minecraft.
Mine AI MCP provides external AI agents with reliable, observable tools to
inspect, navigate, and act in Minecraft. Every tool reports what was directly
observed in the game world.

## Quick start: use an existing Minecraft server

Run it straight from the public repository with Bun. The package executes its
TypeScript source, so there is no build step:

```sh
bunx --bun github:aibengineering/mine-ai-mcp --minecraft-host 127.0.0.1 --minecraft-port 25565 --username MineAI --version 1.21.4
```

This starts a persistent MCP host at `http://localhost:25575/mcp` and joins the
specified Minecraft Java server. Keep it running, then connect your AI client
using the examples below. Pin a commit for reproducible runs, for example
`github:aibengineering/mine-ai-mcp#<commit>`.
The default `--auth offline` is for offline-mode servers; use `--auth microsoft`
with a Minecraft account for a server that requires authenticated players.

You need **Bun 1.4 or newer**, a reachable Minecraft Java server (tested with
1.21.4), and **Git** for the current Git-pinned dependencies. Bun installs the
JavaScript dependencies automatically. You do not need a separate Node runtime,
Java installation, Docker, Claude Code, or Mine Labs to run just this MCP host;
Java is needed wherever you host the Minecraft server itself. Use whichever MCP
client you prefer to control the bot.

[`bunx`](https://bun.sh/docs/pm/bunx) downloads missing packages into Bun's shared
cache without adding them to your project's dependencies. It still downloads
and executes code; the cache is not an isolated sandbox. Persistent bot data goes
to `~/.mine-ai/bot-data`, separate from the cache; override it with `--data-root`.

From a source checkout, install dependencies and run the same entry point:

```sh
bun install
bun src/server/host.ts --minecraft-host 127.0.0.1 --minecraft-port 25565 --username MineAI --version 1.21.4
```

Complete documentation lives in
[docs/mcp/README.md](docs/mcp/README.md).

Run a local Claude playthrough with the [Docker playthrough setup](docker/README.md).

## Rebuild the run that beat the game

The commit that defeated the Ender Dragon is tagged `beat-the-game`.
[Dockerfile.beatthegame](Dockerfile.beatthegame) clones that exact commit from
this repository, pins its base images by digest, and reads nothing from your
checkout, so anyone can rebuild the winning image from source. Use the same two
Compose files for every step so the image you run is the one you built:

```sh
docker compose -f compose.yaml -f compose.beatthegame.yaml build
docker compose -f compose.yaml -f compose.beatthegame.yaml run --rm -e RUN_MODE=login play
EULA=true RUN_DIR=./runs/beat-the-game \
  docker compose -f compose.yaml -f compose.beatthegame.yaml up --abort-on-container-exit
```

The overlay pins the winning run's seed (`97996358`), bot name (`AI_M1KE`),
model (`claude-opus-5[1m]`), and effort (`high`). Those reproduce the world and
the setup, not the play itself, which is not deterministic. Set
`EULA=true` only after accepting <https://aka.ms/MinecraftEULA>. The login
is a one-time step. The image records the commit it was built from at
`/etc/mine-ai-mcp-commit`. A plain `docker compose build` overwrites the same
image tag with your checkout, so rebuild with both files before rerunning.
See the [Docker playthrough setup](docker/README.md) for the run directory
layout, stopping, and resuming.

## Connect an MCP client

Start the [Docker playthrough stack](docker/README.md) or the
[standalone host](docs/mcp/README.md) first. The endpoint is
`http://localhost:25575/mcp` (Streamable HTTP); `/health` reports host status.
These commands register a running server with your client; they do not install
or start Minecraft. This package is not yet published to npm, so there is no
`npx` or `bunx` package-install command to advertise yet.

### Allow long Minecraft actions

Configure your harness's **tool execution and idle timeouts**, not just its
connection/startup timeout. Smelting a stack in one ordinary furnace takes over
ten minutes; collection and travel can also be long-running. In our Claude Code
2.1.268 run, a smelting call hit the HTTP client's five-minute idle timeout while
the server continued working. A timed-out client request does not prove the
Minecraft action stopped: inspect status before retrying; another action may
return `ACTION_BUSY`.

We use **3600000 ms (one hour) per Minecraft call** to give these actions headroom
while retaining a finite client wait. Increase it for longer intended actions.
Client settings are not interchangeable: check both idle and overall limits in
any harness you use, and any proxy between it and the server.

### Claude Code

Register the server with the timeout included (Bash/WSL or PowerShell):

```sh
claude mcp add-json --scope project minecraft '{"type":"http","url":"http://localhost:25575/mcp","timeout":3600000}'
```

In Windows Command Prompt, use escaped double quotes instead:

```cmd
claude mcp add-json --scope project minecraft "{\"type\":\"http\",\"url\":\"http://localhost:25575/mcp\",\"timeout\":3600000}"
```

The resulting `.mcp.json` configuration is:

```json
{
  "mcpServers": {
    "minecraft": {
      "type": "http",
      "url": "http://localhost:25575/mcp",
      "timeout": 3600000
    }
  }
}
```

Claude Code's per-server `timeout` controls execution time and, since v2.1.203,
also sets the minimum idle window. `MCP_TIMEOUT` is only the startup timeout;
raising `MCP_TOOL_TIMEOUT` alone does not remove the separate idle limit.
See [Claude MCP setup](https://code.claude.com/docs/en/mcp) and
[timeout variables](https://code.claude.com/docs/en/env-vars).
Our container uses the same setting in [docker/mcp.json](docker/mcp.json).
Rebuild the image before the next run to include config changes; editing the
checkout does not change a running Claude process.

### VS Code and Cursor

VS Code provides a registration command (Bash/WSL or PowerShell):

```sh
code --add-mcp '{"name":"minecraft","type":"http","url":"http://localhost:25575/mcp"}'
```

Run it for the VS Code installation/profile where your agent runs. You can also
use **MCP: Add Server** in the Command Palette. See
[VS Code MCP setup](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

For Cursor, add this to `.cursor/mcp.json` or your user `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "minecraft": { "url": "http://localhost:25575/mcp" }
  }
}
```

Cursor also supports [one-click MCP install links](https://prod.cursor.com/docs/mcp/install-links).
These VS Code/Cursor examples register the connection only; they do not establish
a one-hour timeout. Verify your client's long-call behavior before a playthrough;
do not assume Claude's `timeout` field works in another client's schema.

## Documentation pages

- [Overview](docs/mcp/README.md): Quick start, host startup flags, and making a first call.
- [Async actions](docs/mcp/async-actions.md): Submit work, inspect progress, retrieve typed results, before starting the next objective.
- [Concepts](docs/mcp/concepts.md): Quality standard, five-layer architecture, foreground locking, and lifecycle.
- [Tools](docs/mcp/tools.md): Every published tool grouped by job, arguments, and verification evidence.
- [Bot data](docs/mcp/bot-data.md): SQLite storage, tables and views, worked example queries, and query bounds.
- [Events and responses](docs/mcp/events-and-responses.md): Response representations, notification summaries, and event stream cursors.
- [Testing](docs/mcp/testing.md): Mine Labs scenario suites, playtests, and test execution scripts.
- [Limitations](docs/mcp/limitations.md): Current capability and dependency boundaries.

## Further reading

- [Bot data query guide](docs/mcp/query-guide.md): Read-only SQL surface, safety constraints, and query design.
- [Navigation](docs/navigation/README.md): Navigation APIs, movement, search, execution, and telemetry.
- [Survival](docs/survival/README.md): Combat, environmental responses, and request continuation.

### Note: upstream fixes

We pin our forks in package.json; overrides select the shared transitive dependencies.
Keep these pins until equivalent fixes are available in upstream releases.

| Repository | Fork revision | Diff from upstream `master` | Why we carry it |
| --- | --- | --- | --- |
| Mineflayer | [`9fa1140b90877a084efd988905df0c0eceaa78d0`](https://github.com/aibengineering/mineflayer/commit/9fa1140b90877a084efd988905df0c0eceaa78d0) | [Compare](https://github.com/PrismarineJS/mineflayer/compare/master...aibengineering:9fa1140b90877a084efd988905df0c0eceaa78d0) | Fixes item-use and air metadata ownership, stale respawn metadata, partial item pickups, crafting inventory synchronization, and placement acknowledgements. Includes regression tests and a trace-test parsing correction. The earlier player-loaded fix is now upstream. Preserves item use through hurt and shield-block statuses and tracks item use by active hand and item identity. |
| prismarine-physics | [`56a6794611069272653b14eb078a1454633f4eb3`](https://github.com/aibengineering/prismarine-physics/commit/56a6794611069272653b14eb078a1454633f4eb3) | [Compare](https://github.com/PrismarineJS/prismarine-physics/compare/master...aibengineering:56a6794611069272653b14eb078a1454633f4eb3) | Tolerates floating-point drift at block contacts, avoiding stalled movement and rejected jumps ([PR #135](https://github.com/PrismarineJS/prismarine-physics/pull/135)). Uses the requested movement for the step-up probe, fixing carpet steps under low ceilings ([PR #140](https://github.com/PrismarineJS/prismarine-physics/pull/140)). |
| prismarine-recipe | [`542f0600f5ddf07bb16df67fa1ac06e603bd28e0`](https://github.com/aibengineering/prismarine-recipe/commit/542f0600f5ddf07bb16df67fa1ac06e603bd28e0) | [Compare](https://github.com/PrismarineJS/prismarine-recipe/compare/master...aibengineering:542f0600f5ddf07bb16df67fa1ac06e603bd28e0) | Computes returned crafting containers from the output shape, fixing bucket and bottle inventory deltas. |
| node-minecraft-data (JavaScript wrapper) | [`c932f74334dd27d3d647f9bba58e0735ad4427db`](https://github.com/aibengineering/node-minecraft-data/commit/c932f74334dd27d3d647f9bba58e0735ad4427db) | [Compare](https://github.com/PrismarineJS/node-minecraft-data/compare/master...aibengineering:c932f74334dd27d3d647f9bba58e0735ad4427db) | Bundles the data revision below through its existing Git submodule. Published as the npm package `minecraft-data`, so consumers install one JavaScript package with a reproducible data revision. |
| minecraft-data (game data) | [`c957cc737ab920a452d95a93bc79831fffecc84b`](https://github.com/aibengineering/minecraft-data/commit/c957cc737ab920a452d95a93bc79831fffecc84b) | [Compare](https://github.com/PrismarineJS/minecraft-data/compare/master...aibengineering:c957cc737ab920a452d95a93bc79831fffecc84b) | Includes AnonymoDGH's mining-speed correction ([PR #1232](https://github.com/PrismarineJS/minecraft-data/pull/1232)) and our 1.21.4 recipe remainders: cake returns three buckets; honey blocks return four bottles. This keeps crafting-grid and inventory predictions accurate; neither recipe is required to beat Minecraft. |

The forks include upstream updates fetched on 11 September 2026. We install
minecraft-data from a [release archive](https://github.com/aibengineering/node-minecraft-data/releases/tag/mine-ai-c932f743)
containing the pinned game data and generated JavaScript; Bun's Git download did
not include the data submodule.

Block highlighter and the Mine Labs development dependency are pinned to GitHub
commits in package.json. They currently require engineering GitHub access; see
the [Docker instructions](docker/README.md) for temporary build authentication.
