/**
 * AgentWorktreeReaper — the safety-critical classifier for reclaiming stale CLI
 * worktrees. THE hard requirement under test: NEVER delete unmerged or dirty
 * work. A worktree is reap-eligible ONLY when not-active AND clean AND merged AND
 * stale; any single failing gate ⇒ KEEP. Also covers dry-run (classify, never
 * delete), the blast-radius cap, and the merged-detection (git cherry) helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  AgentWorktreeReaper,
  type AgentWorktreeReaperDeps,
  type WorktreeInfo,
} from '../../src/monitoring/AgentWorktreeReaper.js';
import { isBranchMerged, resolveBaseRef, makeAgentWorktreeReaperDeps, type ReadGit } from '../../src/monitoring/agentWorktreeGit.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

const NOW = 1_000_000_000_000;

function wt(over: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return { path: '/wt/a', branch: 'echo/feature', headSha: 'abc', ...over };
}

/** Deps where every gate is "reapable" by default; tests flip one at a time. */
function deps(over: Partial<AgentWorktreeReaperDeps> = {}): AgentWorktreeReaperDeps {
  return {
    listWorktrees: () => [wt()],
    isClean: () => true,
    isMerged: () => true,
    isInUse: () => false,
    removeWorktree: vi.fn(),
    now: () => NOW,
    ...over,
  };
}

describe('AgentWorktreeReaper.evaluate — never reap unsafe worktrees', () => {
  const reap = (d: Partial<AgentWorktreeReaperDeps>) =>
    new AgentWorktreeReaper(deps(d), { enabled: true, dryRun: true }).evaluate(wt());

  it('reap-eligible only when not-in-use AND clean AND merged', () => {
    expect(reap({}).verdict).toBe('reap-eligible');
    expect(reap({}).reason).toBe('merged-clean-idle');
  });

  it('KEEPs an in-use worktree (lock or live process cwd)', () => {
    const e = reap({ isInUse: () => true });
    expect(e.verdict).toBe('keep'); expect(e.reason).toBe('in-use');
  });

  it('KEEPs a dirty worktree (uncommitted changes)', () => {
    const e = reap({ isClean: () => false });
    expect(e.verdict).toBe('keep'); expect(e.reason).toBe('uncommitted-changes');
  });

  it('KEEPs an unmerged worktree', () => {
    const e = reap({ isMerged: () => false });
    expect(e.verdict).toBe('keep'); expect(e.reason).toBe('unmerged');
  });

  it('KEEPs a detached/unknown-branch worktree', () => {
    const e = new AgentWorktreeReaper(deps(), { enabled: true }).evaluate(wt({ branch: null }));
    expect(e.verdict).toBe('keep'); expect(e.reason).toBe('detached-or-unknown-branch');
  });

  it('does NOT call isMerged (a git op) for a dirty or in-use worktree (cheap gates first)', () => {
    const isMerged = vi.fn(() => true);
    new AgentWorktreeReaper(deps({ isClean: () => false, isMerged }), { enabled: true }).evaluate(wt());
    expect(isMerged).not.toHaveBeenCalled();
  });
});

describe('AgentWorktreeReaper.reap — dry-run + blast radius', () => {
  it('dry-run classifies reap-eligible but NEVER deletes', async () => {
    const removeWorktree = vi.fn();
    const r = new AgentWorktreeReaper(deps({ removeWorktree }), { enabled: true, dryRun: true });
    const res = await r.reap();
    expect(res.dryRun).toBe(true);
    expect(res.evaluations[0].verdict).toBe('reap-eligible');
    expect(res.reaped).toEqual([]);
    expect(removeWorktree).not.toHaveBeenCalled();
  });

  it('live mode reaps eligible worktrees up to maxReapsPerPass', async () => {
    const removeWorktree = vi.fn();
    const many = Array.from({ length: 5 }, (_, i) => wt({ path: `/wt/${i}`, headSha: `s${i}` }));
    const r = new AgentWorktreeReaper(
      deps({ listWorktrees: () => many, removeWorktree }),
      { enabled: true, dryRun: false, maxReapsPerPass: 2 },
    );
    const res = await r.reap();
    expect(res.dryRun).toBe(false);
    expect(res.reaped).toHaveLength(2); // capped
    expect(removeWorktree).toHaveBeenCalledTimes(2);
  });

  it('snapshot reports the reclaimable count without side effects', () => {
    const removeWorktree = vi.fn();
    const snap = new AgentWorktreeReaper(deps({ removeWorktree }), { enabled: true, dryRun: true }).snapshot();
    expect(snap.reclaimable).toBe(1);
    expect(snap.dryRun).toBe(true);
    expect(removeWorktree).not.toHaveBeenCalled();
  });
});

describe('isBranchMerged (git cherry) — conservative, never false-positive', () => {
  const fakeGit = (cherryOut: string): ReadGit => (args) => {
    if (args.includes('cherry')) return cherryOut;
    throw new Error('unexpected git call');
  };

  it('merged when cherry output is empty (no commits ahead of base)', () => {
    expect(isBranchMerged(fakeGit(''), '/repo', 'main', 'sha')).toBe(true);
  });

  it('merged when every commit has an equivalent patch in base (all "-")', () => {
    expect(isBranchMerged(fakeGit('- aaa\n- bbb'), '/repo', 'main', 'sha')).toBe(true);
  });

  it('NOT merged when any commit is missing from base (a "+")', () => {
    expect(isBranchMerged(fakeGit('- aaa\n+ ccc'), '/repo', 'main', 'sha')).toBe(false);
  });

  it('NOT merged (KEEP) when cherry cannot be computed (git throws)', () => {
    const throwing: ReadGit = () => { throw new Error('no such ref'); };
    expect(isBranchMerged(throwing, '/repo', 'main', 'sha')).toBe(false);
  });
});

describe('makeAgentWorktreeReaperDeps.isInUse — lock OR live process cwd', () => {
  let tmp: string;
  beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-inuse-')); });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/agent-worktree-reaper.test.ts' }); });

  function mkWorktree(): { worktreesDir: string; wtA: string } {
    const worktreesDir = path.join(tmp, '.worktrees');
    const wtA = path.join(worktreesDir, 'a');
    fs.mkdirSync(wtA, { recursive: true });
    return { worktreesDir, wtA };
  }
  const mkDeps = (worktreesDir: string, cwdRoots: () => Set<string>) =>
    makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots });

  it('in-use when a live process cwd is inside the worktree', () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = mkDeps(worktreesDir, () => new Set([fs.realpathSync(wtA)]));
    expect(deps.isInUse(wtA)).toBe(true);
  });

  it('NOT in-use when no lock and no process cwd inside', () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = mkDeps(worktreesDir, () => new Set<string>());
    expect(deps.isInUse(wtA)).toBe(false);
  });

  it('in-use when a .session.lock is present (even with empty cwd set)', () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = mkDeps(worktreesDir, () => new Set<string>());
    fs.writeFileSync(path.join(wtA, '.session.lock'), '');
    expect(deps.isInUse(wtA)).toBe(true);
  });
});

describe('resolveBaseRef', () => {
  it('prefers the first ref that resolves', () => {
    const git: ReadGit = (args) => {
      const ref = args[args.length - 1];
      if (ref === 'refs/remotes/JKHeadley/main') return 'ok';
      throw new Error('no');
    };
    expect(resolveBaseRef(git, '/repo')).toBe('JKHeadley/main');
  });

  it('returns null when no base ref resolves', () => {
    const git: ReadGit = () => { throw new Error('no'); };
    expect(resolveBaseRef(git, '/repo')).toBeNull();
  });
});

/**
 * Integration: the REAL deps (real SafeGitExecutor, real git) against a repo
 * promoted to an instar source tree — the scenario the fake-git tests above
 * never exercised, which is exactly why the SourceTreeGuard blocked every reaper
 * git call in production and it reported 0 reclaimable. This is the regression
 * guard for that bug: if the guard ever stops permitting the reaper's reads /
 * non-forced remove against the source tree, these fail.
 */
describe('makeAgentWorktreeReaperDeps — real git against an instar source tree', () => {
  let repo: string;
  let worktreesDir: string;

  function g(cwd: string, args: string[]) {
    return SafeGitExecutor.run(args, { cwd, operation: 'tests/unit/agent-worktree-reaper.test.ts:setup' });
  }

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-repo-'));
    g(repo, ['init', '-q', '-b', 'main']);
    g(repo, ['config', 'user.email', 't@t.l']);
    g(repo, ['config', 'user.name', 'T']);
    g(repo, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(repo, 'README.md'), '#');
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-qm', 'init']);

    // Create the worktrees BEFORE promotion (so the `worktree add` itself is not
    // yet guarded). worktreesDir bounds which worktrees the reaper considers.
    worktreesDir = path.join(repo, '.worktrees');
    fs.mkdirSync(worktreesDir);
    // merged + clean → reclaimable
    g(repo, ['worktree', 'add', '-q', path.join(worktreesDir, 'merged'), '-b', 'feat-merged', 'HEAD']);
    // unmerged: a real new commit not in main
    g(repo, ['worktree', 'add', '-q', path.join(worktreesDir, 'unmerged'), '-b', 'feat-unmerged', 'HEAD']);
    fs.writeFileSync(path.join(worktreesDir, 'unmerged', 'new.txt'), 'x');
    g(path.join(worktreesDir, 'unmerged'), ['add', '-A']);
    g(path.join(worktreesDir, 'unmerged'), ['commit', '-qm', 'ahead']);
    // dirty: merged branch but uncommitted change
    g(repo, ['worktree', 'add', '-q', path.join(worktreesDir, 'dirty'), '-b', 'feat-dirty', 'HEAD']);
    fs.writeFileSync(path.join(worktreesDir, 'dirty', 'wip.txt'), 'uncommitted');

    // Promote repo to an instar source tree — now every reaper git call must go
    // through the source-tree bypass or it throws.
    g(repo, ['remote', 'add', 'origin', 'https://github.com/dawn/instar.git']);
  });

  afterEach(() => {
    try {
      const cfgPath = path.join(repo, '.git', 'config');
      const cfg = fs.readFileSync(cfgPath, 'utf-8').replace(/\[remote "origin"\][\s\S]*?(?=\n\[|$)/g, '');
      fs.writeFileSync(cfgPath, cfg);
    } catch { /* tolerate */ }
    SafeFsExecutor.safeRmSync(repo, { recursive: true, force: true, operation: 'tests/unit/agent-worktree-reaper.test.ts:afterEach' });
  });

  it('listWorktrees + isClean + isMerged all work against the source tree (no guard error)', () => {
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
    const list = deps.listWorktrees();
    // main checkout excluded by `within`; only the three under .worktrees/
    const byName = Object.fromEntries(list.map((w) => [path.basename(w.path), w]));
    expect(Object.keys(byName).sort()).toEqual(['dirty', 'merged', 'unmerged']);

    expect(deps.isClean(byName.merged.path)).toBe(true);
    expect(deps.isClean(byName.dirty.path)).toBe(false);

    expect(deps.isMerged(byName.merged)).toBe(true);
    expect(deps.isMerged(byName.unmerged)).toBe(false);
  });

  it('removeWorktree actually reclaims a merged+clean worktree through the guard', () => {
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
    const mergedPath = path.join(worktreesDir, 'merged');
    expect(fs.existsSync(mergedPath)).toBe(true);
    expect(() => deps.removeWorktree(mergedPath)).not.toThrow();
    expect(fs.existsSync(mergedPath)).toBe(false);
  });

  it('AgentWorktreeReaper end-to-end with real deps: reaps merged+clean, keeps dirty + unmerged', () => {
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
    const reaper = new AgentWorktreeReaper(deps, { enabled: true, dryRun: true });
    const verdicts = Object.fromEntries(
      deps.listWorktrees().map((w) => [path.basename(w.path), reaper.evaluate(w).verdict]),
    );
    expect(verdicts.merged).toBe('reap-eligible');
    expect(verdicts.dirty).not.toBe('reap-eligible');
    expect(verdicts.unmerged).not.toBe('reap-eligible');
  });
});
