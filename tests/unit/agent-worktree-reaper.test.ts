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
