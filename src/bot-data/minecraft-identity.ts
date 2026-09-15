export interface MinecraftBotDataIdentity {
  /** Stable for one logical server world, independent of its current dimension. */
  readonly worldId: string;
  /** The player UUID assigned by the connected server. */
  readonly botId: string;
}

interface ConnectedMinecraftIdentityInput {
  readonly host: string;
  readonly port: number;
  readonly playerUuid: string | undefined;
  readonly loginPacket: unknown;
}

/** Derive storage identity only from facts supplied by the live server connection. */
export function deriveMinecraftBotDataIdentity(input: ConnectedMinecraftIdentityInput): MinecraftBotDataIdentity {
  const host = input.host.trim().toLowerCase();
  if (!host) throw new Error("Minecraft server host is required to identify bot data.");
  if (!Number.isInteger(input.port) || input.port <= 0 || input.port > 65_535) {
    throw new Error("Minecraft server port must identify a valid TCP port.");
  }

  const botId = input.playerUuid?.trim().toLowerCase();
  if (!botId) throw new Error("Minecraft did not supply a player UUID for bot data.");

  const worldState = record(record(input.loginPacket)?.worldState) ?? record(input.loginPacket);
  const seedHash = signedLong(worldState?.hashedSeed);
  if (seedHash === null) throw new Error("Minecraft login did not supply the world's hashed seed for bot data.");

  return {
    worldId: JSON.stringify({ server: { host, port: input.port }, seedHash }),
    botId,
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

/** Normalize ProtoDef's signed-long array and native scalar representations. */
function signedLong(value: unknown): string | null {
  if (typeof value === "bigint") return BigInt.asIntN(64, value).toString();
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value).toString();
  if (typeof value === "string" && /^-?\d+$/.test(value)) return BigInt.asIntN(64, BigInt(value)).toString();
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((part) => typeof part === "number" && Number.isInteger(part))
  ) {
    const [high, low] = value as [number, number];
    return BigInt.asIntN(64, (BigInt(high) << 32n) | BigInt.asUintN(32, BigInt(low))).toString();
  }
  return null;
}
