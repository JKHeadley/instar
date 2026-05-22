/**
 * resolveNodeBinary — find a stable, currently-existing Node.js executable.
 *
 * Background:
 *   The native-module heal path spawns child processes with `process.execPath`
 *   as the executable target. That works UNTIL the underlying file disappears
 *   from disk — most commonly when Homebrew (or any package manager) updates
 *   Node while the server is still running. Brew swaps the
 *   /opt/homebrew/bin/node symlink and removes the previous Cellar directory.
 *   The running process keeps an open FD to the deleted binary so it continues
 *   executing normally, but any NEW `spawnSync(process.execPath, ...)` returns
 *   ENOENT — the file is gone from the filesystem.
 *
 *   Observed live on luna 2026-05-21: heal detected NODE_MODULE_VERSION
 *   mismatch correctly, then logged
 *   "rebuild failed (spawnSync /opt/homebrew/Cellar/node/25.6.1/bin/node ENOENT)"
 *   even though `node --version` from a fresh shell still worked — Homebrew
 *   had moved Node forward and removed the original Cellar path the process
 *   was launched from.
 *
 * Strategy:
 *   1. Try `process.execPath` first (cheapest, most likely correct).
 *   2. If it's ENOENT, try `fs.realpathSync(process.execPath)` — if execPath
 *      was a symlink at startup, the underlying target might still exist.
 *   3. Otherwise fall back to a list of known-stable absolute paths in order:
 *      - the bundled agent Node at <agentStateDir>/bin/node (passed in)
 *      - /opt/homebrew/bin/node (macOS Homebrew's stable symlink)
 *      - /usr/local/bin/node, /usr/bin/node
 *   4. Final fallback: `which node` from PATH.
 *
 * Returns the first existing-and-executable absolute path, or null when
 * none of the candidates resolve. Callers that get null should NOT silently
 * proceed — the heal cannot continue without a working Node, and the failure
 * mode is operator-visible (DegradationReporter event with a recovery hint).
 *
 * Spec / origin: heal-execpath-staleness fix (Luna self-heal failure, 2026-05-21).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export interface ResolveOptions {
  /** Optional path to the agent's bundled Node (e.g. <stateDir>/bin/node). */
  agentBundledNode?: string;
  /** Override the in-process execPath. For testing only. */
  execPathOverride?: string;
  /** Override the platform string. For testing only. */
  platformOverride?: NodeJS.Platform;
  /** Override fs.existsSync. For testing only. */
  existsSyncOverride?: (p: string) => boolean;
  /** Override the `which`/`where` lookup. For testing only. */
  whichOverride?: () => string | null;
}

/**
 * Result of a resolution attempt. Includes the source so callers can log
 * which fallback fired (useful when investigating why heal needed help).
 */
export interface ResolvedNodeBinary {
  /** Absolute path to the resolved Node executable. */
  path: string;
  /** Which strategy produced this path. */
  source:
    | 'execPath'
    | 'execPath-realpath'
    | 'agent-bundled'
    | 'homebrew'
    | 'usr-local'
    | 'usr-bin'
    | 'which';
}

/**
 * Check whether a path exists AND is executable (or at least file-like).
 * On macOS/Linux, regular files with the exec bit set qualify; on Windows
 * we only check existence because exec semantics differ. Symlinks are
 * followed via fs.statSync (not lstat).
 */
function isExecutableFile(
  p: string,
  existsSync: (q: string) => boolean,
): boolean {
  try {
    if (!existsSync(p)) return false;
    const stat = fs.statSync(p);
    if (!stat.isFile()) return false;
    // accessSync throws on missing exec bit; treat throw as "not executable".
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

/**
 * Resolve a stable Node binary path. Returns the first viable candidate;
 * null only when every strategy fails (rare — usually means Node was
 * completely uninstalled mid-session).
 */
export function resolveStableNodeBinary(
  opts: ResolveOptions = {},
): ResolvedNodeBinary | null {
  const existsSync = opts.existsSyncOverride ?? fs.existsSync;
  const platform = opts.platformOverride ?? os.platform();
  const execPath = opts.execPathOverride ?? process.execPath;

  // 1. process.execPath as-is. Cheapest and almost always right.
  if (isExecutableFile(execPath, existsSync)) {
    return { path: execPath, source: 'execPath' };
  }

  // 2. Realpath of process.execPath. If execPath was a symlink at startup,
  //    Node resolves it during init — but in some Homebrew failure modes,
  //    the realpath target survives even when the original execPath has
  //    been swept up. Try it.
  try {
    const real = fs.realpathSync(execPath);
    if (real !== execPath && isExecutableFile(real, existsSync)) {
      return { path: real, source: 'execPath-realpath' };
    }
  } catch {
    // realpath fails if execPath is gone; continue to fallbacks.
  }

  // 3. Agent's bundled Node, if the caller knows where it lives.
  if (opts.agentBundledNode && isExecutableFile(opts.agentBundledNode, existsSync)) {
    return { path: opts.agentBundledNode, source: 'agent-bundled' };
  }

  // 4. Platform-stable absolute paths in order of preference.
  if (platform !== 'win32') {
    const candidates: Array<[string, ResolvedNodeBinary['source']]> = [
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

  // 5. Last resort: ask the OS where `node` lives on PATH.
  const whichResult = opts.whichOverride
    ? opts.whichOverride()
    : whichNode(platform);
  if (whichResult && isExecutableFile(whichResult, existsSync)) {
    return { path: whichResult, source: 'which' };
  }

  return null;
}

/**
 * Locate the first `node` on PATH via the platform's `which`/`where` tool.
 * Returns null on any failure — the caller has its own fallback chain.
 */
function whichNode(platform: NodeJS.Platform): string | null {
  try {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const result = spawnSync(cmd, ['node'], {
      encoding: 'utf-8',
      timeout: 5000,
    });
    if (result.status === 0 && result.stdout) {
      // `where` (Windows) can return multiple paths; take the first.
      const first = result.stdout.trim().split(/\r?\n/)[0];
      if (first) return first;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Convenience: returns just the path string, or null. Use the full
 * resolver when you need to log which fallback fired.
 */
export function resolveStableNodeBinaryPath(opts: ResolveOptions = {}): string | null {
  const resolved = resolveStableNodeBinary(opts);
  return resolved ? resolved.path : null;
}
