import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateSkillName, assertWithin, parseFrontmatter } from '../src/util.js';

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

test('parseFrontmatter reads single-line keys', () => {
  const fm = parseFrontmatter('---\nname: foo\ndescription: short\n---\nbody');
  assert.equal(fm.name, 'foo');
  assert.equal(fm.description, 'short');
});

test('parseFrontmatter folds `>` block scalars into a single space-joined line', () => {
  const fm = parseFrontmatter('---\nname: bar\ndescription: >\n  line one\n  line two\n  line three\n---\nbody');
  assert.equal(fm.name, 'bar');
  assert.equal(fm.description, 'line one line two line three');
});

test('parseFrontmatter joins `|` block scalars with newlines', () => {
  const fm = parseFrontmatter('---\nname: baz\ndescription: |\n  line one\n  line two\n---\nbody');
  assert.equal(fm.name, 'baz');
  assert.equal(fm.description, 'line one\nline two');
});

test('parseFrontmatter returns empty object for missing or malformed frontmatter', () => {
  assert.deepEqual(parseFrontmatter('no frontmatter here'), {});
  assert.deepEqual(parseFrontmatter('---\nname: only-open\nbody without close'), {});
});
