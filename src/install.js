// Core install/remove/sync logic shared by the CLI commands.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadManifest, getSkill, skillSourceDir } from './catalog.js';
import { getAgent, writeIndex } from './adapters.js';
import { log, pathExists } from './util.js';

// Copy one skill's folder from the bundled catalog into the agent's skills dir.
async function copySkill(projectRoot, agent, name) {
  const src = skillSourceDir(name);
  if (!(await pathExists(src))) {
    throw new Error(`Skill "${name}" is not in the catalog.`);
  }
  const dest = path.join(projectRoot, agent.dir, name);
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true });
  return path.relative(projectRoot, dest);
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
export async function addSkills(projectRoot, agentId, names) {
  const manifest = await loadManifest();
  const agent = getAgent(agentId);
  return _mutate(projectRoot, agentId, async (lock) => {
    for (const name of names) {
      const meta = await getSkill(name);
      if (!meta) throw new Error(`Unknown skill "${name}". Try \`skillsmith list\`.`);
      const rel = await copySkill(projectRoot, agent, name);
      lock.skills[name] = { version: meta.version };
      log.ok(`Added ${name} → ${rel}`);
    }
  }, manifest);
}

// Remove skills: delete their folders and drop them from the lockfile.
export async function removeSkills(projectRoot, agentId, names) {
  const manifest = await loadManifest();
  const agent = getAgent(agentId);
  return _mutate(projectRoot, agentId, async (lock) => {
    for (const name of names) {
      const dest = path.join(projectRoot, agent.dir, name);
      await fs.rm(dest, { recursive: true, force: true });
      delete lock.skills[name];
      log.ok(`Removed ${name}`);
    }
  }, manifest);
}

// Reproduce the lockfile's state: re-copy every locked skill at the bundled version.
export async function syncProject(projectRoot, agentIdOverride) {
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
      const rel = await copySkill(projectRoot, agent, name);
      lock.skills[name] = { version: meta.version };
      log.ok(`Synced ${name} → ${rel}`);
    }
  }, manifest);
}

// Shared mutate-and-persist wrapper: load lock, optionally switch agent,
// run the mutation, refresh the index, stamp the catalog version, save.
async function _mutate(projectRoot, agentIdOverride, fn, manifest) {
  const { readLock, writeLock } = await import('./lockfile.js');
  const lock = await readLock(projectRoot);
  if (agentIdOverride) lock.agent = agentIdOverride;
  getAgent(lock.agent); // validate
  await fn(lock);
  lock.catalog = manifest.version;
  await refreshIndex(projectRoot, getAgent(lock.agent), lock, manifest);
  await writeLock(projectRoot, lock);
  return lock;
}
