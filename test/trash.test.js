import { test, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// Point the managed trash at a throwaway dir BEFORE importing the module.
const HOME = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-trash-'));
process.env.SKILLSMITH_HOME = HOME;
const { moveToTrash, listTrash, restore, emptyTrash, trashRoot } = await import('../src/trash.js');

// A fresh skill folder living at `dir`, with one file inside.
async function makeFolder(dir, contents = 'hello') {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'SKILL.md'), contents);
}

beforeEach(async () => {
  await fs.rm(trashRoot(), { recursive: true, force: true });
});

test('moveToTrash + restore is a lossless round-trip', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-work-'));
  const dir = path.join(work, '.claude/skills/demo');
  await makeFolder(dir, 'original-body');

  const id = await moveToTrash(dir, { agent: 'claude-code', skill: 'demo' });
  assert.ok(id, 'returns an entry id');
  assert.equal(await exists(dir), false, 'original is gone from its location');

  const entries = await listTrash();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].originalPath, path.resolve(dir));

  const target = await restore(id);
  assert.equal(target, path.resolve(dir));
  assert.equal(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'), 'original-body');
  assert.equal((await listTrash()).length, 0, 'entry consumed on restore');
});

test('moveToTrash returns null when the folder does not exist', async () => {
  assert.equal(await moveToTrash('/no/such/dir', { skill: 'x' }), null);
});

test('trash entry ids contain no Windows-invalid characters', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-work-'));
  const dir = path.join(work, 'demo');
  await makeFolder(dir);
  const id = await moveToTrash(dir, { agent: 'codex', skill: 'demo', now: new Date('2026-06-27T12:34:56.789Z') });
  assert.doesNotMatch(id, /[:<>"|?*]/, 'no characters illegal on Windows');
});

test('restore refuses to clobber an existing target unless forced', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-work-'));
  const dir = path.join(work, 'demo');
  await makeFolder(dir, 'v1');
  const id = await moveToTrash(dir, { skill: 'demo' });

  await makeFolder(dir, 'v2'); // something new took its place
  await assert.rejects(() => restore(id), /already exists/);

  await restore(id, { force: true });
  assert.equal(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'), 'v1');
});

test('emptyTrash --older-than keeps fresh entries and drops stale ones', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-work-'));
  const stale = path.join(work, 'stale');
  const fresh = path.join(work, 'fresh');
  await makeFolder(stale); await makeFolder(fresh);
  await moveToTrash(stale, { skill: 'stale', now: new Date('2026-01-01T00:00:00Z') });
  await moveToTrash(fresh, { skill: 'fresh', now: new Date('2026-06-27T00:00:00Z') });

  const removed = await emptyTrash({ olderThanDays: 30, now: new Date('2026-06-27T00:00:00Z') });
  assert.equal(removed, 1);
  const left = await listTrash();
  assert.equal(left.length, 1);
  assert.equal(left[0].skill, 'fresh');
});

test('EXDEV during rename falls back to copy-then-remove', async () => {
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-work-'));
  const dir = path.join(work, 'demo');
  await makeFolder(dir, 'cross-device');

  const realRename = fs.rename;
  let threw = false;
  mock.method(fs, 'rename', async (...args) => {
    if (!threw) { threw = true; throw Object.assign(new Error('cross-device'), { code: 'EXDEV' }); }
    return realRename(...args);
  });
  try {
    const id = await moveToTrash(dir, { skill: 'demo' });
    assert.ok(id);
    assert.equal(await exists(dir), false);
    const target = await restore(id);
    assert.equal(await fs.readFile(path.join(target, 'SKILL.md'), 'utf8'), 'cross-device');
  } finally {
    mock.restoreAll();
  }
});

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
