/**
 * npmInvocation — regression tests for the version-manager npm wrapper bug.
 *
 * The better-sqlite3 self-heal paths ran `spawnSync(node, [npmPath, ...])`,
 * executing the npm bin file as a Node script. mise/asdf ship `bin/npm` as a
 * BASH wrapper, so Node parsed bash as JS and every heal attempt died with a
 * SyntaxError — the preflight then restored the wrong-ABI binary on every
 * boot, forever (observed live 2026-07-24 on a mise-managed Linux box).
 *
 * resolveNpmInvocation must never produce a `node <non-JS file>` invocation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveNpmInvocation } from '../../src/utils/npmInvocation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const NO_GLOBALS = { globalCandidates: [] as string[] };

describe('resolveNpmInvocation', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-invocation-test-'));
  });

  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/npm-invocation.test.ts:cleanup' }); } catch { /* cleanup */ }
  });

  /** Build <root>/bin + <root>/lib/node_modules/npm/bin/npm-cli.js */
  function makeNodeInstall(root: string, opts: { npmBin?: 'symlink' | 'bash-wrapper' | 'none' } = {}): {
    nodeBin: string; npmBin: string; npmCli: string;
  } {
    const binDir = path.join(root, 'bin');
    const cliDir = path.join(root, 'lib', 'node_modules', 'npm', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(cliDir, { recursive: true });
    const nodeBin = path.join(binDir, 'node');
    fs.writeFileSync(nodeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const npmCli = path.join(cliDir, 'npm-cli.js');
    fs.writeFileSync(npmCli, '// npm cli entry\n');
    const npmBin = path.join(binDir, 'npm');
    if (opts.npmBin === 'symlink') {
      fs.symlinkSync(path.relative(binDir, npmCli), npmBin);
    } else if (opts.npmBin === 'bash-wrapper') {
      // Mirrors mise's real wrapper: a bash script that delegates to npm-cli.js.
      fs.writeFileSync(npmBin, '#!/usr/bin/env bash\nset -euo pipefail\nexec node "$(dirname "$0")/../lib/node_modules/npm/bin/npm-cli.js" "$@"\n', { mode: 0o755 });
    }
    return { nodeBin, npmBin, npmCli };
  }

  it('prefers the npm-cli.js that ships with the target node', () => {
    const install = makeNodeInstall(path.join(tmp, 'node-a'), { npmBin: 'bash-wrapper' });
    const inv = resolveNpmInvocation(install.npmBin, install.nodeBin, NO_GLOBALS);
    expect(inv).not.toBeNull();
    expect(inv!.command).toBe(install.nodeBin);
    expect(inv!.argsPrefix).toEqual([install.npmCli]);
    expect(inv!.source).toBe('node-sibling-npm-cli');
  });

  it('resolves a symlinked bin/npm to its npm-cli.js target (standard layout)', () => {
    // node has NO sibling npm-cli (bare node dir) — npm lives elsewhere.
    const bareNodeDir = path.join(tmp, 'bare-node', 'bin');
    fs.mkdirSync(bareNodeDir, { recursive: true });
    const nodeBin = path.join(bareNodeDir, 'node');
    fs.writeFileSync(nodeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const install = makeNodeInstall(path.join(tmp, 'npm-home'), { npmBin: 'symlink' });
    const inv = resolveNpmInvocation(install.npmBin, nodeBin, NO_GLOBALS);
    expect(inv).not.toBeNull();
    expect(inv!.command).toBe(nodeBin);
    // realpath of the symlink IS npm-cli.js
    expect(inv!.argsPrefix).toEqual([fs.realpathSync(install.npmBin)]);
    expect(inv!.source).toBe('npm-path-js-entry');
  });

  it('NEVER runs a bash-wrapper npm under node — resolves the sibling npm-cli.js instead (mise/asdf layout)', () => {
    const bareNodeDir = path.join(tmp, 'bare-node', 'bin');
    fs.mkdirSync(bareNodeDir, { recursive: true });
    const nodeBin = path.join(bareNodeDir, 'node');
    fs.writeFileSync(nodeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const install = makeNodeInstall(path.join(tmp, 'mise-node'), { npmBin: 'bash-wrapper' });
    const inv = resolveNpmInvocation(install.npmBin, nodeBin, NO_GLOBALS);
    expect(inv).not.toBeNull();
    expect(inv!.command).toBe(nodeBin);
    expect(inv!.argsPrefix).toEqual([install.npmCli]);
    expect(inv!.source).toBe('npm-relative-npm-cli');
  });

  it('falls back to executing npm DIRECTLY when no npm-cli.js is locatable (never node <bash-script>)', () => {
    const bareNodeDir = path.join(tmp, 'bare-node', 'bin');
    fs.mkdirSync(bareNodeDir, { recursive: true });
    const nodeBin = path.join(bareNodeDir, 'node');
    fs.writeFileSync(nodeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // A lone shim with no lib/node_modules/npm anywhere near it (asdf shims dir).
    const shimDir = path.join(tmp, 'shims');
    fs.mkdirSync(shimDir, { recursive: true });
    const shim = path.join(shimDir, 'npm');
    fs.writeFileSync(shim, '#!/usr/bin/env bash\nexec asdf exec npm "$@"\n', { mode: 0o755 });

    const inv = resolveNpmInvocation(shim, nodeBin, NO_GLOBALS);
    expect(inv).not.toBeNull();
    expect(inv!.source).toBe('direct-exec');
    expect(inv!.command).toBe(shim);
    expect(inv!.argsPrefix).toEqual([]);
    // The load-bearing invariant: the command node executes must never be a
    // non-JS file. Here node is not involved at all.
    expect(inv!.command).not.toBe(nodeBin);
  });

  it('uses a provided global npm-cli.js candidate when nothing else resolves', () => {
    const bareNodeDir = path.join(tmp, 'bare-node', 'bin');
    fs.mkdirSync(bareNodeDir, { recursive: true });
    const nodeBin = path.join(bareNodeDir, 'node');
    fs.writeFileSync(nodeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const globalCli = path.join(tmp, 'global', 'npm-cli.js');
    fs.mkdirSync(path.dirname(globalCli), { recursive: true });
    fs.writeFileSync(globalCli, '// npm cli\n');

    const inv = resolveNpmInvocation(null, nodeBin, { globalCandidates: [globalCli] });
    expect(inv).not.toBeNull();
    expect(inv!.command).toBe(nodeBin);
    expect(inv!.argsPrefix).toEqual([globalCli]);
    expect(inv!.source).toBe('global-npm-cli');
  });

  it('returns null when npmPath is null and nothing is locatable', () => {
    const bareNodeDir = path.join(tmp, 'bare-node', 'bin');
    fs.mkdirSync(bareNodeDir, { recursive: true });
    const nodeBin = path.join(bareNodeDir, 'node');
    fs.writeFileSync(nodeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    expect(resolveNpmInvocation(null, nodeBin, NO_GLOBALS)).toBeNull();
  });
});
