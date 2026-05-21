// safe-git-allow: test-fixture-git — spins up a throwaway tmp repo to drive the guard under controlled state.
/**
 * Tests for scripts/pre-push-fixture-guard.js — Layer 3 of the
 * test-env-isolation defense (PRs #130/#277 root cause).
 *
 * Verifies the script refuses pushes whose ahead-of-upstream commits
 * carry fixture-author identities or classic fixture commit messages,
 * and lets clean commits through.
 *
 * We spin up a throwaway tmp git repo, give it a fake "upstream/main"
 * via a second local branch, and run the guard with cwd pointing at
 * the test repo. Inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE
 * from a pre-push host run is the very condition the guard exists to
 * survive — so we strip those explicitly to keep the test deterministic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sanitizedGitEnv } from '../../helpers/git-test-env.js';

const SCRIPT = path.resolve(__dirname, '../../../scripts/pre-push-fixture-guard.mjs');

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: sanitizedGitEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function commit(cwd: string, msg: string, opts?: { authorName?: string; authorEmail?: string; file?: string; content?: string }): void {
  const file = opts?.file ?? `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`;
  fs.writeFileSync(path.join(cwd, file), opts?.content ?? 'x');
  git(cwd, ['add', file]);
  const env: NodeJS.ProcessEnv = sanitizedGitEnv();
  env.GIT_AUTHOR_NAME = opts?.authorName ?? 'Real Dev';
  env.GIT_AUTHOR_EMAIL = opts?.authorEmail ?? 'dev@example.com';
  env.GIT_COMMITTER_NAME = env.GIT_AUTHOR_NAME;
  env.GIT_COMMITTER_EMAIL = env.GIT_AUTHOR_EMAIL;
  execFileSync('git', ['commit', '-m', msg], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function runGuard(cwd: string, extraEnv: NodeJS.ProcessEnv = {}): { exitCode: number; stderr: string; stdout: string } {
  const r = spawnSync('node', [SCRIPT], {
    cwd,
    env: { ...sanitizedGitEnv(), ...extraEnv },
    encoding: 'utf-8',
  });
  return { exitCode: r.status ?? -1, stderr: r.stderr, stdout: r.stdout };
}

describe('pre-push-fixture-guard', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'));
    git(repo, ['init', '--initial-branch=main', '-q']);
    git(repo, ['config', 'user.email', 'dev@example.com']);
    git(repo, ['config', 'user.name', 'Real Dev']);
    commit(repo, 'chore: initial real commit', { file: 'README.md', content: '# real\n' });
    // Create a fake remote pointer at the initial commit so the guard's
    // fallback resolver (which tries refs/remotes/upstream/main then
    // refs/remotes/origin/main via `rev-parse --verify`) finds a base.
    // We deliberately skip `git branch --set-upstream-to` because that
    // requires the ref to be on a real remote, and we want the test to
    // exercise the fallback path that matters for the pre-push hook in
    // a freshly cloned checkout where tracking isn't always configured.
    git(repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);
  });

  afterEach(() => {
    try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('passes when ahead commits are clean', () => {
    commit(repo, 'feat: legitimate work');
    commit(repo, 'fix: another real change');
    const r = runGuard(repo);
    expect(r.exitCode).toBe(0);
  });

  it('fails on fixture-identity author', () => {
    commit(repo, 'subject is fine here', { authorEmail: 'test@instar.local', authorName: 'Test' });
    const r = runGuard(repo);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('test@instar.local');
  });

  it('fails on "Initial commit" message even with a normal author', () => {
    commit(repo, 'Initial commit');
    const r = runGuard(repo);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Initial commit');
  });

  it('fails on "seed" message', () => {
    commit(repo, 'seed');
    const r = runGuard(repo);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('"seed"');
  });

  it('fails on "Worktree commit N" message', () => {
    commit(repo, 'Worktree commit 1');
    const r = runGuard(repo);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Worktree commit 1');
  });

  it('bypasses cleanly when INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP=1', () => {
    commit(repo, 'Initial commit');
    const r = runGuard(repo, { INSTAR_PRE_PUSH_FIXTURE_GUARD_SKIP: '1' });
    expect(r.exitCode).toBe(0);
  });
});
