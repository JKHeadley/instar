/**
 * npmInvocation — build a spawn argv that runs npm under a SPECIFIC Node binary.
 *
 * Background:
 *   The better-sqlite3 self-heal paths (ServerSupervisor preflight,
 *   NativeModuleHealer) must run npm under the SERVER's Node so the rebuilt
 *   native module targets the correct ABI. They did this by spawning
 *   `spawnSync(targetNode, [npmPath, ...args])` — i.e. executing the npm *bin*
 *   file as a Node script.
 *
 *   That works when `bin/npm` is the standard symlink to
 *   `lib/node_modules/npm/bin/npm-cli.js` (official tarballs, nvm, Homebrew).
 *   But Node version managers like mise and asdf ship `bin/npm` as a BASH
 *   WRAPPER script (mise's wraps npm to run `mise reshim` after global
 *   installs). Node strips the shebang and parses the bash body as
 *   JavaScript, so every heal attempt dies instantly with a SyntaxError:
 *
 *     SyntaxError: Unexpected identifier 'pipefail'
 *         ...
 *         at wrapModuleLoad (node:internal/modules/cjs/loader:255:19)
 *
 *   Observed live on ln 2026-07-24: every boot logged
 *   "better-sqlite3 version mismatch — rebuilding" followed by
 *   "rebuild could not produce a loadable module ... restored prior binary",
 *   with the truncated lastErr tail `oad (node:internal/modules/cjs/loader:255:19)`
 *   — the wrapper-script SyntaxError. The self-heal could never succeed and
 *   re-restored the wrong-ABI binary on every boot.
 *
 * Strategy (mirrors findNpmCli() in src/commands/server.ts, generalized):
 *   1. npm-cli.js relative to the TARGET Node's dir
 *      (<nodeDir>/../lib/node_modules/npm/bin/npm-cli.js) — the npm that
 *      ships WITH that Node, guaranteed version-compatible.
 *   2. If the given npm path resolves (through symlinks) to a JS entry,
 *      run that file under the target Node — the pre-existing behavior.
 *   3. npm-cli.js relative to the given npm path's REAL directory
 *      (<npmDir>/../lib/node_modules/npm/bin/npm-cli.js) — this is exactly
 *      the file mise's bash wrapper delegates to.
 *   4. Known global npm-cli.js locations.
 *   5. Last resort: execute the npm binary DIRECTLY (its own shebang runs
 *      it — bash wrappers and `#!/usr/bin/env node` entries both work).
 *      Callers pin PATH so `env node` resolves the target Node; this keeps
 *      the ABI correct in the common case and, unlike `node <bash-script>`,
 *      can actually succeed.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface NpmInvocation {
  /** The executable to spawn. */
  command: string;
  /** Args to place BEFORE the npm subcommand args (empty for direct exec). */
  argsPrefix: string[];
  /** Which resolution strategy produced this invocation (for logging/tests). */
  source:
    | 'node-sibling-npm-cli'
    | 'npm-path-js-entry'
    | 'npm-relative-npm-cli'
    | 'global-npm-cli'
    | 'direct-exec';
}

const GLOBAL_NPM_CLI_CANDIDATES = [
  '/opt/homebrew/lib/node_modules/npm/bin/npm-cli.js',
  '/usr/local/lib/node_modules/npm/bin/npm-cli.js',
  '/usr/lib/node_modules/npm/bin/npm-cli.js',
];

function isJsEntry(p: string): boolean {
  return p.endsWith('.js') || p.endsWith('.cjs') || p.endsWith('.mjs');
}

function npmCliRelativeTo(dir: string): string {
  return path.resolve(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
}

/**
 * Resolve how to invoke npm so it runs under `nodeBin`.
 *
 * @param npmPath  Path to an npm executable as found on disk (may be a
 *                 symlink to npm-cli.js OR a version-manager bash wrapper),
 *                 or null when the caller could not find one.
 * @param nodeBin  The Node binary the rebuild must target (ABI authority).
 * @param opts     Test seam: override the global npm-cli.js candidate list.
 * @returns        The invocation, or null when npmPath is null and no
 *                 npm-cli.js could be located near nodeBin.
 */
export function resolveNpmInvocation(
  npmPath: string | null,
  nodeBin: string,
  opts?: { globalCandidates?: string[] }
): NpmInvocation | null {
  const globalCandidates = opts?.globalCandidates ?? GLOBAL_NPM_CLI_CANDIDATES;
  // 1. The npm that ships with the target Node itself.
  const nodeSiblingCli = npmCliRelativeTo(path.dirname(nodeBin));
  if (fs.existsSync(nodeSiblingCli)) {
    return { command: nodeBin, argsPrefix: [nodeSiblingCli], source: 'node-sibling-npm-cli' };
  }
  // Also honor a symlinked nodeBin (e.g. <stateDir>/bin/node -> real install).
  try {
    const realNodeDir = path.dirname(fs.realpathSync(nodeBin));
    const realSiblingCli = npmCliRelativeTo(realNodeDir);
    if (fs.existsSync(realSiblingCli)) {
      return { command: nodeBin, argsPrefix: [realSiblingCli], source: 'node-sibling-npm-cli' };
    }
  } catch { /* nodeBin may not exist in tests — fall through */ }

  if (npmPath) {
    let realNpm = npmPath;
    try {
      realNpm = fs.realpathSync(npmPath);
    } catch { /* keep the given path */ }

    // 2. Standard layout: bin/npm is a symlink to npm-cli.js.
    if (isJsEntry(realNpm)) {
      return { command: nodeBin, argsPrefix: [realNpm], source: 'npm-path-js-entry' };
    }

    // 3. Version-manager wrapper layout: bin/npm is a shell script sitting
    //    beside lib/node_modules/npm/bin/npm-cli.js (mise, asdf plugins).
    const wrapperSiblingCli = npmCliRelativeTo(path.dirname(realNpm));
    if (fs.existsSync(wrapperSiblingCli)) {
      return { command: nodeBin, argsPrefix: [wrapperSiblingCli], source: 'npm-relative-npm-cli' };
    }
  }

  // 4. Known global npm-cli.js locations.
  for (const candidate of globalCandidates) {
    if (fs.existsSync(candidate)) {
      return { command: nodeBin, argsPrefix: [candidate], source: 'global-npm-cli' };
    }
  }

  // 5. Execute npm directly — NEVER `node <non-JS file>`. The caller's pinned
  //    PATH steers any `env node` / internal `node` call to the target Node.
  if (npmPath) {
    return { command: npmPath, argsPrefix: [], source: 'direct-exec' };
  }
  return null;
}
