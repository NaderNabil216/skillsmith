// Small shared helpers — zero runtime dependencies.
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// Package root = one level up from /src
export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SKILLS_DIR = path.join(PKG_ROOT, 'skills');
export const MANIFEST_PATH = path.join(PKG_ROOT, 'manifest.json');

const COLORS = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c, s) => (useColor ? COLORS[c] + s + COLORS.reset : s);

export const log = {
  info: (m) => console.log(m),
  ok: (m) => console.log(`${paint('green', '✓')} ${m}`),
  warn: (m) => console.log(`${paint('yellow', '!')} ${m}`),
  err: (m) => console.error(`${paint('red', '✗')} ${m}`),
  dim: (m) => console.log(paint('dim', m)),
};
export const c = { ...COLORS, paint };

export async function pathExists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

// True only if `p` is itself a symlink (not following it). Used to refuse
// operating on symlinked destinations that could point outside our tree.
export async function isSymlink(p) {
  try { return (await fs.lstat(p)).isSymbolicLink(); } catch { return false; }
}

// Skill names become path segments, so keep them to a conservative charset:
// no separators, no traversal, no leading dot. Throws on anything else.
export function validateSkillName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error(
      `Invalid skill name "${name}". Use lowercase letters, digits, "-" or "_".`
    );
  }
  return name;
}

// Guard: assert that `child` resolves to a location strictly inside `root`.
// Catches path traversal (../) and absolute escapes before any fs mutation.
export function assertWithin(root, child) {
  const rel = path.relative(path.resolve(root), path.resolve(child));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to operate outside the target directory: ${child}`);
  }
  return child;
}

// Whether we can prompt the user (both stdin and stdout are a terminal).
export function isInteractive() {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Yes/no prompt. Resolves to a boolean; honours an empty-answer default.
export async function confirm(question, { defaultYes = false } = {}) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = await new Promise((res) => rl.question(`${question} ${suffix} `, res));
    const a = answer.trim().toLowerCase();
    if (!a) return defaultYes;
    return a === 'y' || a === 'yes';
  } finally {
    rl.close();
  }
}

export async function readJson(p, fallback = null) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return fallback; }
}

export async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n');
}

// Minimal YAML frontmatter reader — only needs the flat keys we use.
// Supports single-line values and folded/literal block scalars (`>` / `|`)
// where indented continuation lines join the previous key.
export function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  let currentKey = null;
  let blockScalar = null; // '>' or '|'
  for (const line of lines) {
    if (blockScalar && currentKey && /^\s+\S/.test(line)) {
      const piece = line.trim();
      out[currentKey] = blockScalar === '>'
        ? (out[currentKey] ? out[currentKey] + ' ' + piece : piece)
        : (out[currentKey] ? out[currentKey] + '\n' + piece : piece);
      continue;
    }
    blockScalar = null;
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!kv) {
      currentKey = null;
      continue;
    }
    currentKey = kv[1];
    let value = kv[2].trim();
    if (value === '>' || value === '|') {
      blockScalar = value;
      out[currentKey] = '';
    } else {
      out[currentKey] = value.replace(/^["']|["']$/g, '').trim();
    }
  }
  return out;
}

// Compare two semver-ish strings. Returns 1 if a>b, -1 if a<b, 0 if equal.
export function compareVersions(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}
