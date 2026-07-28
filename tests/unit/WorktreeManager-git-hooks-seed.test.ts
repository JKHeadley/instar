/**
 * WorktreeManager git-hooks seeding — regression tests.
 *
 * Defect (framework-issue worktree-husky-shim-missing-gate-bypass): a fresh
 * `git worktree add` / `git clone` does NOT contain husky's git-ignored,
 * generated `.husky/_` shim, so with `core.hooksPath = .husky/_` git resolves
 * the hooksPath to a missing directory and silently runs NO hook — bypassing
 * the instar-dev pre-commit/pre-push enforcement until an install regenerates
 * the shim.
 *
 * seedGitHooks() closes this by seeding the shim from the source repo (and, on
 * the clone path where the fresh config has no hooksPath, replicating the
 * hooksPath config) so the gate is live from the first commit. It is generic
 * (never names husky), best-effort, and a no-op for non-husky / absolute-
 * hooksPath repos.
 *
 * The harness projectDir lives under tmp (outside agent home), so a spawn uses
 * the CLONE path by default; INSTAR_WORKTREE_FORCE_WORKTREE=1 forces the
 * `git worktree add` path.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTwoSessionHarness, type HarnessHandle } from '../fixtures/two-session-harness.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

let h: HarnessHandle;

beforeEach(async () => { h = await createTwoSessionHarness(); });
afterEach(() => { h.cleanup(); });

/**
 * Configure a husky-style relative hooksPath + an on-disk shim in the source
 * repo. The shim stays UNTRACKED (git-ignored in real husky), so a fresh
 * worktree/clone does not receive it — exactly the defect condition.
 */
function setupHusky(projectDir: string): void {
  SafeGitExecutor.execSync(
    ['-C', projectDir, 'config', 'core.hooksPath', '.husky/_'],
    { operation: 'tests/unit/WorktreeManager-git-hooks-seed.test.ts:setupHusky' },
  );
  const shim = path.join(projectDir, '.husky', '_');
  fs.mkdirSync(shim, { recursive: true });
  fs.writeFileSync(path.join(shim, 'pre-commit'), '#!/usr/bin/env sh\n. "${0%/*}/h"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(shim, 'h'), '#!/usr/bin/env sh\n# husky shim marker\n');
  // Deliberately NOT git-added — the `_` shim is git-ignored generated content.
}

function liveHooksPath(cwd: string): string {
  try {
    return SafeGitExecutor.readSync(
      ['-C', cwd, 'config', '--get', 'core.hooksPath'],
      { operation: 'tests/unit/WorktreeManager-git-hooks-seed.test.ts:read' },
    ).trim();
  } catch {
    return '';
  }
}

describe('WorktreeManager.seedGitHooks — clone path', () => {
  it('seeds the shim AND replicates the hooksPath config so gates are live', async () => {
    setupHusky(h.projectDir);
    const s = await h.spawn({ topicId: 5501, mode: 'dev', slug: 'hooks-clone' });
    expect(s.cwd).toBeDefined();

    // The git-ignored shim the clone lacked is now present…
    const seededPreCommit = path.join(s.cwd!, '.husky', '_', 'pre-commit');
    expect(fs.existsSync(seededPreCommit)).toBe(true);
    expect(fs.readFileSync(seededPreCommit, 'utf-8')).toContain('${0%/*}/h');
    // …and a fresh clone's empty config was given the hooksPath, so git will run it.
    expect(liveHooksPath(s.cwd!)).toBe('.husky/_');
  });
});

describe('WorktreeManager.seedGitHooks — worktree path', () => {
  it('seeds the shim into a `git worktree add` (hooksPath inherited)', async () => {
    const prev = process.env.INSTAR_WORKTREE_FORCE_WORKTREE;
    process.env.INSTAR_WORKTREE_FORCE_WORKTREE = '1';
    try {
      setupHusky(h.projectDir);
      const s = await h.spawn({ topicId: 5502, mode: 'dev', slug: 'hooks-wt' });
      expect(s.cwd).toBeDefined();
      expect(fs.existsSync(path.join(s.cwd!, '.husky', '_', 'pre-commit'))).toBe(true);
      // A worktree shares the source .git/config, so the inherited hooksPath now
      // resolves to a directory that actually exists.
      expect(liveHooksPath(s.cwd!)).toBe('.husky/_');
    } finally {
      if (prev === undefined) delete process.env.INSTAR_WORKTREE_FORCE_WORKTREE;
      else process.env.INSTAR_WORKTREE_FORCE_WORKTREE = prev;
    }
  });
});

describe('WorktreeManager.seedGitHooks — no-op boundaries', () => {
  it('non-husky repo: seeds nothing and does not throw', async () => {
    // The default harness has no hooksPath configured.
    const s = await h.spawn({ topicId: 5503, mode: 'dev', slug: 'no-husky' });
    expect(s.cwd).toBeDefined();
    expect(fs.existsSync(path.join(s.cwd!, '.husky'))).toBe(false);
    expect(liveHooksPath(s.cwd!)).toBe('');
  });

  it('absolute hooksPath: left untouched (resolves identically everywhere)', async () => {
    const abs = path.join(h.projectDir, '.husky', '_');
    SafeGitExecutor.execSync(
      ['-C', h.projectDir, 'config', 'core.hooksPath', abs],
      { operation: 'tests/unit/WorktreeManager-git-hooks-seed.test.ts:abs' },
    );
    fs.mkdirSync(abs, { recursive: true });
    fs.writeFileSync(path.join(abs, 'pre-commit'), '#!/usr/bin/env sh\n# abs\n');

    const s = await h.spawn({ topicId: 5504, mode: 'dev', slug: 'abs-hooks' });
    expect(s.cwd).toBeDefined();
    // An absolute hooksPath is a deliberate shared/user setup we never seed into
    // the worktree tree.
    expect(fs.existsSync(path.join(s.cwd!, '.husky', '_'))).toBe(false);
  });

  it('escaping hooksPath (`../evil`): refused, nothing written outside, worktree still created', async () => {
    SafeGitExecutor.execSync(
      ['-C', h.projectDir, 'config', 'core.hooksPath', '../evil-hooks'],
      { operation: 'tests/unit/WorktreeManager-git-hooks-seed.test.ts:escape' },
    );
    const s = await h.spawn({ topicId: 5505, mode: 'dev', slug: 'escape-hooks' });
    expect(s.cwd).toBeDefined();
    // The escaping relative path is refused by the containment check — no write
    // lands beside the worktree or the source, and creation is unaffected.
    expect(fs.existsSync(path.join(path.dirname(s.cwd!), 'evil-hooks'))).toBe(false);
    expect(fs.existsSync(path.join(path.dirname(h.projectDir), 'evil-hooks'))).toBe(false);
  });

  it('source has no shim to copy: warns and no-ops (no throw, no config set)', async () => {
    // hooksPath configured but the `.husky/_` shim is absent in the source.
    SafeGitExecutor.execSync(
      ['-C', h.projectDir, 'config', 'core.hooksPath', '.husky/_'],
      { operation: 'tests/unit/WorktreeManager-git-hooks-seed.test.ts:noshim-config' },
    );
    const warns: string[] = [];
    h.manager.on('warn', (m: string) => warns.push(String(m)));

    const s = await h.spawn({ topicId: 5506, mode: 'dev', slug: 'noshim-hooks' });
    expect(s.cwd).toBeDefined();
    // Nothing seeded (source had no shim), creation unaffected, and the miss is
    // surfaced as an advisory warn rather than silently swallowed.
    expect(fs.existsSync(path.join(s.cwd!, '.husky', '_'))).toBe(false);
    expect(warns.some((w) => w.includes('git-hooks shim not seeded'))).toBe(true);
  });
});
