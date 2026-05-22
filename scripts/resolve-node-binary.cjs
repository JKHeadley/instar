/**
 * resolve-node-binary.cjs — CommonJS twin of src/utils/resolveNodeBinary.ts.
 *
 * Both files implement the same fallback chain. They are kept in sync because
 * fix-better-sqlite3.cjs runs as a child process via execFileSync and cannot
 * import the TypeScript module; the server-side ensureSqliteBindings code
 * imports the TS module directly. If you change the resolution chain in one,
 * mirror it in the other.
 *
 * Rationale: when Homebrew updates Node mid-session, process.execPath becomes
 * ENOENT for any NEW spawnSync (even though the running process keeps its open
 * FD). The heal path needs a stable fallback chain so it can rebuild and the
 * subsystems can recover after restart.
 *
 * Spec / origin: heal-execpath-staleness fix (Luna self-heal failure, 2026-05-21).
 */

const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

function isExecutableFile(p, existsSync) {
  try {
    if (!existsSync(p)) return false;
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
    if (os.platform() !== 'win32') {
      try {
        fs.accessSync(p, fs.constants.X_OK);
      } catch {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function whichNode(platform) {
  try {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(cmd, ['node'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      const first = result.stdout.trim().split(/\r?\n/)[0];
      if (first) return first;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * @param {{agentBundledNode?: string, execPathOverride?: string,
 *          platformOverride?: string, existsSyncOverride?: (p:string)=>boolean,
 *          whichOverride?: () => string|null}} [opts]
 * @returns {{path:string, source:string} | null}
 */
function resolveStableNodeBinary(opts = {}) {
  const existsSync = opts.existsSyncOverride || fs.existsSync;
  const platform = opts.platformOverride || os.platform();
  const execPath = opts.execPathOverride || process.execPath;

  // 1. process.execPath as-is.
  if (isExecutableFile(execPath, existsSync)) {
    return { path: execPath, source: 'execPath' };
  }

  // 2. Realpath of process.execPath.
  try {
    const real = fs.realpathSync(execPath);
    if (real !== execPath && isExecutableFile(real, existsSync)) {
      return { path: real, source: 'execPath-realpath' };
    }
  } catch {
    /* realpath fails when execPath is gone; continue */
  }

  // 3. Agent's bundled Node.
  if (opts.agentBundledNode && isExecutableFile(opts.agentBundledNode, existsSync)) {
    return { path: opts.agentBundledNode, source: 'agent-bundled' };
  }

  // 4. Platform-stable absolute paths.
  if (platform !== 'win32') {
    const candidates = [
      ['/opt/homebrew/bin/node', 'homebrew'],
      ['/usr/local/bin/node', 'usr-local'],
      ['/usr/bin/node', 'usr-bin'],
    ];
    for (const [candidate, source] of candidates) {
      if (isExecutableFile(candidate, existsSync)) {
        return { path: candidate, source };
      }
    }
  }

  // 5. PATH lookup.
  const whichResult = opts.whichOverride ? opts.whichOverride() : whichNode(platform);
  if (whichResult && isExecutableFile(whichResult, existsSync)) {
    return { path: whichResult, source: 'which' };
  }

  return null;
}

function resolveStableNodeBinaryPath(opts = {}) {
  const resolved = resolveStableNodeBinary(opts);
  return resolved ? resolved.path : null;
}

module.exports = {
  resolveStableNodeBinary,
  resolveStableNodeBinaryPath,
};
