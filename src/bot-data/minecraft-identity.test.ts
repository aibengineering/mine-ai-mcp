import assert from "node:assert/strict";
import test from "node:test";
import { deriveMinecraftBotDataIdentity } from "./minecraft-identity.js";

test("derives world and bot identities from the connected server", () => {
  const identity = deriveMinecraftBotDataIdentity({
    host: "Server.Example",
    port: 25_565,
    playerUuid: "A0B1-C2D3",
    loginPacket: { worldState: { name: "minecraft:overworld", hashedSeed: [-1, -2] } },
  });

  assert.deepEqual(identity, {
    worldId: JSON.stringify({ server: { host: "server.example", port: 25_565 }, seedHash: "-2" }),
    botId: "a0b1-c2d3",
  });
});

test("the dimension is not part of a world identity but its seed is", () => {
  const connected = (name: string, hashedSeed = 42n) =>
    deriveMinecraftBotDataIdentity({
      host: "127.0.0.1",
      port: 25_566,
      playerUuid: "bot-uuid",
      loginPacket: { worldState: { name, hashedSeed } },
    }).worldId;

  assert.equal(connected("minecraft:overworld"), connected("minecraft:the_nether"));
  assert.notEqual(connected("minecraft:overworld"), connected("minecraft:overworld", 43n));
});

test("rejects a connection that did not provide identity facts", () => {
  assert.throws(
    () =>
      deriveMinecraftBotDataIdentity({
        host: "127.0.0.1",
        port: 25_566,
        playerUuid: undefined,
        loginPacket: {},
      }),
    /player UUID/,
  );
  assert.throws(
    () =>
      deriveMinecraftBotDataIdentity({
        host: "127.0.0.1",
        port: 25_566,
        playerUuid: "bot-uuid",
        loginPacket: {},
      }),
    /hashed seed/,
  );
});
