// Deploys this checkout to the local directory marketplace Claude Code runs
// the plugin from (default ~/.local/share/dsh-crew), so that directory is a
// build output of one commit instead of a hand-synced mixture.
//
//   node scripts/deploy-local.mjs                 # dry run: print the plan
//   node scripts/deploy-local.mjs --apply         # write it
//   node scripts/deploy-local.mjs --dest <dir>    # another target
//
// What it deploys: the committed HEAD tree, never the working tree - files
// are read from git objects, so uncommitted edits cannot leak into the live
// plugin. The payload is package.json "files" plus package.json and
// CHANGELOG.md, i.e. the same set npm would publish.
//
// What it never does: delete. Files in the target that the payload does not
// carry (old backups, node_modules, ...) are listed as strays and left alone.
// Every file it overwrites is first copied to
// <target-parent>/dsh-crew-deploy-backups/<stamp>/.
//
// It refuses when lib/server.mjs is older than the sources it bundles (run
// `npm run build:mcp` and commit first), unless --allow-stale-bundle.
// Running sessions keep the server they started; restart them to pick up
// the new build.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve, relative, parse, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const allowStale = args.includes('--allow-stale-bundle');
const destIdx = args.indexOf('--dest');
const DEST = resolve(destIdx >= 0 ? args[destIdx + 1] ?? '' : join(homedir(), '.local', 'share', 'dsh-crew'));
const STAMP_FILE = 'DEPLOYED_FROM.json';

function fail(msg) {
  console.error('\nDEPLOY REFUSED: ' + msg);
  process.exit(1);
}

function git(gitArgs, input) {
  const r = spawnSync('git', ['-C', ROOT, ...gitArgs], { input, maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) fail(`git ${gitArgs.join(' ')} failed: ${r.stderr.toString().trim()}`);
  return r.stdout;
}

// 1. Target sanity: never a drive root, the home directory itself, or this
//    checkout; an existing target must already be this plugin.
if (destIdx >= 0 && !args[destIdx + 1]) fail('--dest needs a directory');
if (DEST === parse(DEST).root) fail(`target ${DEST} is a drive root`);
if (DEST === resolve(homedir())) fail(`target ${DEST} is the home directory`);
if (DEST === resolve(ROOT)) fail('target is this checkout');
const destManifest = join(DEST, '.claude-plugin', 'plugin.json');
if (existsSync(DEST) && readdirSync(DEST).length > 0) {
  if (!existsSync(destManifest)) fail(`${DEST} is not empty and has no .claude-plugin/plugin.json`);
  const name = JSON.parse(readFileSync(destManifest, 'utf8')).name;
  if (name !== 'dsh-crew') fail(`${DEST} holds plugin "${name}", not dsh-crew`);
}

// 2. Bundle freshness: no commit after the last lib/server.mjs build may
//    touch what the bundle is built from. src/hub and src/client are not
//    imported by src/server.mjs, so they do not count.
const head = git(['rev-parse', 'HEAD']).toString().trim();
const libCommit = git(['rev-list', '-1', 'HEAD', '--', 'lib/server.mjs']).toString().trim();
const newer = git(['rev-list', `${libCommit}..HEAD`, '--', 'src', 'package.json', 'pnpm-lock.yaml',
  ':(exclude)src/hub', ':(exclude)src/client']).toString().trim();
if (newer) {
  const msg = `lib/server.mjs (built at ${libCommit.slice(0, 7)}) is older than ${newer.split('\n').length} source commit(s); rebuild and commit it`;
  if (!allowStale) fail(msg + ', or pass --allow-stale-bundle');
  console.warn('WARNING: ' + msg);
}

// 3. Payload: package.json "files" entries resolved against the HEAD tree.
const pkg = JSON.parse(git(['show', 'HEAD:package.json']).toString());
const globToRe = (g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
const patterns = [...pkg.files, 'package.json', 'CHANGELOG.md'].map(globToRe);
const tree = git(['ls-tree', '-r', '-z', 'HEAD']).toString().split('\0').filter(Boolean).map((line) => {
  const [meta, path] = line.split('\t');
  const [, type, sha] = meta.split(' ');
  return { type, sha, path };
});
const payload = tree.filter((e) => e.type === 'blob' && patterns.some((re) => {
  // An entry names a file or a directory; a directory covers everything below it.
  const parts = e.path.split('/');
  return parts.some((_, i) => re.test(parts.slice(0, i + 1).join('/')));
}));
if (!payload.some((e) => e.path === 'lib/server.mjs')) fail('payload has no lib/server.mjs');

// Read every blob in one git process: "<sha> blob <size>\n<bytes>\n" each.
const batch = git(['cat-file', '--batch'], payload.map((e) => e.sha).join('\n') + '\n');
let off = 0;
for (const e of payload) {
  const nl = batch.indexOf(0x0a, off);
  const size = Number(batch.subarray(off, nl).toString().split(' ')[2]);
  e.data = batch.subarray(nl + 1, nl + 1 + size);
  off = nl + 1 + size + 1;
}

// 4. Plan: new / changed / unchanged, plus strays left in place.
const plan = { added: [], changed: [], same: 0 };
for (const e of payload) {
  const target = join(DEST, ...e.path.split('/'));
  if (!existsSync(target)) plan.added.push(e);
  else if (!readFileSync(target).equals(e.data)) plan.changed.push(e);
  else plan.same++;
}
const carried = new Set(payload.map((e) => e.path));
const strays = [];
(function walk(dir) {
  if (!existsSync(dir)) return;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    const rel = relative(DEST, full).split(sep).join('/');
    if (rel === 'node_modules' || rel === STAMP_FILE) continue;
    if (ent.isDirectory()) walk(full);
    else if (!carried.has(rel)) strays.push(rel);
  }
})(DEST);

const dirty = git(['status', '--porcelain', '--untracked-files=no']).toString().trim();
let previous = null;
try { previous = JSON.parse(readFileSync(join(DEST, STAMP_FILE), 'utf8')); } catch { /* first deploy */ }

console.log(`[deploy] ${apply ? 'APPLY' : 'DRY RUN'}: ${ROOT} @ ${head.slice(0, 7)} -> ${DEST}`);
console.log(`[deploy] previously deployed: ${previous ? previous.commit.slice(0, 7) + ' (' + previous.deployed_at + ')' : 'unknown (no ' + STAMP_FILE + ')'}`);
if (dirty) console.log('[deploy] note: the working tree has uncommitted changes; they are NOT deployed');
console.log(`[deploy] ${payload.length} files: ${plan.added.length} new, ${plan.changed.length} changed, ${plan.same} unchanged`);
for (const e of plan.added) console.log('  + ' + e.path);
for (const e of plan.changed) console.log('  ~ ' + e.path);
if (strays.length) {
  console.log(`[deploy] ${strays.length} file(s) in the target are not in the payload (left alone):`);
  for (const s of strays) console.log('  ? ' + s);
}
if (!apply) {
  console.log('\n[deploy] dry run only; rerun with --apply to write');
  process.exit(0);
}

// 5. Apply: back up what gets overwritten, write, stamp.
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
if (plan.changed.length) {
  const backupDir = join(dirname(DEST), 'dsh-crew-deploy-backups', stamp);
  for (const e of plan.changed) {
    const from = join(DEST, ...e.path.split('/'));
    const to = join(backupDir, ...e.path.split('/'));
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  console.log(`[deploy] backed up ${plan.changed.length} overwritten file(s) to ${backupDir}`);
}
for (const e of [...plan.added, ...plan.changed]) {
  const target = join(DEST, ...e.path.split('/'));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, e.data);
}
const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).toString().trim();
writeFileSync(join(DEST, STAMP_FILE), JSON.stringify({
  commit: head, branch, source: ROOT, deployed_at: new Date().toISOString(),
  working_tree_dirty: Boolean(dirty), bundle_built_at: libCommit,
}, null, 2) + '\n');
console.log(`[deploy] done: ${plan.added.length + plan.changed.length} file(s) written, ${STAMP_FILE} updated (${statSync(join(DEST, 'lib', 'server.mjs')).size} byte bundle)`);
console.log('[deploy] restart Claude Code sessions to load the new MCP server');
