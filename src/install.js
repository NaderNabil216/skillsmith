// Core install/remove/sync logic shared by the CLI commands.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadManifest, getSkill, skillSourceDir } from './catalog.js';
import { getAgent, skillDest, writeIndex } from './adapters.js';
import { log, pathExists, isSymlink } from './util.js';
import { moveToTrash, pruneTrash } from './trash.js';

// Remove an existing destination *reversibly*: refuse symlinks, then move it to
// the managed trash so it can be restored. No-op when nothing is there.
async function trashExisting(projectRoot, dest, agentId, name, opts) {
  if (await isSymlink(dest)) {
    throw new Error(
      `Refusing to touch "${path.relative(projectRoot, dest)}": it is a symlink.`
    );
  }
  if (!(await pathExists(dest))) return;
  if (opts.dryRun) {
    log.dim(`  would move existing ${path.relative(projectRoot, dest)} → trash`);
    return;
  }
  const id = await moveToTrash(dest, { agent: agentId, skill: name });
  if (id) log.dim(`  moved existing ${name} → trash (${id})`);
}

// Copy one skill's folder from the bundled catalog into the agent's skills dir.
async function copySkill(projectRoot, agentId, agent, name, opts) {
  const dest = skillDest(projectRoot, agent, name); // validates name + containment
  const src = skillSourceDir(name);
  if (!(await pathExists(src))) {
    throw new Error(`Skill "${name}" is not in the catalog.`);
  }
  const rel = path.relative(projectRoot, dest);
  await trashExisting(projectRoot, dest, agentId, name, opts);
  if (opts.dryRun) {
    log.dim(`  would copy ${name} → ${rel}`);
    return rel;
  }
  await fs.cp(src, dest, { recursive: true });
  return rel;
}

// Rebuild the agent's managed index (AGENTS.md / GEMINI.md) from the lockfile.
async function refreshIndex(projectRoot, agent, lock, manifest) {
  const installed = Object.keys(lock.skills)
    .map((n) => manifest.skills.find((s) => s.name === n))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
  await writeIndex(projectRoot, agent, installed);
}

// Add (or refresh) a set of skills, recording them in the lockfile.
export async function addSkills(projectRoot, agentId, names, opts = {}) {
  const manifest = await loadManifest();
  const agent = getAgent(agentId);
  return _mutate(projectRoot, agentId, async (lock) => {
    for (const name of names) {
      const meta = await getSkill(name);
      if (!meta) throw new Error(`Unknown skill "${name}". Try \`skillsmith list\`.`);
      const rel = await copySkill(projectRoot, agentId, agent, name, opts);
      lock.skills[name] = { version: meta.version };
      log.ok(`${opts.dryRun ? '[dry-run] ' : ''}Added ${name} → ${rel}`);
    }
  }, manifest, opts);
}

// Remove skills: move their folders to the trash and drop them from the lockfile.
export async function removeSkills(projectRoot, agentId, names, opts = {}) {
  const manifest = await loadManifest();
  const agent = getAgent(agentId);
  return _mutate(projectRoot, agentId, async (lock) => {
    for (const name of names) {
      const dest = skillDest(projectRoot, agent, name); // validates name + containment
      await trashExisting(projectRoot, dest, agentId, name, opts);
      delete lock.skills[name];
      log.ok(`${opts.dryRun ? '[dry-run] ' : ''}Removed ${name}`);
    }
  }, manifest, opts);
}

// Reproduce the lockfile's state: re-copy every locked skill at the bundled version.
export async function syncProject(projectRoot, agentIdOverride, opts = {}) {
  const manifest = await loadManifest();
  return _mutate(projectRoot, agentIdOverride, async (lock) => {
    const names = Object.keys(lock.skills);
    if (names.length === 0) {
      log.warn('Nothing in the lockfile to sync. Use `skillsmith add <skill>`.');
      return;
    }
    const agent = getAgent(lock.agent);
    for (const name of names) {
      const meta = manifest.skills.find((s) => s.name === name);
      if (!meta) { log.warn(`"${name}" is no longer in the catalog — skipping.`); continue; }
      const rel = await copySkill(projectRoot, lock.agent, agent, name, opts);
      lock.skills[name] = { version: meta.version };
      log.ok(`${opts.dryRun ? '[dry-run] ' : ''}Synced ${name} → ${rel}`);
    }
  }, manifest, opts);
}

// Shared mutate-and-persist wrapper: load lock, optionally switch agent,
// run the mutation, refresh the index, stamp the catalog version, save.
// In dry-run mode nothing is persisted.
async function _mutate(projectRoot, agentIdOverride, fn, manifest, opts = {}) {
  const { readLock, writeLock } = await import('./lockfile.js');
  await pruneTrash(); // best-effort housekeeping of old trash entries
  const lock = await readLock(projectRoot);
  if (agentIdOverride) lock.agent = agentIdOverride;
  getAgent(lock.agent); // validate
  await fn(lock);
  if (opts.dryRun) {
    log.dim('  would update lockfile and managed index');
    return lock;
  }
  lock.catalog = manifest.version;
  await refreshIndex(projectRoot, getAgent(lock.agent), lock, manifest);
  await writeLock(projectRoot, lock);
  return lock;
}
