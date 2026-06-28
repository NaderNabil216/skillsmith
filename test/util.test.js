import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateSkillName, assertWithin } from '../src/util.js';

test('validateSkillName accepts conservative names', () => {
  for (const ok of ['commit-suggest', 'process_pr_comments', 'a', 'skill123']) {
    assert.equal(validateSkillName(ok), ok);
  }
});

test('validateSkillName rejects traversal and separators', () => {
  for (const bad of ['../etc', '..', 'a/b', 'a\\b', '/abs', '.hidden', 'Upper', 'has space', '']) {
    assert.throws(() => validateSkillName(bad), /Invalid skill name/);
  }
});

test('assertWithin allows paths inside the root', () => {
  const root = '/home/u/proj';
  const dest = path.join(root, '.claude/skills/commit-suggest');
  assert.equal(assertWithin(root, dest), dest);
});

test('assertWithin rejects escapes and the root itself', () => {
  const root = '/home/u/proj';
  assert.throws(() => assertWithin(root, path.join(root, '../../etc/passwd')), /outside/);
  assert.throws(() => assertWithin(root, '/etc/passwd'), /outside/);
  assert.throws(() => assertWithin(root, root), /outside/);
});
