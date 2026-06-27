// Per-agent adapters: where each agent looks for skills, and which (if any)
// instruction file should carry a managed index pointing at them.
//
// - `dir`   : where skill folders are copied (relative to the project root).
// - `index` : an instruction file the agent already reads at startup. When set,
//             skillsmith maintains a managed block in it listing installed skills
//             so agents that don't natively scan a skills/ folder still see them.
//             `null` means the agent auto-discovers the folder (no index needed).
import path from 'node:path';
import fs from 'node:fs/promises';
import { pathExists, validateSkillName, assertWithin } from './util.js';

export const AGENTS = {
  'claude-code': { label: 'Claude / Claude Code', dir: '.claude/skills', index: null },
  codex:         { label: 'Codex / GPT CLI',      dir: '.agent/skills',  index: 'AGENTS.md' },
  opencode:      { label: 'opencode',             dir: '.agent/skills',  index: 'AGENTS.md' },
  gemini:        { label: 'Gemini CLI',           dir: '.gemini/skills', index: 'GEMINI.md' },
  kimi:          { label: 'Kimi CLI',             dir: '.agent/skills',  index: 'AGENTS.md' },
  glm:           { label: 'GLM / Zhipu CLI',      dir: '.agent/skills',  index: 'AGENTS.md' },
  generic:       { label: 'Generic (AGENTS.md)',  dir: '.agent/skills',  index: 'AGENTS.md' },
};

export const DEFAULT_AGENT = 'claude-code';

export function getAgent(id) {
  const a = AGENTS[id];
  if (!a) {
    throw new Error(
      `Unknown agent "${id}". Known: ${Object.keys(AGENTS).join(', ')}`
    );
  }
  return a;
}

// Resolve where a skill folder lives for an agent, with the name validated and
// the result proven to stay inside the project root. This is the single choke
// point every install/remove/sync path goes through before touching the disk.
export function skillDest(projectRoot, agent, name) {
  validateSkillName(name);
  const dest = path.join(projectRoot, agent.dir, name);
  return assertWithin(projectRoot, dest);
}

const MARK_START = '<!-- skillsmith:start (managed — do not edit by hand) -->';
const MARK_END = '<!-- skillsmith:end -->';

function buildBlock(agent, installed) {
  const lines = [
    MARK_START,
    '## Agent Skills (managed by skillsmith)',
    '',
    'When a task matches a skill below, open the referenced file and follow it.',
    '',
  ];
  for (const s of installed) {
    lines.push(`- **${s.name}** — ${s.description} → \`${agent.dir}/${s.name}/SKILL.md\``);
  }
  lines.push(MARK_END);
  return lines.join('\n');
}

// Rewrite the managed block inside the agent's index file (creating it if needed).
export async function writeIndex(projectRoot, agent, installed) {
  if (!agent.index) return; // agent auto-discovers the folder; nothing to do
  const file = path.join(projectRoot, agent.index);
  const block = buildBlock(agent, installed);
  let body = (await pathExists(file)) ? await fs.readFile(file, 'utf8') : '';

  const re = new RegExp(
    `${MARK_START.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MARK_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
  );
  if (re.test(body)) {
    body = body.replace(re, block);
  } else {
    if (body && !body.endsWith('\n')) body += '\n';
    body += (body ? '\n' : '') + block + '\n';
  }
  if (!body.endsWith('\n')) body += '\n';
  await fs.writeFile(file, body);
}
