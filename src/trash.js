// Managed trash — reversible deletes, with zero runtime dependencies.
//
// Instead of permanently removing a skill folder, skillsmith moves it into a
// self-managed trash directory (~/.skillsmith/trash by default) alongside a
// small meta.json that records where it came from. `restore` puts it back.
//
// This is deliberately NOT the OS-native trash (macOS Trash / Linux freedesktop
// / Windows Recycle Bin): reaching the Recycle Bin from Node requires a native
// or third-party package, which would reintroduce the supply-chain surface we
// are trying to avoid. A self-managed directory behaves identically on macOS,
// Windows and Linux and is trivial to test.
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathExists } from './util.js';

// Base dir for skillsmith state. Overridable via SKILLSMITH_HOME (used by tests
// so they never touch the real home directory).
export function skillsmithHome() {
  return process.env.SKILLSMITH_HOME || path.join(os.homedir(), '.skillsmith');
}

export function trashRoot() {
  return path.join(skillsmithHome(), 'trash');
}

// Filesystem-safe timestamp: ISO has ':' and '.', both invalid on Windows.
function stamp(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

// Move a directory, falling back to copy-then-remove across filesystems.
async function moveDir(src, dest) {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  try {
    await fs.rename(src, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e; // different volume — rename can't cross it
    await fs.cp(src, dest, { recursive: true });
    await fs.rm(src, { recursive: true, force: true });
  }
}

// Move `dir` into the trash, recording its origin. Returns the entry id, or
// null if `dir` does not exist (nothing to trash).
export async function moveToTrash(dir, { agent, skill, now = new Date() } = {}) {
  if (!(await pathExists(dir))) return null;
  const label = skill || path.basename(dir);
  const id = `${stamp(now)}__${agent || 'unknown'}__${label}`;
  const entryDir = path.join(trashRoot(), id);
  await fs.mkdir(entryDir, { recursive: true });
  await moveDir(dir, path.join(entryDir, 'data'));
  const meta = {
    id,
    originalPath: path.resolve(dir),
    agent: agent || null,
    skill: skill || null,
    trashedAt: now.toISOString(),
  };
  await fs.writeFile(path.join(entryDir, 'meta.json'), JSON.stringify(meta, null, 2) + '\n');
  return id;
}

// All trash entries, newest first. Malformed entries are skipped.
export async function listTrash() {
  const root = trashRoot();
  if (!(await pathExists(root))) return [];
  const out = [];
  for (const name of await fs.readdir(root)) {
    try {
      out.push(JSON.parse(await fs.readFile(path.join(root, name, 'meta.json'), 'utf8')));
    } catch { /* not a valid entry — ignore */ }
  }
  out.sort((a, b) => String(b.trashedAt).localeCompare(String(a.trashedAt)));
  return out;
}

// Restore a trashed entry to its original path. Refuses to overwrite an existing
// target unless `force` is set.
export async function restore(id, { force = false } = {}) {
  const entryDir = path.join(trashRoot(), id);
  let meta;
  try {
    meta = JSON.parse(await fs.readFile(path.join(entryDir, 'meta.json'), 'utf8'));
  } catch {
    throw new Error(`No trash entry "${id}". See \`skillsmith restore\` for the list.`);
  }
  const target = meta.originalPath;
  if (await pathExists(target)) {
    if (!force) {
      throw new Error(`Target already exists: ${target}. Re-run with --force to overwrite it.`);
    }
    await fs.rm(target, { recursive: true, force: true });
  }
  await moveDir(path.join(entryDir, 'data'), target);
  await fs.rm(entryDir, { recursive: true, force: true });
  return target;
}

// Delete trash entries. With `olderThanDays`, only entries older than the cutoff
// are removed. Returns the number of entries removed.
export async function emptyTrash({ olderThanDays = null, now = new Date() } = {}) {
  const root = trashRoot();
  if (!(await pathExists(root))) return 0;
  const cutoff = olderThanDays != null ? now.getTime() - olderThanDays * 86_400_000 : null;
  let removed = 0;
  for (const name of await fs.readdir(root)) {
    const entryDir = path.join(root, name);
    if (cutoff != null) {
      try {
        const meta = JSON.parse(await fs.readFile(path.join(entryDir, 'meta.json'), 'utf8'));
        if (new Date(meta.trashedAt).getTime() >= cutoff) continue; // still fresh — keep
      } catch { /* malformed — fall through and remove it */ }
    }
    await fs.rm(entryDir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}

// Quiet housekeeping: drop entries older than `days`. Best-effort.
export async function pruneTrash(days = 30, now = new Date()) {
  try { return await emptyTrash({ olderThanDays: days, now }); }
  catch { return 0; }
}
