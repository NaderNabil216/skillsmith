// Per-project lockfile: records which agent and which skills are installed,
// plus the version each skill was synced at. This is what `sync`/`update` read.
import path from 'node:path';
import { readJson, writeJson } from './util.js';
import { DEFAULT_AGENT } from './adapters.js';

export const LOCKFILE_NAME = '.skillsmith.json';

export function lockPath(projectRoot) {
  return path.join(projectRoot, LOCKFILE_NAME);
}

export async function readLock(projectRoot) {
  const existing = await readJson(lockPath(projectRoot));
  return (
    existing || {
      $schema: 'skillsmith-lock@1',
      agent: DEFAULT_AGENT,
      catalog: null, // catalog (package) version last applied
      skills: {},    // { name: { version } }
    }
  );
}

export async function writeLock(projectRoot, lock) {
  await writeJson(lockPath(projectRoot), lock);
}
