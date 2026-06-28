import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-ihome-'));
process.env.SKILLSMITH_HOME = HOME;
const { addSkills, removeSkills, syncProject } = await import('../src/install.js');
const { skillDest, getAgent } = await import('../src/adapters.js');
const { readLock } = await import('../src/lockfile.js');

const SKILL = 'commit-suggest'; // a real skill bundled in skills/
const agent = getAgent('claude-code');

async function project() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-proj-'));
}
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

test('skillDest rejects traversal/separator names before any fs work', () => {
  const root = '/home/u/proj';
  for (const bad of ['../evil', 'a/b', '..', '/abs']) {
    assert.throws(() => skillDest(root, agent, bad));
  }
  assert.equal(skillDest(root, agent, SKILL), path.join(root, agent.dir, SKILL));
});

test('add writes only inside the agent dir and records the lockfile', async () => {
  const root = await project();
  await addSkills(root, 'claude-code', [SKILL]);

  const dest = path.join(root, agent.dir, SKILL);
  assert.ok(await exists(path.join(dest, 'SKILL.md')), 'skill copied in');

  const lock = await readLock(root);
  assert.equal(lock.agent, 'claude-code');
  assert.ok(lock.skills[SKILL], 'skill recorded in lockfile');

  // Nothing leaked outside .claude/ and the lockfile.
  const top = (await fs.readdir(root)).sort();
  assert.deepEqual(top, ['.claude', '.skillsmith.json']);
});

test('dry-run performs zero mutations', async () => {
  const root = await project();
  await addSkills(root, 'claude-code', [SKILL], { dryRun: true });
  assert.deepEqual(await fs.readdir(root), [], 'no files created');
});

test('remove moves the folder to trash and clears the lockfile entry', async () => {
  const root = await project();
  await addSkills(root, 'claude-code', [SKILL]);
  const { listTrash } = await import('../src/trash.js');
  const before = (await listTrash()).length;

  await removeSkills(root, 'claude-code', [SKILL]);
  assert.equal(await exists(path.join(root, agent.dir, SKILL)), false, 'folder gone from project');
  assert.equal((await readLock(root)).skills[SKILL], undefined, 'lockfile entry dropped');
  assert.equal((await listTrash()).length, before + 1, 'recoverable in trash');
});

test('overwriting an installed skill trashes the previous copy', async () => {
  const root = await project();
  await addSkills(root, 'claude-code', [SKILL]);
  const { listTrash } = await import('../src/trash.js');
  const before = (await listTrash()).length;
  await addSkills(root, 'claude-code', [SKILL]); // re-add → overwrite
  assert.equal((await listTrash()).length, before + 1, 'old copy preserved in trash');
});

test('refuses to operate on a symlinked destination', async () => {
  const root = await project();
  const skillsDir = path.join(root, agent.dir);
  await fs.mkdir(skillsDir, { recursive: true });
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-link-'));
  await fs.symlink(elsewhere, path.join(skillsDir, SKILL));

  await assert.rejects(() => addSkills(root, 'claude-code', [SKILL]), /symlink/);
});

test('sync reproduces the locked skills from a bare lockfile', async () => {
  const root = await project();
  await addSkills(root, 'claude-code', [SKILL]);
  // Wipe the materialised folder, keep only the lockfile (simulates a clone).
  await fs.rm(path.join(root, agent.dir), { recursive: true, force: true });

  await syncProject(root);
  assert.ok(await exists(path.join(root, agent.dir, SKILL, 'SKILL.md')), 'skill re-materialised');
});
