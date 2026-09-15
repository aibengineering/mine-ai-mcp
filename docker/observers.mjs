import { spawn } from 'node:child_process';
import { readFile, appendFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';

const observers = JSON.parse(await readFile('/config/observers.json', 'utf8'));
// Follow the Java console without owning the Java process itself.
const tail = spawn('tail', ['-n', '0', '-F', process.env.MINECRAFT_LOG]);
process.once('SIGTERM', () => tail.kill());
process.once('SIGINT', () => tail.kill());
for await (const line of createInterface({ input: tail.stdout })) {
  const name = line.match(/: ([A-Za-z0-9_]{1,16}) joined the game\s*$/)?.[1];
  if (name && observers.includes(name)) await appendFile('/tmp/minecraft-input', `gamemode spectator ${name}\n`);
}
