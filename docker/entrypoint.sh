#!/usr/bin/env bash
set -euo pipefail
cd /opt/mine-ai-mcp
mkdir -p "$CLAUDE_CONFIG_DIR"
if [[ "${RUN_MODE:-play}" == login ]]; then exec claude auth login; fi
launch=$(bun docker/prepare.mjs)
IFS=$'\t' read -r session attempt claude_mode <<<"$launch"
[[ -n "$session" && -n "$attempt" && -n "$claude_mode" ]] || { echo 'Docker preparation returned an invalid launch identity' >&2; exit 1; }
export MINECRAFT_LOG="/data/minecraft/console-$session-$attempt.log"

java_pid= mcp_pid= observer_pid= claude_pid=
cleanup() {
  trap - EXIT INT TERM
  # Stop the agent and bot before asking Minecraft to save its world.
  for pid in "$claude_pid" "$mcp_pid" "$observer_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      (sleep 10; kill -KILL "$pid" 2>/dev/null || true) &
      watchdog=$!
      wait "$pid" 2>/dev/null || true
      kill "$watchdog" 2>/dev/null || true
      wait "$watchdog" 2>/dev/null || true
    fi
  done
  if [[ -n "$java_pid" ]] && kill -0 "$java_pid" 2>/dev/null; then
    printf 'stop\n' >&3
    # Protect Docker's 90-second stop window if Java is wedged while saving.
    (sleep 60; kill -KILL "$java_pid" 2>/dev/null || true) &
    watchdog=$!
    wait "$java_pid" || true
    kill "$watchdog" 2>/dev/null || true
    wait "$watchdog" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

[[ -p /tmp/minecraft-input ]] || mkfifo /tmp/minecraft-input
exec 3<>/tmp/minecraft-input
cd /data/minecraft
touch "$MINECRAFT_LOG"
java "-Xmx${JAVA_MEMORY:-2G}" -jar /opt/server.jar nogui <&3 >"$MINECRAFT_LOG" 2>"$MINECRAFT_LOG.stderr" &
java_pid=$!
cd /opt/mine-ai-mcp
bun docker/observers.mjs &
observer_pid=$!
# Startup has a three-minute deadline; gameplay has no time limit.
for ((i=0; i<180; i++)); do
  kill -0 "$java_pid" || exit 1
  if grep -q 'Done (' "$MINECRAFT_LOG"; then break; fi
  sleep 1
done
grep -q 'Done (' "$MINECRAFT_LOG" || { echo 'Minecraft startup failed; see console.log'; exit 1; }

bun src/server/host.ts --minecraft-port 25565 --version "$MINECRAFT_VERSION" \
  --username "${BOT_NAME:-MineAI}" --listen-host 0.0.0.0 --listen-port 25575 \
  --data-root /data/mcp/bot-data >>/data/mcp/console.log 2>>/data/mcp/console.log.stderr &
mcp_pid=$!
for ((i=0; i<180; i++)); do
  kill -0 "$java_pid" && kill -0 "$mcp_pid" || exit 1
  if curl -fsS --max-time 1 http://127.0.0.1:25575/health >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS --max-time 1 http://127.0.0.1:25575/health >/data/mcp/startup-health.json
if [[ "${RUN_MODE:-play}" == smoke ]]; then bun docker/smoke.mjs 2>&1 | tee /data/mcp/smoke.log; exit "${PIPESTATUS[0]}"; fi

cd /play
claude_args=(--print "$PROMPT" --session-id "$session")
if [[ "$claude_mode" == resume ]]; then
  claude_args=(--print "${CLAUDE_RESUME_PROMPT:-Continue the existing Minecraft task from the current world state. First inspect current status and reconcile any tool call interrupted by the restart; do not assume that interrupted work completed.}" --resume "$session")
fi
echo "Running Claude Code ($claude_mode attempt $attempt). Transcript: /data/claude/$session.$attempt.stream.jsonl"
claude "${claude_args[@]}" --model "$CLAUDE_MODEL" --effort "${CLAUDE_EFFORT:-high}" \
  --tools '' --allowedTools 'mcp__minecraft__*' \
  --strict-mcp-config --mcp-config /opt/mine-ai-mcp/docker/mcp.json \
  --setting-sources '' --disable-slash-commands --permission-mode dontAsk \
  --output-format stream-json --verbose --include-partial-messages \
  --debug-file "/data/claude/$session.$attempt.debug.log" \
  >"/data/claude/$session.$attempt.stream.jsonl" 2>"/data/claude/$session.$attempt.stderr.log" &
claude_pid=$!
# A crashed service ends the run instead of leaving Claude talking to a dead host.
status=0
wait -n "$java_pid" "$mcp_pid" "$observer_pid" "$claude_pid" || status=$?
if kill -0 "$claude_pid" 2>/dev/null; then status=1; fi
exit "$status"
