/**
 * Unit tests — SafeGitExecutor `sourceTreeReadOk` opt + SOURCE_TREE_READ_TIER_VERBS.
 *
 * Layer B (ReleaseReadinessSentinel) and Layer C (FeatureRolloutReconciler
 * canonical scan) need to `git fetch` the canonical ref into the agent's own
 * instar checkout to do their job — and the agent home IS a source tree, so
 * SourceTreeGuard blocks fetch by default. This opt is the narrow, audited
 * escape hatch: data-pull verbs only (`fetch`), opt-in per call.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  SafeGitExecutor,
  SOURCE_TREE_READ_TIER_VERBS,
  DESTRUCTIVE_GIT_VERBS,
} from '../../src/core/SafeGitExecutor.js';
import { SourceTreeGuardError } from '../../src/core/SourceTreeGuard.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('SafeGitExecutor.sourceTreeReadOk', () => {
  let srcTree: string;
  let canon: string;
  let nonSrc: string;

  function git(cwd: string, args: string[]) {
    return SafeGitExecutor.run(args, { cwd, operation: 'tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts:git' });
  }

  beforeEach(() => {
    srcTree = fs.mkdtempSync(path.join(os.tmpdir(), 'sgx-src-'));
    git(srcTree, ['init', '-q', '-b', 'main']);
    git(srcTree, ['config', 'user.email', 't@t.l']);
    git(srcTree, ['config', 'user.name', 'T']);
    git(srcTree, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(srcTree, 'README.md'), '#');
    git(srcTree, ['add', '-A']);
    git(srcTree, ['commit', '-qm', 'init']);

    canon = fs.mkdtempSync(path.join(os.tmpdir(), 'sgx-canon-'));
    git(canon, ['init', '-q', '--bare']);
    git(srcTree, ['remote', 'add', 'canon', `file://${canon}`]);
    git(srcTree, ['push', '-q', 'canon', 'main']);

    nonSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'sgx-other-'));
    git(nonSrc, ['init', '-q', '-b', 'main']);
    git(nonSrc, ['config', 'user.email', 't@t.l']);
    git(nonSrc, ['config', 'user.name', 'T']);
    git(nonSrc, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(nonSrc, 'README.md'), '#');
    git(nonSrc, ['add', '-A']);
    git(nonSrc, ['commit', '-qm', 'init']);
    git(nonSrc, ['remote', 'add', 'origin', `file://${canon}`]);

    // NOW promote srcTree to "instar source tree" by making its `origin`
    // remote point at a canonical instar URL — that's what
    // SourceTreeGuard.layerRemoteUrl reads. Done last so the git init +
    // commits above didn't themselves trip the guard. `canon` remains as
    // a separate remote that the fetch-in-test actually uses.
    git(srcTree, ['remote', 'add', 'origin', 'https://github.com/dawn/instar.git']);
  });

  afterEach(() => {
    // Demote srcTree back to non-source-tree before SafeFsExecutor.safeRmSync
    // (which also refuses to delete a recognized instar source tree). Strip
    // the canonical-instar origin remote by overwriting .git/config with a
    // minimal config (writeFile is not a destructive-lint verb).
    try {
      const cfgPath = path.join(srcTree, '.git', 'config');
      const cfg = fs.readFileSync(cfgPath, 'utf-8').replace(/\[remote "origin"\][\s\S]*?(?=\n\[|$)/g, '');
      fs.writeFileSync(cfgPath, cfg);
    } catch { /* tolerate partial setup */ }
    for (const d of [srcTree, canon, nonSrc]) {
      SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts:afterEach' });
    }
  });

  it('defaults: fetch on a non-source tree works (no guard fires)', () => {
    expect(() => SafeGitExecutor.run(
      ['fetch', 'origin', 'main', '--no-tags', '--no-recurse-submodules'],
      { cwd: nonSrc, operation: 't:fetch-non-src' },
    )).not.toThrow();
  });

  it('defaults: fetch on a source tree IS BLOCKED by SourceTreeGuard', () => {
    expect(() => SafeGitExecutor.run(
      ['fetch', 'canon', 'main', '--no-tags', '--no-recurse-submodules'],
      { cwd: srcTree, operation: 't:fetch-src' },
    )).toThrow(SourceTreeGuardError);
  });

  it('sourceTreeReadOk + allowlist verb (fetch) → passes on a source tree', () => {
    expect(() => SafeGitExecutor.run(
      ['fetch', 'canon', 'main', '--no-tags', '--no-recurse-submodules'],
      { cwd: srcTree, operation: 't:fetch-allowed', sourceTreeReadOk: true },
    )).not.toThrow();
  });

  it('sourceTreeReadOk does NOT bypass for non-allowlist verbs (e.g. commit)', () => {
    fs.writeFileSync(path.join(srcTree, 'new.txt'), 'x');
    expect(() => SafeGitExecutor.run(
      ['add', 'new.txt'],
      { cwd: srcTree, operation: 't:add-not-allowlisted', sourceTreeReadOk: true },
    )).toThrow(SourceTreeGuardError);
  });

  it('SOURCE_TREE_READ_TIER_VERBS is a closed read-tier set — no destructive write verbs', () => {
    // Allowed read-tier verbs (data-pull + readonly used by LAYER B/C):
    expect(SOURCE_TREE_READ_TIER_VERBS.has('fetch')).toBe(true);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('rev-parse')).toBe(true);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('ls-tree')).toBe(true);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('show')).toBe(true);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('log')).toBe(true);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('merge-base')).toBe(true);
    // Must NEVER include verbs that modify the working tree or committed refs:
    expect(SOURCE_TREE_READ_TIER_VERBS.has('commit')).toBe(false);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('push')).toBe(false);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('reset')).toBe(false);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('checkout')).toBe(false);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('rebase')).toBe(false);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('merge')).toBe(false);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('clean')).toBe(false);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('rm')).toBe(false);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('branch')).toBe(false);
    expect(SOURCE_TREE_READ_TIER_VERBS.has('tag')).toBe(false);
    // Bounded — adding to this set requires a spec edit + side-effects review.
    expect(SOURCE_TREE_READ_TIER_VERBS.size).toBeLessThanOrEqual(10);
  });

  it('readSync path also honors sourceTreeReadOk — rev-parse on a source tree passes', () => {
    // rev-parse FETCH_HEAD after a fetch (which leaves FETCH_HEAD pointing at canon's main).
    SafeGitExecutor.run(
      ['fetch', 'canon', 'main', '--no-tags', '--no-recurse-submodules'],
      { cwd: srcTree, operation: 't:setup-fetch', sourceTreeReadOk: true },
    );
    expect(() => SafeGitExecutor.run(
      ['rev-parse', 'FETCH_HEAD'],
      { cwd: srcTree, operation: 't:revparse-allowed', sourceTreeReadOk: true },
    )).not.toThrow();
  });

  it('readSync path WITHOUT sourceTreeReadOk: rev-parse on a source tree is STILL blocked', () => {
    SafeGitExecutor.run(
      ['fetch', 'canon', 'main', '--no-tags', '--no-recurse-submodules'],
      { cwd: srcTree, operation: 't:setup-fetch2', sourceTreeReadOk: true },
    );
    expect(() => SafeGitExecutor.run(
      ['rev-parse', 'FETCH_HEAD'],
      { cwd: srcTree, operation: 't:revparse-default' },
    )).toThrow(SourceTreeGuardError);
  });
});
