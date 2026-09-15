import { access, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POINTER = 'current-session';

async function hasConversation(root, session) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries.some(entry => entry.isFile() && basename(entry.name) === `${session}.jsonl`);
}

async function validateResume(claudeDir, session) {
  if (!UUID.test(session)) throw new Error('Claude resume identity must be an exact session UUID');
  const runPath = join(claudeDir, `${session}.run.json`);
  await access(runPath).catch(() => {
    throw new Error(`Cannot resume Claude session ${session}: ${runPath} does not exist`);
  });
  const run = JSON.parse(await readFile(runPath, 'utf8'));
  if (run.session !== session)
    throw new Error(`Cannot resume Claude session ${session}: its run record has a different session identity`);
  if (!await hasConversation(join(claudeDir, 'projects'), session))
    throw new Error(`Cannot resume Claude session ${session}: native Claude conversation JSONL was not found`);
}

async function legacySession(claudeDir) {
  const names = (await readdir(claudeDir)).filter(name => name.endsWith('.run.json'));
  if (names.length === 0) return null;
  const runs = await Promise.all(names.map(async name => {
    const run = JSON.parse(await readFile(join(claudeDir, name), 'utf8'));
    const at = Date.parse(run.startedAt);
    if (!UUID.test(run.session) || !Number.isFinite(at))
      throw new Error(`Cannot adopt legacy Claude run ${name}: invalid session or startedAt metadata`);
    return { session: run.session, at };
  }));
  runs.sort((a, b) => b.at - a.at);
  if (runs.length > 1 && runs[0].at === runs[1].at)
    throw new Error('Legacy Claude runs have no unique newest session; set CLAUDE_RESUME_SESSION to adopt the intended UUID');
  return runs[0].session;
}

/** Select one durable Claude conversation before any gameplay service starts. */
export async function selectClaudeLaunch({ claudeDir, resumeSession, createId, runMode = 'play' }) {
  const attempt = createId();
  if (runMode === 'smoke') return { session: 'smoke', attempt, mode: 'smoke', persist: false };
  const pointerPath = join(claudeDir, POINTER);
  const pointed = await readFile(pointerPath, 'utf8').then(value => value.trim()).catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  const selected = resumeSession || pointed || await legacySession(claudeDir);
  if (selected) {
    await validateResume(claudeDir, selected);
    return { session: selected, attempt, mode: 'resume', persist: selected !== pointed };
  }
  return { session: createId(), attempt, mode: 'fresh', persist: true };
}

export async function persistClaudeSession(claudeDir, session) {
  const pending = join(claudeDir, `${POINTER}.tmp`);
  await writeFile(pending, `${session}\n`);
  await rename(pending, join(claudeDir, POINTER));
}
