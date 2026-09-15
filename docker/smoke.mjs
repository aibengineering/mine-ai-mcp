import mineflayer from 'mineflayer';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const client = new Client({ name: 'container-smoke', version: '1.0.0' });
try {
  await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:25575/mcp')));
  const tools = await client.listTools();
  const status = await client.callTool({ name: 'view_status', arguments: { rationale: 'Verify the fresh container installation.' } });
  if (status.isError) throw new Error(JSON.stringify(status));
  let observer;
  const names = JSON.parse(await readFile('/config/observers.json', 'utf8'));
  if (names.length) {
    const viewer = mineflayer.createBot({ host: '127.0.0.1', port: 25565, username: names[0], version: process.env.MINECRAFT_VERSION });
    try {
      const deadline = Date.now() + 15000;
      let failure;
      viewer.on('error', error => { failure = error; });
      while (viewer.game?.gameMode !== 'spectator') {
        if (failure) throw failure;
        if (Date.now() >= deadline) throw new Error('Observer did not enter spectator mode within 15 seconds');
        await delay(100);
      }
      const ops = JSON.parse(await readFile('/data/minecraft/ops.json', 'utf8'));
      if (!ops.some(op => op.uuid === viewer.player.uuid && op.level === 2)) throw new Error('Observer operator UUID mismatch');
      observer = { name: viewer.username, uuid: viewer.player.uuid, gameMode: viewer.game.gameMode };
    } finally { viewer.quit(); }
  }
  await writeFile('/data/smoke.json', JSON.stringify({ observer, tools: tools.tools.map(t => t.name), status }, null, 2));
  console.log('Container MCP smoke test passed');
} finally { await client.close(); }
