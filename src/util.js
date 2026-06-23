// Small shared helpers — zero runtime dependencies.
import fs from 'node:fs/promises';
import path from 'node:path';
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

export async function readJson(p, fallback = null) {
  try { return JSON.parse(await fs.readFile(p, 'utf8')); }
  catch { return fallback; }
}

export async function writeJson(p, obj) {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2) + '\n');
}

// Minimal YAML frontmatter reader — only needs the flat keys we use.
export function parseFrontmatter(content) {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
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
