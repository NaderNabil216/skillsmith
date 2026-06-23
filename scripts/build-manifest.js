#!/usr/bin/env node
// Generates manifest.json by scanning skills/. Run via `npm run build`.
// Adding a skill = drop a folder with a SKILL.md; no manual registry editing.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseFrontmatter } from '../src/util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS_DIR = path.join(ROOT, 'skills');

async function walk(dir, base = dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full));
  }
  return out.sort();
}

async function hashFolder(dir, files) {
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    h.update(rel);
    h.update(await fs.readFile(path.join(dir, rel)));
  }
  return h.digest('hex').slice(0, 8);
}

async function main() {
  const pkg = JSON.parse(await fs.readFile(path.join(ROOT, 'package.json'), 'utf8'));
  const entries = await fs.readdir(SKILLS_DIR, { withFileTypes: true });
  const skills = [];

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(SKILLS_DIR, e.name);
    const skillMd = path.join(dir, 'SKILL.md');
    let fm = {};
    try { fm = parseFrontmatter(await fs.readFile(skillMd, 'utf8')); }
    catch { console.warn(`! skipping ${e.name}: no SKILL.md`); continue; }

    if (fm.name && fm.name !== e.name) {
      console.warn(`! ${e.name}: frontmatter name "${fm.name}" != folder name`);
    }
    const files = await walk(dir);
    skills.push({
      name: e.name,
      description: fm.description || '',
      version: await hashFolder(dir, files),
      files,
    });
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  const manifest = { name: pkg.name, version: pkg.version, skills };
  await fs.writeFile(path.join(ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Wrote manifest.json: ${skills.length} skill(s) at catalog v${pkg.version}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
