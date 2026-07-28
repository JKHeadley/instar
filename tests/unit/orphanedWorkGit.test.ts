// safe-git-allow: wiring-integrity test sets up a real temp git worktree to prove
// the OrphanedWorkSentinel git deps are not no-ops (Testing Integrity standard).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeOrphanedWorkSentinelDeps } from '../../src/monitoring/orphanedWorkGit.js';

/**
 * Wiring-integrity (Testing Integrity standard): the git/fs-backed deps are NOT
 * no-ops — they delegate to real git over a real temp worktree. Proves the load-
 * bearing production path (hasUncommittedWork / workSignature / lastActivityMs /
 * preserve) actually works end-to-end, not just the fake-deps classifier.
 */
describe('makeOrphanedWorkSentinelDeps — real git', () => {
  let root: string; let repo: string; let worktreesDir: string; let wt: string; let stateDir: string;
  const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf-8' });

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'owg-'));
    repo = path.join(root, 'repo');
    fs.mkdirSync(repo, { recursive: true });
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.email', 't@t.local'], repo);
    git(['config', 'user.name', 'T'], repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'init'], repo);
    // A worktree under <repo>/.worktrees/feature, with uncommitted work.
    worktreesDir = path.join(repo, '.worktrees');
    wt = path.join(worktreesDir, 'feature');
    git(['worktree', 'add', '-q', '-b', 'feature', wt], repo);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\n'); // tracked edit
    fs.writeFileSync(path.join(wt, 'untracked.txt'), 'new\n'); // untracked
    stateDir = path.join(root, 'state');
  });

  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function deps() {
    return makeOrphanedWorkSentinelDeps({
      instarRepo: repo,
      worktreesDir,
      stateDir,
      raiseAttention: () => {},
    });
  }

  it('lists the worktree under .worktrees/ (excludes the main checkout)', () => {
    const list = deps().listWorktrees();
    expect(list.map((w) => path.basename(w.path))).toContain('feature');
    expect(list.some((w) => path.basename(w.path) === 'repo')).toBe(false);
  });

  it('detects uncommitted work and produces a stable, change-sensitive signature', () => {
    const d = deps();
    expect(d.hasUncommittedWork(wt)).toBe(true);
    const sig1 = d.workSignature(wt);
    expect(sig1).toMatch(/^[0-9a-f]{12}$/);
    fs.writeFileSync(path.join(wt, 'a.txt'), 'one\ntwo\nthree\n');
    expect(d.workSignature(wt)).not.toBe(sig1); // new edit ⇒ new signature
  });

  it('reports a recent lastActivity for actively-edited files', () => {
    const last = deps().lastActivityMs(wt);
    expect(last).not.toBeNull();
    expect(Date.now() - (last as number)).toBeLessThan(60_000);
  });

  it('preserve() writes a non-destructive patch capturing tracked diff + untracked list', () => {
    const info = { path: wt, branch: 'feature', headSha: 'x' };
    deps().preserve(info);
    const patchesDir = path.join(stateDir, 'orphaned-work-patches');
    const files = fs.readdirSync(patchesDir);
    expect(files.length).toBeGreaterThan(0);
    const content = fs.readFileSync(path.join(patchesDir, files[0]), 'utf-8');
    expect(content).toMatch(/untracked\.txt/); // untracked file listed
    expect(content).toMatch(/\+two/); // tracked diff present
    // Non-destructive: the worktree still has its uncommitted changes.
    expect(deps().hasUncommittedWork(wt)).toBe(true);
  });
});
