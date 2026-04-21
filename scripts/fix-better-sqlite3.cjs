#!/usr/bin/env node
/**
 * fix-better-sqlite3.cjs
 *
 * Ensures better-sqlite3 has a working native binary for the current Node.js
 * version. Strategy, in order:
 *
 *   1. Test the current binary. If it works, stop.
 *   2. If a prior attempt on THIS (version, MODULE_VERSION, platform, arch)
 *      tuple already exhausted both prebuild AND source, exit 1 immediately.
 *      Prevents the "loop forever re-downloading the same broken prebuild"
 *      failure mode observed on Dawn's machine 2026-04-20 where launchd
 *      respawn + this script kept pulling a bad tarball.
 *   3. If no prior attempt for this tuple, try the prebuild from GitHub.
 *   4. If the prebuild download fails OR the downloaded prebuild still fails
 *      to load, fall back to a source build via
 *      `npm rebuild better-sqlite3 --build-from-source`. node-gyp compiles
 *      against the current Node's headers, so it works for any Node version
 *      that has headers + a toolchain available.
 *   5. If source build also fails, mark tuple as `source-failed` and exit 1.
 *
 * Attempt state lives at <better-sqlite3>/.instar-fix-state.json and is
 * keyed by (betterSqliteVersion, MODULE_VERSION, platform, arch) so a Node
 * upgrade naturally invalidates stale state.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MODULE_VERSION = process.versions.modules;
const ARCH = process.arch;
const PLATFORM = process.platform;

function findBetterSqlite3() {
  try {
    const resolved = require.resolve('better-sqlite3/package.json');
    return path.dirname(resolved);
  } catch {
    return null;
  }
}

function getBetterSqliteVersion(pkgDir) {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
  return pkg.version;
}

/** Spawn a fresh node process to avoid any require-cache contamination. */
function testBinary(pkgDir) {
  try {
    execSync(
      `node -e "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.pragma('journal_mode = WAL'); db.close();"`,
      { stdio: 'pipe', timeout: 10000, cwd: pkgDir }
    );
    return true;
  } catch {
    return false;
  }
}

function stateFilePath(pkgDir) {
  return path.join(pkgDir, '.instar-fix-state.json');
}

function tupleKey(betterSqliteVersion) {
  return `${betterSqliteVersion}|${MODULE_VERSION}|${PLATFORM}|${ARCH}`;
}

function readState(pkgDir) {
  try {
    const raw = fs.readFileSync(stateFilePath(pkgDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeState(pkgDir, state) {
  try {
    fs.writeFileSync(stateFilePath(pkgDir), JSON.stringify(state, null, 2));
  } catch (err) {
    // Best-effort; don't block the fix on state-write failure.
    console.warn(`[fix-better-sqlite3] failed to persist state: ${err.message}`);
  }
}

function recordAttempt(pkgDir, existing, betterSqliteVersion, step, result) {
  const key = tupleKey(betterSqliteVersion);
  const state = existing && existing.key === key
    ? existing
    : {
        key,
        moduleVersion: MODULE_VERSION,
        platform: PLATFORM,
        arch: ARCH,
        betterSqliteVersion,
        attempts: [],
      };
  state.attempts.push({ at: new Date().toISOString(), step, result });
  state.lastResult = result;
  state.lastStep = step;
  writeState(pkgDir, state);
  return state;
}

/** Download + extract prebuild from GitHub. Returns true on success. */
function tryPrebuild(pkgDir, betterSqliteVersion) {
  const prebuildName =
    `better-sqlite3-v${betterSqliteVersion}-node-v${MODULE_VERSION}-${PLATFORM}-${ARCH}.tar.gz`;
  const url =
    `https://github.com/WiseLibs/better-sqlite3/releases/download/v${betterSqliteVersion}/${prebuildName}`;
  const tmpFile = path.join(os.tmpdir(), prebuildName);
  const buildDir = path.join(pkgDir, 'build');

  try {
    console.log(`[fix-better-sqlite3] Downloading ${url}`);
    execSync(`curl -L -f -o "${tmpFile}" "${url}"`, { stdio: 'pipe', timeout: 30000 });

    if (fs.existsSync(buildDir)) fs.rmSync(buildDir, { recursive: true });
    execSync(`tar xzf "${tmpFile}" -C "${pkgDir}"`, { stdio: 'pipe' });
    return true;
  } catch (err) {
    console.warn(`[fix-better-sqlite3] prebuild download/extract failed: ${err.message}`);
    return false;
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

/** Locate npm's CLI entry without needing a shell. */
function findNpmCli() {
  const nodeDir = path.dirname(process.execPath);
  const candidates = [
    path.resolve(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Compile better-sqlite3 from source via node-gyp. Runs against the current
 * Node.js headers; works for any Node version with headers + a toolchain.
 */
function trySourceBuild(pkgDir) {
  const npmCli = findNpmCli();
  if (!npmCli) {
    console.warn('[fix-better-sqlite3] cannot locate npm CLI for source build');
    return false;
  }
  // `npm rebuild` needs to be run from the nearest node_modules parent for
  // correct resolution. Walk up from pkgDir to find it.
  let rebuildCwd = pkgDir;
  const nmIdx = pkgDir.lastIndexOf(`${path.sep}node_modules${path.sep}`);
  if (nmIdx >= 0) {
    rebuildCwd = pkgDir.slice(0, nmIdx);
  }
  try {
    console.log(`[fix-better-sqlite3] Source-building better-sqlite3 in ${rebuildCwd} (~30s)`);
    execSync(
      `"${process.execPath}" "${npmCli}" rebuild better-sqlite3 --build-from-source`,
      {
        cwd: rebuildCwd,
        stdio: 'pipe',
        timeout: 180_000, // 3 min — source builds on older hardware are slow
        env: { ...process.env, npm_config_build_from_source: 'true' },
      }
    );
    return true;
  } catch (err) {
    console.warn(`[fix-better-sqlite3] source build failed: ${err.message}`);
    return false;
  }
}

function main() {
  const pkgDir = findBetterSqlite3();
  if (!pkgDir) {
    console.log('[fix-better-sqlite3] better-sqlite3 not found, skipping.');
    return 0;
  }

  const betterSqliteVersion = getBetterSqliteVersion(pkgDir);
  console.log(`[fix-better-sqlite3] Found better-sqlite3@${betterSqliteVersion} at ${pkgDir}`);
  console.log(
    `[fix-better-sqlite3] Node MODULE_VERSION=${MODULE_VERSION}, arch=${ARCH}, platform=${PLATFORM}`
  );

  if (testBinary(pkgDir)) {
    console.log('[fix-better-sqlite3] Native binary is working correctly.');
    return 0;
  }

  const existing = readState(pkgDir);
  const currentKey = tupleKey(betterSqliteVersion);

  // Loop-breaker: if prior attempts on this exact tuple have already
  // exhausted both prebuild AND source, don't try again.
  if (existing && existing.key === currentKey && existing.lastResult === 'source-failed') {
    console.error(
      '[fix-better-sqlite3] prior attempt on this (better-sqlite3, Node, platform, arch) ' +
      'tuple exhausted both prebuild and source build. Not retrying. Remove ' +
      `${stateFilePath(pkgDir)} to force another attempt.`
    );
    return 1;
  }

  // Step A: prebuild (skip if a prior attempt on this tuple already failed it)
  const priorPrebuildFailed =
    existing && existing.key === currentKey && existing.lastResult === 'prebuild-failed';

  if (!priorPrebuildFailed) {
    const prebuildTried = tryPrebuild(pkgDir, betterSqliteVersion);
    if (prebuildTried && testBinary(pkgDir)) {
      recordAttempt(pkgDir, existing, betterSqliteVersion, 'prebuild', 'prebuild-ok');
      console.log('[fix-better-sqlite3] Prebuild installed and verified.');
      return 0;
    }
    if (prebuildTried) {
      console.warn('[fix-better-sqlite3] Prebuild installed but still fails to load.');
    }
    recordAttempt(pkgDir, existing, betterSqliteVersion, 'prebuild', 'prebuild-failed');
  } else {
    console.log(
      '[fix-better-sqlite3] Prior prebuild attempt failed for this tuple; skipping to source build.'
    );
  }

  // Step B: source build fallback
  if (trySourceBuild(pkgDir) && testBinary(pkgDir)) {
    recordAttempt(pkgDir, readState(pkgDir), betterSqliteVersion, 'source', 'source-ok');
    console.log('[fix-better-sqlite3] Source build succeeded and binary is working.');
    return 0;
  }
  recordAttempt(pkgDir, readState(pkgDir), betterSqliteVersion, 'source', 'source-failed');
  console.error(
    '[fix-better-sqlite3] Both prebuild and source-build paths failed. ' +
    'SQLite subsystems will degrade to JSONL-only mode. ' +
    'Try: 1) install Xcode command-line tools (xcode-select --install on macOS), ' +
    '2) ensure python3 + make are on PATH, 3) check Node version compatibility.'
  );
  return 1;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  main,
  tupleKey,
  readState,
  writeState,
  recordAttempt,
  testBinary,
  findBetterSqlite3,
  findNpmCli,
};
