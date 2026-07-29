import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitSyncManager, type GitSyncConfig } from '../../src/core/GitSync.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

/**
 * Regression test for the no-upstream silent-push bug (verified live on a real
 * two-machine mesh, 2026-05-28): init's connect-to-existing-repo path adds the
 * remote but never sets branch tracking, so GitSync's bare `git push` failed
 * with "no upstream branch" and the failure was swallowed — silently killing
 * ALL cross-machine lease sync. The fix makes commitAndPush upstream-aware:
 * it sets `-u origin <branch>` on the first push.
 *
 * Uses REAL git against temp repos (no execFileSync mock) so it proves actual
 * push behavior, not a recorded arg sequence.
 */

function git(cwd: string, args: string[]): string {
  return SafeGitExecutor.run(args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    operation: 'tests/unit/git-sync-push-upstream.test.ts:git',
  }).trim();
}

function mkIdentityManager() {
  return {
    loadRegistry: () => ({ machines: {} }),
    saveRegistry: () => {},
    loadRemoteIdentity: () => null,
    registryPath: '/tmp/registry.json',
  } as any;
}

function mkSecurityLog() {
  return { append: () => {}, query: () => [], getPath: () => '/tmp/sec.jsonl' } as any;
}

describe('GitSync.commitAndPush — upstream-aware push (no-upstream silent-push regression)', () => {
  let root: string;
  let work: string;
  let bare: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitsync-upstream-'));
    work = path.join(root, 'work');
    bare = path.join(root, 'remote.git');
    fs.mkdirSync(work, { recursive: true });

    // Bare remote (the shared substrate).
    git(root, ['init', '--bare', '-b', 'main', bare]);

    // Working repo with one commit on main — but DELIBERATELY no upstream set,
    // exactly like init's connect-to-existing-repo path leaves it.
    git(root, ['init', '-b', 'main', work]);
    git(work, ['config', 'user.email', 'test@instar.local']);
    git(work, ['config', 'user.name', 'test']);
    git(work, ['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(work, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(work, '.instar', 'seed.json'), '{"seed":1}');
    git(work, ['add', '.']);
    git(work, ['commit', '-m', 'seed']);
    git(work, ['remote', 'add', 'origin', bare]); // remote added, NO tracking
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, {
      recursive: true,
      force: true,
      operation: 'tests/unit/git-sync-push-upstream.test.ts:afterEach',
    });
  });

  function manager(): GitSyncManager {
    const cfg: GitSyncConfig = {
      projectDir: work,
      stateDir: path.join(work, '.instar'),
      identityManager: mkIdentityManager(),
      securityLog: mkSecurityLog(),
      machineId: 'm_testmachine',
      autoPush: true,
    };
    return new GitSyncManager(cfg);
  }

  it('pushes successfully and sets upstream even when the branch has no tracking', () => {
    // Precondition: no upstream → a bare `git push` would fail here.
    expect(() => git(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).toThrow();

    const mgr = manager();
    const f = path.join(work, '.instar', 'lease.json');
    fs.writeFileSync(f, '{"epoch":1}');
    const ok = mgr.commitAndPush('chore(mesh): lease epoch 1', [f]);

    expect(ok).toBe(true);
    // The commit actually reached the bare remote.
    const remoteHead = git(root, ['--git-dir', bare, 'rev-parse', 'main']);
    const localHead = git(work, ['rev-parse', 'HEAD']);
    expect(remoteHead).toBe(localHead);
    // Upstream tracking is now established for subsequent bare pushes.
    expect(git(work, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).toBe('origin/main');
  });

  it('keeps pushing on subsequent commits once upstream is set', () => {
    const mgr = manager();
    const f = path.join(work, '.instar', 'lease.json');

    fs.writeFileSync(f, '{"epoch":1}');
    expect(mgr.commitAndPush('epoch 1', [f])).toBe(true);

    fs.writeFileSync(f, '{"epoch":2}');
    expect(mgr.commitAndPush('epoch 2', [f])).toBe(true);

    const remoteHead = git(root, ['--git-dir', bare, 'rev-parse', 'main']);
    const localHead = git(work, ['rev-parse', 'HEAD']);
    expect(remoteHead).toBe(localHead);
    // Two mesh commits made it across.
    const count = git(root, ['--git-dir', bare, 'rev-list', '--count', 'main']);
    expect(Number(count)).toBeGreaterThanOrEqual(3); // seed + 2 epochs
  });

  it('returns false (no commit) when nothing is staged', () => {
    const mgr = manager();
    // Point at an unchanged tracked file → diff --cached is empty.
    expect(mgr.commitAndPush('noop', [path.join(work, '.instar', 'seed.json')])).toBe(false);
  });
});
