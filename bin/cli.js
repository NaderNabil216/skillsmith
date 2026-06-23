#!/usr/bin/env node
// skillsmith — install a versioned catalog of agent skills into any CLI agent.
import { parseArgs } from 'node:util';
import { execSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readJson, log, c, compareVersions, PKG_ROOT } from '../src/util.js';
import { loadManifest } from '../src/catalog.js';
import { AGENTS, getAgent } from '../src/adapters.js';
import { readLock } from '../src/lockfile.js';
import { addSkills, removeSkills, syncProject } from '../src/install.js';

const argv = process.argv.slice(2);
const command = argv[0];

const { values: flags, positionals } = parseArgs({
  args: argv.slice(1),
  allowPositionals: true,
  options: {
    agent: { type: 'string', short: 'a' },
    global: { type: 'boolean', short: 'g' },
    all: { type: 'boolean' },
    'no-self-upgrade': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

// Project root: cwd normally, home dir for --global (e.g. ~/.claude/skills).
const projectRoot = flags.global ? os.homedir() : process.cwd();

async function pkgInfo() {
  return readJson(path.join(PKG_ROOT, 'package.json'), {});
}

const HELP = `${c.paint('bold', 'skillsmith')} — agent skill catalog installer

Usage
  skillsmith <command> [skills...] [options]

Commands
  list                     Show the catalog (★ = installed in this project)
  add <skill...>           Install skills into this project (--all for everything)
  remove <skill...>        Uninstall skills from this project
  update [skill...]        Upgrade to the latest catalog and re-sync skills
  sync                     Reproduce the lockfile state (e.g. after git clone)
  agents                   List supported target agents
  version                  Print the installed catalog version
  help                     Show this help

Options
  -a, --agent <id>         Target agent (default: claude-code or lockfile value)
  -g, --global             Operate on your home dir instead of the project
      --all                With \`add\`: install every skill in the catalog
      --no-self-upgrade    With \`update\`: re-sync only, skip npm self-upgrade

Examples
  npx @nadernabil216/skillsmith list
  skillsmith add commit-suggest process-pr-comment --agent claude-code
  skillsmith add --all --agent codex
  skillsmith update
`;

async function cmdList() {
  const manifest = await loadManifest();
  const lock = await readLock(projectRoot);
  log.info(`${c.paint('bold', manifest.name)} ${c.paint('dim', 'v' + manifest.version)}\n`);
  for (const s of manifest.skills) {
    const mark = lock.skills[s.name] ? c.paint('green', '★') : ' ';
    log.info(`${mark} ${c.paint('cyan', s.name.padEnd(22))} ${c.paint('dim', s.version)}  ${s.description}`);
  }
  log.dim('\n★ = installed here   ·   add with `skillsmith add <name>`');
}

function cmdAgents() {
  log.info('Supported target agents:\n');
  for (const [id, a] of Object.entries(AGENTS)) {
    log.info(`  ${c.paint('cyan', id.padEnd(14))} ${a.label.padEnd(20)} ${c.paint('dim', '→ ' + a.dir)}`);
  }
  log.dim('\nPick one with --agent <id>.');
}

async function cmdAdd() {
  const manifest = await loadManifest();
  let names = positionals;
  if (flags.all) names = manifest.skills.map((s) => s.name);
  if (names.length === 0) {
    log.err('Specify at least one skill, or use --all. See `skillsmith list`.');
    process.exit(1);
  }
  const agentId = flags.agent || (await readLock(projectRoot)).agent;
  await addSkills(projectRoot, agentId, names);
  log.dim(`\nTarget: ${getAgent(agentId).label} (${getAgent(agentId).dir})`);
}

async function cmdRemove() {
  if (positionals.length === 0) { log.err('Specify at least one skill to remove.'); process.exit(1); }
  const agentId = flags.agent || (await readLock(projectRoot)).agent;
  await removeSkills(projectRoot, agentId, positionals);
}

async function cmdSync() {
  await syncProject(projectRoot, flags.agent);
}

// Look up the latest published version on the npm registry (no extra deps).
async function latestPublished(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}/latest`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    return (await res.json()).version || null;
  } catch { return null; }
}

async function cmdUpdate() {
  const pkg = await pkgInfo();
  const current = pkg.version;

  // 1) Try to pull a newer catalog from npm (unless told to skip, e.g. under npx@latest).
  if (!flags['no-self-upgrade']) {
    const latest = await latestPublished(pkg.name);
    if (latest && compareVersions(latest, current) > 0) {
      log.info(`Newer catalog available: ${current} → ${latest}. Upgrading…`);
      try {
        execSync(`npm install -g ${pkg.name}@latest`, { stdio: 'inherit' });
        // Re-exec the freshly installed binary to apply the new skills.
        const prefix = execSync('npm prefix -g').toString().trim();
        const bin = path.join(prefix, 'bin', 'skillsmith');
        const r = spawnSync(bin, ['sync', ...(flags.agent ? ['--agent', flags.agent] : []), ...(flags.global ? ['--global'] : [])], { stdio: 'inherit' });
        process.exit(r.status ?? 0);
      } catch {
        log.warn('Self-upgrade failed (not a global install?). Re-syncing current catalog instead.');
        log.dim(`Tip: run \`npx ${pkg.name}@latest update --no-self-upgrade\` to get the latest.`);
      }
    } else {
      log.ok(`Catalog already at the latest version (${current}).`);
    }
  }

  // 2) Re-sync the locked skills from whatever catalog is now running.
  await syncProject(projectRoot, flags.agent);
}

async function main() {
  if (!command || command === 'help' || flags.help) { console.log(HELP); return; }
  switch (command) {
    case 'list': return cmdList();
    case 'agents': return cmdAgents();
    case 'add': return cmdAdd();
    case 'remove': case 'rm': return cmdRemove();
    case 'sync': return cmdSync();
    case 'update': return cmdUpdate();
    case 'version': case '--version': case '-v':
      return log.info((await pkgInfo()).version);
    default:
      log.err(`Unknown command: ${command}`);
      console.log(HELP);
      process.exit(1);
  }
}

main().catch((e) => { log.err(e.message); process.exit(1); });
