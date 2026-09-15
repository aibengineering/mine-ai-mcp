# Local Claude Minecraft run

A Bun-based container runs vanilla Minecraft 1.21.4, Mine AI MCP, and the installed Claude
Code CLI. Claude's completion ends the run: the launcher disconnects the bot and
saves/stops Minecraft. `docker compose stop` follows the same shutdown path.

## Prerequisites

- Docker Engine with the Compose v2 and Buildx plugins. The Dockerfile uses a
  BuildKit `# syntax=` directive, so legacy `docker build` and Compose v1 do not
  work. Verified with Docker Engine 29 and Compose v5.
- A Linux shell. On Windows, use a WSL 2 distribution with Docker Engine installed
  inside it, or Docker Desktop with WSL integration enabled for that distribution.
  Run every command below from that shell, in the Mine AI MCP checkout directory.
- A Claude account with a subscription; the container signs in with your browser.

All dependencies install from their published sources; no sibling checkout or
companion build step is needed. The two Bun-native companion packages are pinned
to Git commits:

- Mine Labs: `08e7c0d4c8ea12d103f25e89af287731e3546e48`.
- Block highlighter: `8fe2983f3be5fc562437d25cc8afbb715d5103c5`.

Mine Labs is a development dependency; this playthrough runs vanilla Minecraft directly.

## Run a playthrough

Follow these steps in order from the Mine AI MCP directory. The login is a one-time
step per `PRIVATE_DIR`; the other steps repeat for each new run.

### 1. Build the image

```sh
docker compose build
```

This builds from your checkout, including uncommitted changes, which is what you
want while developing. To build from a published commit instead, so a run can be
rebuilt from source by anyone, use the beat-the-game Compose file:

```sh
docker compose -f compose.yaml -f compose.beatthegame.yaml build
```

To rebuild a different run, pass its tag or commit:

```sh
MINE_AI_MCP_REF=<tag-or-commit> \
  docker compose -f compose.yaml -f compose.beatthegame.yaml build
```

[Dockerfile.beatthegame](../Dockerfile.beatthegame) clones the public repository
at that ref and reads nothing from the build context, so the image contents
depend only on the commit. `MINE_AI_MCP_REF` defaults to the commit that beat
the game, tagged `beat-the-game`; the resolved commit is recorded at
`/etc/mine-ai-mcp-commit` inside the image. The exact seed, bot name, and model
of the winning run are in the [root README](../README.md#rebuild-the-run-that-beat-the-game).

### 2. Log into Claude Code inside the container

Claude runs inside the container with its own configuration directory, so your
host login is not reused. Sign in once:

```sh
docker compose run --rm -e RUN_MODE=login play
```

This prints a sign-in URL. Open it in a browser, approve access, and paste the
returned code back into the terminal. The login is saved under `PRIVATE_DIR`
(default: `./private`, which is gitignored) and persists across runs and image
rebuilds. Use the same `PRIVATE_DIR` for the login and for every run; a run
mounted on a different private directory starts logged out.

Confirm the saved login before starting a run:

```sh
docker compose run --rm --entrypoint claude play auth status
```

The JSON output must show `"loggedIn": true`.

### 3. Start the run

```sh
# Set EULA=true only after accepting https://aka.ms/MinecraftEULA.
EULA=true SEED=12345 RUN_DIR=./runs/seed-12345 docker compose up --abort-on-container-exit
```

To run detached, replace `--abort-on-container-exit` with `-d`; the two flags
cannot be combined. Startup takes about a minute: Minecraft generates the
world, the MCP host connects the bot, and then the log prints
`Running Claude Code. Transcript: ...`.

### 4. Check that it is running

```sh
docker compose ps
curl http://127.0.0.1:25575/health
tail -c 2000 ./runs/seed-12345/claude/*.stream.jsonl
```

The container should stay `Up`, the health endpoint should answer, and the
transcript should show Claude calling `mcp__minecraft__*` tools.

If the container exits within seconds of the `Running Claude Code` line, the
usual cause is a missing login. Docker's own log shows nothing further; the
reason is in the transcript, which will contain
`Not logged in · Please run /login` with `"error":"authentication_failed"`.
Repeat step 2 with the same `PRIVATE_DIR`, then start a new run.

### 5. Stop

```sh
docker compose stop
```

This disconnects the bot and saves the world before Minecraft exits. The run
directory keeps the world, databases, and transcripts.

Restarting with the same `RUN_DIR` automatically continues the exact Claude
conversation recorded in `claude/current-session`. For a legacy run directory,
the launcher adopts the uniquely newest valid `.run.json` and persists that
pointer. To choose a different legacy session explicitly, set its UUID once:

```sh
EULA=true RUN_DIR=./runs/seed-12345 CLAUDE_RESUME_SESSION=<session-uuid> docker compose up --abort-on-container-exit
```

Resume fails before Minecraft starts unless both the selected run record and
Claude's native conversation JSONL exist. Ambiguous legacy timestamps fail with
an instruction to set `CLAUDE_RESUME_SESSION`; the launcher never silently opens
a new conversation in a directory containing prior runs.
The continuation prompt tells Claude to inspect the current world and reconcile
an interrupted tool call before proceeding; override it with
`CLAUDE_RESUME_PROMPT` when a more specific handoff is needed. Each restart gets
a separate attempt UUID, so Minecraft, stream, stderr, debug, and attempt metadata
files do not overwrite the prior attempt.
Smoke mode neither creates a gameplay session nor changes the pointer.

For a server/MCP smoke test without a Claude request:

```sh
EULA=true SEED=12345 RUN_DIR=./runs/smoke RUN_MODE=smoke docker compose up --abort-on-container-exit --exit-code-from play
```

`smoke.json` records the discovered MCP tools and a successful status call.
If observers are configured, the smoke test also joins as the first listed name
and verifies spectator mode and the operator UUID; use a test name for this check.
Use a new `RUN_DIR` for each new world. Changing `SEED` does not regenerate an
existing world. Override `PROMPT` to choose a different task; there is no automatic
Claude retry loop or turn limit. `JAVA_MEMORY` defaults to `2G`.
`SEED` defaults to `97996358` and `BOT_NAME` to `AI_M1KE`, the winning run's, so
a plain `docker compose up` replays that world; set `SEED` to any other value
for a different world.

`CLAUDE_MODEL` defaults to `claude-opus-5[1m]`, the identifier the winning run
recorded as `requestedModel`; the `[1m]` suffix selects the 1M context window, so
quote the value in a shell. It is passed explicitly to Claude's `--model` flag and
the transcript records the model actually used. To run a different model, set it
alongside the other run parameters, for example Fable 5.1 in WSL/bash:

```sh
EULA=true SEED=-06163879 RUN_DIR=./runs/model-test CLAUDE_MODEL='claude-fable-5-1' docker compose up --abort-on-container-exit
```

Use a model identifier available to your Claude account. Changing this setting
affects the next Claude process, not a session already running.

`CLAUDE_EFFORT` defaults to `high` and is passed to Claude's `--effort` flag
(`low`, `medium`, `high`, `xhigh`, `max`). It is saved as `requestedEffort` in run
metadata so a finished run records the level it used; the transcript does not
report effort on its own. Raising it deepens reasoning and raises token spend:

```sh
EULA=true SEED=-06163879 RUN_DIR=./runs/effort-test CLAUDE_EFFORT=xhigh docker compose up --abort-on-container-exit
```

## Observers

Put Java player names in [observers.json](observers.json), for example:

```json
["YourJavaPlayerName"]
```

The launcher writes `ops.json` with operator level 2 and the correct offline UUIDs,
then issues `gamemode spectator <name>` whenever a listed player joins. These
players briefly join before the console command is processed. The bot remains a
normal survival player and is never given operator access. No datapack is used.
The observer file is authoritative for the operator list on each start.

This initial setup uses offline Minecraft authentication. Names determine offline
UUIDs; Microsoft account UUIDs do not apply.

## Ports and health

Compose publishes both services on the host loopback only:

| Service | Host address | Override |
|---|---|---|
| Minecraft (Direct Connection) | `127.0.0.1:25569` | `MINECRAFT_PORT` |
| MCP endpoint | `http://127.0.0.1:25575/mcp` | `MCP_PORT` |
| Health | `http://127.0.0.1:25575/health` | `MCP_PORT` |

The supervisor listens on all container interfaces, while Compose restricts host
access to loopback. Claude continues to use container localhost. Health database
paths start with `/data/`; on the host, that prefix corresponds to `RUN_DIR`. With
WSL Docker, Windows localhost forwarding depends on your WSL networking
configuration.

## Persistent output

Under `RUN_DIR`:

- `minecraft/world/`: world, Nether, End, and player data.
- `minecraft/logs/` and `minecraft/console-<session>-<attempt>.log`: Minecraft logs.
- `mcp/bot-data/`: SQLite databases and incident captures.
- `mcp/console.log` and `console.log.stderr`: MCP process output.
- `mcp/smoke.log`: smoke test output, when `RUN_MODE=smoke`.
- `claude/projects/`: native Claude Code conversation JSONL files.
- `claude/<session>.<attempt>.stream.jsonl`: Claude's streamed output, with stderr separate.
- `claude/<session>.<attempt>.debug.log`, `.attempt.json`, and `<session>.run.json`: diagnostics and launch inputs.

Claude authentication stays in `private/` by default, outside the run folder.
Set `PRIVATE_DIR` to use another host directory. With WSL Docker, build from the
Windows checkout under `/mnt/c/...` and set both `RUN_DIR` and `PRIVATE_DIR` to
absolute Linux paths such as `/home/<user>/...` to keep runtime data on WSL storage. Do not publish
that directory. Review transcripts/debug logs before sharing them. Existing MCP
incident retention still applies; mounting the directory does not disable pruning.

Claude has no built-in tools (`--tools ""`), loads only this MCP server, and
automatically permits its tools. Slash commands and ordinary settings sources are
disabled. This is tool restriction, not a hardened sandbox against MCP code;
unrestricted MCP JavaScript debug tools are not enabled.

Minecraft tool calls have a one-hour client timeout in [mcp.json](mcp.json), including Claude's idle window. This accommodates long smelting and collection actions; see the [client setup guidance](../README.md#allow-long-minecraft-actions). Rebuild the image to apply changes on the next run; the active run is unaffected.

The versions of Bun, Minecraft, and Claude Code are pinned in the Dockerfile;
base image tags can still move. The Minecraft download is checked against Mojang's
published SHA-1. Capture image digests for a final reproducibility release.

## Freezing a run and publishing

[docker/package.json](package.json) is a reference snapshot of the current root
manifest, not a separate Docker installation manifest. Refresh it from the root
package.json when deliberately updating this candidate. Docker builds continue to
use the root package.json and bun.lock with `bun install --frozen-lockfile`.
Bun's lockfile already records resolved dependencies; this Bun build does not need
an npm package-lock.json.

For the winning run, preserve the exact source, root package.json, bun.lock,
Docker/Compose files, run inputs, and built image digest together before making
further changes. The manifest snapshot alone cannot reproduce a run. Tag the
commit the run was built from and record it with the results; Dockerfile.beatthegame
rebuilds that exact image from the tag without relying on a local checkout.

References: [Claude CLI flags](https://code.claude.com/docs/en/cli-reference),
[Claude conversation storage](https://code.claude.com/docs/en/claude-directory).
