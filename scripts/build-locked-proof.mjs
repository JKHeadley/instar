#!/usr/bin/env node
// safe-git-allow: read-only git (rev-parse, show, archive) and removal of the build's own node_modules link inside its scratch tree; nothing in a checkout is changed.
/**
 * build-locked-proof.mjs — the locked-screen TEST BUILD (docs/specs/desktop-locked-screen.md,
 * phase 3: "That build alone compiles in a test proven-versions table").
 *
 * It copies one committed revision into a scratch directory OUTSIDE this checkout,
 * adds a single `PROOF-RUN-IN-PROGRESS` row for one macOS major version to the
 * scratch copy of src/core/DesktopProvenVersions.ts, sets the package version to
 * `<release>-lockedproof.<n>`, builds it (TypeScript + the unchanged Swift helper)
 * and packs it. The committed table is never touched, nothing is published, and
 * the helper source is the shipped one, so its source hash binds the proof
 * evidence to the helper the fleet will run.
 *
 * Usage:
 *   node scripts/build-locked-proof.mjs [--os-major N] [--n N] [--ref REF] [--out DIR] [--helper-dir NAME] [--dry-run]
 *
 *   --os-major  macOS major to admit (default: this Mac's `sw_vers -productVersion`)
 *   --n         build number for the version suffix (default 1)
 *   --ref       git revision to build (default HEAD; committed content only)
 *   --out       where the scratch tree, .tgz and manifest go (default $TMPDIR/instar-locked-proof)
 *   --helper-dir  keep the helper in ~/.instar/NAME (desktop-helper-<name>) in this build only. For a proof Mac
 *               whose macOS permission row at the default folder names an older build: that row can be neither
 *               seen nor cleared, and a new path has none. The helper source, and so its hash, stays the same.
 *   --dry-run   stop after the rewrite: print the row and the diff, build nothing
 *
 * Output: `<out>/instar-<version>.tgz` and `<out>/locked-proof-manifest-<version>.json`
 * ({ packageVersion, commit, osMajor, helperSourceHash, helperDir, tgz, tgzSha256, createdAt }).
 * On a Mac the helper is universal: only a universal helper may take the kept copy.
 * Install only into a throwaway macOS user's own prefix, with auto-update off.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOsMajor, proofVersion, rewriteHelperRoot, rewriteProvenTable } from './lib/locked-proof-build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TABLE_FILE = 'src/core/DesktopProvenVersions.ts';
const RETENTION_FILE = 'src/core/DesktopHelperRetention.ts';
const FAT_MAGIC = 0xcafebabe;

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const dryRun = process.argv.includes('--dry-run');

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', ...opts });
}

function localOsMajor() {
  if (process.platform !== 'darwin') throw new Error('--os-major is required when not running on a Mac');
  return parseOsMajor(execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }));
}

function main() {
  const osMajor = arg('os-major') !== undefined ? parseOsMajor(arg('os-major')) : localOsMajor();
  const n = arg('n') !== undefined ? Number.parseInt(arg('n'), 10) : 1;
  const ref = arg('ref') ?? 'HEAD';
  const out = path.resolve(arg('out') ?? path.join(os.tmpdir(), 'instar-locked-proof'));
  const commit = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  if (out === ROOT || out.startsWith(ROOT + path.sep)) throw new Error(`--out must be outside this checkout (${ROOT})`);

  const committedTable = git(['show', `${commit}:${TABLE_FILE}`]);
  const basePkg = JSON.parse(git(['show', `${commit}:package.json`]));
  const version = proofVersion(basePkg.version, n);
  const rewritten = rewriteProvenTable(committedTable, { osMajor, version });
  const helperDir = arg('helper-dir');
  const rewrittenRetention = helperDir === undefined ? null
    : rewriteHelperRoot(git(['show', `${commit}:${RETENTION_FILE}`]), helperDir);

  const tableHashBefore = fs.existsSync(path.join(ROOT, TABLE_FILE))
    ? crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, TABLE_FILE))).digest('hex') : null;

  if (dryRun) {
    console.log(`[locked-proof] dry run: ${version} at ${commit.slice(0, 12)} admits macOS ${osMajor}`);
    console.log(rewritten.split('\n').filter(line => line.includes('PROVEN_MACOS_VERSIONS')).join('\n'));
    if (rewrittenRetention) console.log(rewrittenRetention.split('\n').filter(line => line.includes(helperDir)).join('\n'));
    return;
  }

  const scratch = path.join(out, `instar-${version}`);
  if (fs.existsSync(scratch)) throw new Error(`${scratch} exists; pick another --n or remove it`);
  fs.mkdirSync(scratch, { recursive: true });

  // Committed content only: an uncommitted edit in this checkout never reaches the build.
  const archive = execFileSync('git', ['archive', '--format=tar', commit], { cwd: ROOT, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-C', scratch], { input: archive, maxBuffer: 1 << 30 });

  fs.writeFileSync(path.join(scratch, TABLE_FILE), rewritten);
  if (rewrittenRetention) fs.writeFileSync(path.join(scratch, RETENTION_FILE), rewrittenRetention);
  const pkg = JSON.parse(fs.readFileSync(path.join(scratch, 'package.json'), 'utf8'));
  pkg.version = version;
  fs.writeFileSync(path.join(scratch, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(scratch, 'node_modules'));

  console.log(`[locked-proof] building ${version} (macOS ${osMajor}) in ${scratch}`);
  // Never release-signed: the lock-file signer reads these env keys (and a local .instar-release-keys/, which a
  // fresh git archive never contains), and a test build must not carry a release signature.
  const buildEnv = { ...process.env };
  delete buildEnv.INSTAR_RELEASE_PRIVATE_KEY_PEM;
  delete buildEnv.INSTAR_RELEASE_PRIVATE_KEY_PEM_PATH;
  delete buildEnv.INSTAR_RELEASE_BUILD;
  execFileSync('npm', ['run', 'build'], { cwd: scratch, stdio: 'inherit', env: buildEnv });
  if (process.platform === 'darwin') {
    // Retention keeps only a universal helper, and a plain build is thin. Only this native step sees the flag, so
    // the lock-file signer above still ran without it.
    execFileSync('node', ['scripts/build-native-desktop-host.mjs'], { cwd: scratch, stdio: 'inherit', env: { ...buildEnv, INSTAR_RELEASE_BUILD: '1' } });
    const head = Buffer.alloc(4);
    const handle = fs.openSync(path.join(scratch, 'dist/native/instar-desktop-host'), 'r');
    fs.readSync(handle, head, 0, 4, 0);
    fs.closeSync(handle);
    if (head.readUInt32BE(0) !== FAT_MAGIC) throw new Error('the helper did not come out universal, so it could never be kept');
  }
  // The symlink must not be packed; npm pack ignores node_modules, but drop it to be sure.
  fs.unlinkSync(path.join(scratch, 'node_modules'));
  const packed = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', out], { cwd: scratch, encoding: 'utf8' })
    .trim().split('\n').pop();
  const tgz = path.join(out, packed);

  const helper = JSON.parse(fs.readFileSync(path.join(scratch, 'dist/native/instar-desktop-host.json'), 'utf8'));
  const manifest = {
    packageVersion: version, commit, osMajor, helperSourceHash: helper.sourceHash, helperDir: helperDir ?? 'desktop-helper',
    tgz, tgzSha256: crypto.createHash('sha256').update(fs.readFileSync(tgz)).digest('hex'),
    createdAt: new Date().toISOString(),
  };
  const manifestPath = path.join(out, `locked-proof-manifest-${version}.json`);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const tableHashAfter = fs.existsSync(path.join(ROOT, TABLE_FILE))
    ? crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, TABLE_FILE))).digest('hex') : null;
  if (tableHashBefore !== tableHashAfter) throw new Error(`${TABLE_FILE} in this checkout changed during the build`);

  console.log(`[locked-proof] ${tgz}`);
  console.log(`[locked-proof] manifest ${manifestPath}`);
  console.log(`[locked-proof] helper sourceHash ${helper.sourceHash}`);
}

try { main(); } catch (err) {
  console.error(`[locked-proof] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
