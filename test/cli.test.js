// Integration tests that drive the real CLI as a subprocess. Because stdio is
// piped (not a TTY), these also exercise the non-interactive guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/cli.js');
const SKILL = 'commit-suggest';

async function project() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'skillsmith-cli-'));
}
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
function run(args, { cwd, home }) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    env: { ...process.env, SKILLSMITH_HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
  });
}

test('help exits cleanly and mentions the safety model', async () => {
  const home = await project();
  const r = run(['help'], { cwd: home, home });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /\.skillsmith\/trash/);
});

test('--dry-run changes nothing on disk', async () => {
  const cwd = await project();
  const home = await project();
  const r = run(['add', SKILL, '--dry-run'], { cwd, home });
  assert.equal(r.status, 0);
  assert.deepEqual(await fs.readdir(cwd), [], 'no files written');
});

test('non-interactive remove without --yes refuses and changes nothing', async () => {
  const cwd = await project();
  const home = await project();
  assert.equal(run(['add', SKILL], { cwd, home }).status, 0); // project-local add: no prompt

  const r = run(['remove', SKILL], { cwd, home });
  assert.equal(r.status, 1, 'aborts');
  assert.match(r.stderr, /non-interactively/);
  assert.ok(await exists(path.join(cwd, '.claude/skills', SKILL)), 'skill still present');
});

test('global add without --yes refuses non-interactively', async () => {
  const cwd = await project();
  const home = await project();
  const r = run(['add', SKILL, '--global'], { cwd, home });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /non-interactively/);
});

test('remove --yes trashes the skill and restore --last brings it back', async () => {
  const cwd = await project();
  const home = await project();
  assert.equal(run(['add', SKILL], { cwd, home }).status, 0);

  const rm = run(['remove', SKILL, '--yes'], { cwd, home });
  assert.equal(rm.status, 0);
  assert.equal(await exists(path.join(cwd, '.claude/skills', SKILL)), false);

  const restore = run(['restore', '--last'], { cwd, home });
  assert.equal(restore.status, 0);
  assert.ok(await exists(path.join(cwd, '.claude/skills', SKILL, 'SKILL.md')), 'restored');
});
