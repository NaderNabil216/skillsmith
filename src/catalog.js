// Loads the bundled skill catalog (manifest.json + the skills/ folder).
import path from 'node:path';
import { SKILLS_DIR, MANIFEST_PATH, readJson } from './util.js';

let _manifest = null;

export async function loadManifest() {
  if (_manifest) return _manifest;
  const m = await readJson(MANIFEST_PATH);
  if (!m) {
    throw new Error(
      'manifest.json not found. Run `npm run build` to generate it from skills/.'
    );
  }
  _manifest = m;
  return m;
}

export async function getSkill(name) {
  const m = await loadManifest();
  return m.skills.find((s) => s.name === name) || null;
}

// Absolute path to a skill's source folder inside this package.
export function skillSourceDir(name) {
  return path.join(SKILLS_DIR, name);
}
