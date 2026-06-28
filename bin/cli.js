#!/usr/bin/env node
// skillsmith — install a versioned catalog of agent skills into any CLI agent.
import { parseArgs } from 'node:util';
import { execSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { readJson, log, c, compareVersions, confirm, isInteractive, PKG_ROOT } from '../src/util.js';
import { loadManifest } from '../src/catalog.js';
import { AGENTS, getAgent } from '../src/adapters.js';
import { readLock } from '../src/lockfile.js';
import { addSkills, removeSkills, syncProject } from '../src/install.js';
import { listTrash, restore, emptyTrash } from '../src/trash.js';

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
    'dry-run': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    force: { type: 'boolean' },
    last: { type: 'boolean' },
    'older-than': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

// Project root: cwd normally, home dir for --global (e.g. ~/.claude/skills).
const projectRoot = flags.global ? os.homedir() : process.cwd();

// Options passed down into the install/remove/sync layer.
const opts = { dryRun: flags['dry-run'] };

// Gate destructive work behind explicit consent. Overwritten/removed folders are
// reversible (they go to ~/.skillsmith/trash), so we only prompt for the riskier
// cases — writing into the home directory (--global) or an explicit `remove` —
// and never block plain project-local installs. Non-interactive callers must
// pass --yes so nothing changes silently in CI or piped contexts.
async function guardDestructive(action) {
  if (flags['dry-run'] || flags.yes) return; // preview-only, or already consented
  if (!(flags.global || action === 'remove')) return;
  const where = flags.global ? `your home directory (${os.homedir()})` : 'this project';
  if (!isInteractive()) {
    log.err(`Refusing to modify ${where} non-interactively. Re-run with --yes to confirm, or --dry-run to preview.`);
    process.exit(1);
  }
  log.dim('Removed or overwritten skill folders move to ~/.skillsmith/trash and can be restored with `skillsmith restore`.');
  const ok = await confirm(`Modify skills in ${where}?`, { defaultYes: false });
  if (!ok) { log.warn('Aborted — nothing changed.'); process.exit(0); }
}

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
  restore [id]             Restore a folder from the trash (--last for the newest)
  trash list|empty         Inspect or clear the managed trash
  agents                   List supported target agents
  version                  Print the installed catalog version
  help                     Show this help

Options
  -a, --agent <id>         Target agent (default: claude-code or lockfile value)
  -g, --global             Operate on your home dir instead of the project
      --all                With \`add\`: install every skill in the catalog
      --no-self-upgrade    With \`update\`: re-sync only, skip npm self-upgrade
      --dry-run            Print what would change; touch nothing on disk
  -y, --yes                Skip the confirmation prompt (required when non-interactive)
      --force              With \`restore\`: overwrite an existing target
      --last               With \`restore\`: restore the most recently trashed entry
      --older-than <days>  With \`trash empty\`: only drop entries older than N days

Safety
  Removed or overwritten skill folders are moved to ~/.skillsmith/trash
  (not permanently deleted) and can be brought back with \`skillsmith restore\`.

Examples
  npx @nadernabil216/skillsmith list
  skillsmith add commit-suggest process-pr-comment --agent claude-code
  skillsmith add --all --agent codex
  skillsmith add commit-suggest --global --dry-run
  skillsmith restore --last
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
  await guardDestructive('add');
  await addSkills(projectRoot, agentId, names, opts);
  log.dim(`\nTarget: ${getAgent(agentId).label} (${getAgent(agentId).dir})`);
}

async function cmdRemove() {
  if (positionals.length === 0) { log.err('Specify at least one skill to remove.'); process.exit(1); }
  const agentId = flags.agent || (await readLock(projectRoot)).agent;
  await guardDestructive('remove');
  await removeSkills(projectRoot, agentId, positionals, opts);
}

async function cmdSync() {
  await guardDestructive('sync');
  await syncProject(projectRoot, flags.agent, opts);
}

// Restore a trashed folder, or list what's restorable when given no target.
async function cmdRestore() {
  const entries = await listTrash();
  const id = positionals[0];
  if (!id && !flags.last) {
    if (entries.length === 0) { log.info('Trash is empty — nothing to restore.'); return; }
    log.info('Restorable entries (newest first):\n');
    for (const e of entries) {
      log.info(`  ${c.paint('cyan', e.id)}`);
      log.dim(`    → ${e.originalPath}   (${e.trashedAt})`);
    }
    log.dim('\nRestore with `skillsmith restore <id>` or `skillsmith restore --last`.');
    return;
  }
  const targetId = flags.last ? entries[0]?.id : id;
  if (!targetId) { log.err('Nothing to restore.'); process.exit(1); }
  const dest = await restore(targetId, { force: flags.force });
  log.ok(`Restored → ${dest}`);
}

// Inspect or clear the managed trash.
async function cmdTrash() {
  const sub = positionals[0] || 'list';
  if (sub === 'list') {
    const entries = await listTrash();
    if (entries.length === 0) { log.info('Trash is empty.'); return; }
    for (const e of entries) {
      log.info(`  ${c.paint('cyan', e.id)}`);
      log.dim(`    → ${e.originalPath}   (${e.trashedAt})`);
    }
    return;
  }
  if (sub === 'empty') {
    const days = flags['older-than'] != null ? parseInt(flags['older-than'], 10) : null;
    if (days != null && Number.isNaN(days)) { log.err('--older-than expects a number of days.'); process.exit(1); }
    const n = await emptyTrash({ olderThanDays: days });
    const noun = n === 1 ? 'entry' : 'entries';
    log.ok(days != null ? `Removed ${n} trash ${noun} older than ${days} days.` : `Emptied trash (${n} ${noun}).`);
    return;
  }
  log.err(`Unknown trash subcommand "${sub}". Use \`list\` or \`empty\`.`);
  process.exit(1);
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
  await guardDestructive('sync');
  await syncProject(projectRoot, flags.agent, opts);
}

async function main() {
  if (!command || command === 'help' || flags.help) { console.log(HELP); return; }
  switch (command) {
    case 'list': return cmdList();
    case 'agents': return cmdAgents();
    case 'add': return cmdAdd();
    case 'remove': case 'rm': return cmdRemove();
    case 'sync': return cmdSync();
    case 'restore': return cmdRestore();
    case 'trash': return cmdTrash();
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
