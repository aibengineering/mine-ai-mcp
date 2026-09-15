import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, symlink, lstat, readlink } from 'node:fs/promises';
import { persistClaudeSession, selectClaudeLaunch } from './session.mjs';
const config = process.env.CLAUDE_CONFIG_DIR;
if (process.env.EULA?.toLowerCase() !== 'true') throw new Error('Set EULA=true after accepting https://aka.ms/MinecraftEULA');
const bot = process.env.BOT_NAME ?? 'MineAI';
const validName = name => typeof name === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(name);
if (!validName(bot)) throw new Error('BOT_NAME must be a Minecraft Java player name');
const observers = JSON.parse(await readFile('/config/observers.json', 'utf8'));
if (!Array.isArray(observers) || observers.some(name => !validName(name) || name === bot)) {
  throw new Error('observers.json must be an array of Java player names, excluding the bot');
}
const memory = process.env.JAVA_MEMORY ?? '2G';
if (!/^\d+[MG]$/.test(memory)) throw new Error('JAVA_MEMORY must be a value such as 2G');
const seed = process.env.SEED ?? '';
if (/[\r\n\\]/.test(seed)) throw new Error('SEED must be a single plain-text value');
for (const dir of ['minecraft', 'mcp', 'claude/projects']) await mkdir(`/data/${dir}`, { recursive: true });
const projects = `${config}/projects`;
const existing = await lstat(projects).catch(error => { if (error.code !== 'ENOENT') throw error; });
if (!existing) await symlink('/data/claude/projects', projects);
else if (!existing.isSymbolicLink() || await readlink(projects) !== '/data/claude/projects') {
  throw new Error(`Use a dedicated private directory: ${projects} must point to /data/claude/projects`);
}
await writeFile('/data/minecraft/eula.txt', 'eula=true\n');
await writeFile('/data/minecraft/server.properties', [
  'online-mode=false', 'server-port=25565', 'gamemode=survival', 'difficulty=normal',
  'level-name=world', `level-seed=${seed}`, 'spawn-protection=0', 'enable-rcon=false',
  'view-distance=10', 'simulation-distance=10', 'motd=Mine AI MCP local run', '',
].join('\n'));
// Offline-mode identities are Java's nameUUIDFromBytes("OfflinePlayer:" + name).
const ops = observers.map(name => {
  const bytes = createHash('md5').update(`OfflinePlayer:${name}`).digest();
  bytes[6] = (bytes[6] & 15) | 48;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = bytes.toString('hex');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return { uuid, name, level: 2, bypassesPlayerLimit: false };
});
await writeFile('/data/minecraft/ops.json', JSON.stringify(ops, null, 2));
const launch = await selectClaudeLaunch({
  claudeDir: '/data/claude', resumeSession: process.env.CLAUDE_RESUME_SESSION, createId: randomUUID,
  runMode: process.env.RUN_MODE,
});
const metadata = {
  ...launch, bot, observers, requestedSeed: seed, requestedModel: process.env.CLAUDE_MODEL,
  requestedEffort: process.env.CLAUDE_EFFORT || 'high', startedAt: new Date().toISOString(),
  minecraft: JSON.parse(await readFile('/opt/server-source.json', 'utf8')),
};
if (launch.mode === 'fresh') {
  await writeFile(`/data/claude/${launch.session}.run.json`, JSON.stringify({
    ...metadata, prompt: process.env.PROMPT,
  }, null, 2));
} else if (launch.mode === 'resume') {
  await writeFile(`/data/claude/${launch.session}.${launch.attempt}.attempt.json`, JSON.stringify({
    ...metadata, resumePrompt: process.env.CLAUDE_RESUME_PROMPT,
  }, null, 2));
}
if (launch.persist) await persistClaudeSession('/data/claude', launch.session);
console.log(`${launch.session}\t${launch.attempt}\t${launch.mode}`);
