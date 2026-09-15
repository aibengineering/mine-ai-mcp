import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { persistClaudeSession, selectClaudeLaunch } from './session.mjs';

const first = '123e4567-e89b-42d3-a456-426614174000';
const second = '223e4567-e89b-42d3-a456-426614174001';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mine-ai-claude-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'projects', '-play'), { recursive: true });
  return root;
}

async function addRun(root, session, startedAt, transcript = true) {
  await writeFile(join(root, `${session}.run.json`), JSON.stringify({ session, startedAt }));
  if (transcript) await writeFile(join(root, 'projects', '-play', `${session}.jsonl`), '{}\n');
}

test('fresh launch persists one session and ordinary restart resumes it', async (t) => {
  const root = await fixture(t);
  const ids = ['attempt-1', first];
  const fresh = await selectClaudeLaunch({ claudeDir: root, createId: () => ids.shift(), resumeSession: '' });
  assert.deepEqual(fresh, { session: first, attempt: 'attempt-1', mode: 'fresh', persist: true });
  await addRun(root, first, '2026-09-14T00:00:00Z');
  await persistClaudeSession(root, first);
  const restart = await selectClaudeLaunch({ claudeDir: root, createId: () => 'attempt-2', resumeSession: '' });
  assert.deepEqual(restart, { session: first, attempt: 'attempt-2', mode: 'resume', persist: false });
});

test('legacy explicit adoption validates its transcript and persists the pointer', async (t) => {
  const root = await fixture(t);
  await addRun(root, first, '2026-09-13T00:00:00Z');
  await addRun(root, second, '2026-09-14T00:00:00Z', false);
  await assert.rejects(selectClaudeLaunch({ claudeDir: root, createId: () => 'attempt-1', resumeSession: second }), /native Claude conversation JSONL was not found/);
  const adopted = await selectClaudeLaunch({ claudeDir: root, createId: () => 'attempt-2', resumeSession: first });
  assert.equal(adopted.persist, true);
  await persistClaudeSession(root, adopted.session);
  assert.equal(await readFile(join(root, 'current-session'), 'utf8'), `${first}\n`);
});

test('legacy restart adopts only a uniquely newest valid run and smoke consumes neither session nor pointer', async (t) => {
  const root = await fixture(t);
  await addRun(root, first, '2026-09-13T00:00:00Z');
  await addRun(root, second, '2026-09-14T00:00:00Z');
  const legacy = await selectClaudeLaunch({ claudeDir: root, createId: () => 'attempt-1', resumeSession: '' });
  assert.deepEqual(legacy, { session: second, attempt: 'attempt-1', mode: 'resume', persist: true });
  const smoke = await selectClaudeLaunch({ claudeDir: root, createId: () => 'attempt-smoke', resumeSession: first, runMode: 'smoke' });
  assert.deepEqual(smoke, { session: 'smoke', attempt: 'attempt-smoke', mode: 'smoke', persist: false });
  await assert.rejects(readFile(join(root, 'current-session')), /ENOENT/);
});
