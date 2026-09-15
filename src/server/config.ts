import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import type mineflayer from "mineflayer";
import type { BotDataScopeKind, BotDataStorage } from "../bot-data/index.js";
import { DEFAULT_INCIDENT_RETENTION, type IncidentRetention } from "../bot-data/incident-log.js";

type Auth = NonNullable<Parameters<typeof mineflayer.createBot>[0]["auth"]>;

const AUTH_MODES = ["offline", "microsoft"] as const satisfies readonly Auth[];
const BOT_DATA_PERSISTENCE_MODES = ["persistent", "temporary"] as const satisfies readonly BotDataStorage["kind"][];
const BOT_DATA_SCOPE_KINDS = ["bot", "shared"] as const satisfies readonly BotDataScopeKind[];

export const DEFAULT_DATA_ROOT = path.join(os.homedir(), ".mine-ai", "bot-data");

export interface HostOptions {
  readonly incidentRetention: IncidentRetention;
  readonly instanceId: string;
  readonly listenHost: string;
  readonly listenPort: number;
  readonly minecraftHost: string;
  readonly minecraftPort: number;
  readonly username: string;
  readonly auth: Auth;
  readonly version: string;
  readonly connectTimeoutMs: number;
  readonly debugExecuteJavaScript: boolean;
  readonly botData: {
    readonly storage: BotDataStorage;
    readonly scope: BotDataScopeKind;
  };
}

export function parseHostOptions(args: readonly string[] = process.argv.slice(2)): HostOptions {
  const { values } = parseArgs({
    args,
    options: {
      "trace-retention-days": { type: "string", default: String(DEFAULT_INCIDENT_RETENTION.days) },
      "trace-max-bytes": { type: "string", default: String(DEFAULT_INCIDENT_RETENTION.maxBytes) },
      "instance-id": { type: "string", default: "minecraft" },
      "listen-host": { type: "string", default: "127.0.0.1" },
      "listen-port": { type: "string", default: "25575" },
      "minecraft-host": { type: "string", default: "127.0.0.1" },
      "minecraft-port": { type: "string", default: "25566" },
      username: { type: "string", default: "MineAI" },
      auth: { type: "string", default: "offline" },
      version: { type: "string", default: "1.21.4" },
      "connect-timeout-ms": { type: "string", default: "45000" },
      "debug-execute-javascript": { type: "boolean", default: false },
      "data-root": { type: "string", default: DEFAULT_DATA_ROOT },
      "bot-data-persistence": { type: "string", default: "persistent" },
      "bot-data-scope": { type: "string", default: "bot" },
    },
  });

  const botDataPersistence = choiceArgument(
    "--bot-data-persistence",
    values["bot-data-persistence"],
    BOT_DATA_PERSISTENCE_MODES,
  );

  return {
    incidentRetention: {
      days: positiveInteger("--trace-retention-days", values["trace-retention-days"]),
      maxBytes: positiveInteger("--trace-max-bytes", values["trace-max-bytes"]),
    },
    instanceId: values["instance-id"],
    listenHost: values["listen-host"],
    listenPort: positiveInteger("--listen-port", values["listen-port"]),
    minecraftHost: values["minecraft-host"],
    minecraftPort: positiveInteger("--minecraft-port", values["minecraft-port"]),
    username: values.username,
    auth: choiceArgument("--auth", values.auth, AUTH_MODES),
    version: values.version,
    connectTimeoutMs: positiveInteger("--connect-timeout-ms", values["connect-timeout-ms"]),
    debugExecuteJavaScript: values["debug-execute-javascript"],
    botData: {
      storage:
        botDataPersistence === "temporary"
          ? { kind: "temporary" }
          : { kind: "persistent", root: path.resolve(values["data-root"]) },
      scope: choiceArgument("--bot-data-scope", values["bot-data-scope"], BOT_DATA_SCOPE_KINDS),
    },
  };
}

function positiveInteger(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

/** Narrow an argument to one of its allowed values, so no caller has to assert it later. */
function choiceArgument<Choice extends string>(name: string, value: string, choices: readonly Choice[]): Choice {
  const choice = choices.find((candidate) => candidate === value);
  if (!choice) {
    throw new Error(`${name} must be one of ${choices.join(", ")}; received ${JSON.stringify(value)}.`);
  }
  return choice;
}
