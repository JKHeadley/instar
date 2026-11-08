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
  summarizeEnumerationError,
  MAX_ENUMERATION_ERROR_CHARS,
  type AgentWorktreeReaperDeps,
  type WorktreeInfo,
} from '../../src/monitoring/AgentWorktreeReaper.js';
import { buildInboundLinkIndex, isBranchMerged, resolveBaseRef, makeAgentWorktreeReaperDeps, fetchMergedPrHeadOids, REAPER_RESIDUE_DENYLIST, type ReadGit, type RunGh } from '../../src/monitoring/agentWorktreeGit.js';
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
    listWorktrees: () => ({ ok: true as const, worktrees: [wt()] }),
    isClean: () => true,
    isMerged: () => true,
    isInUse: () => false,
    currentBranch: () => 'echo/feature', // matches wt() default → reclaim race guard passes
    hasActiveBuildMarker: () => false,
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
      deps({ listWorktrees: () => ({ ok: true as const, worktrees: many }), removeWorktree }),
      { enabled: true, dryRun: false, maxReapsPerPass: 2 },
    );
    const res = await r.reap();
    expect(res.dryRun).toBe(false);
    expect(res.reaped).toHaveLength(2); // capped
    expect(removeWorktree).toHaveBeenCalledTimes(2);
  });
});

describe('AgentWorktreeReaper.reap — exec-time re-validation closes the enumerate→reclaim TOCTOU', () => {
  const liveReap = (d: Partial<AgentWorktreeReaperDeps>) =>
    new AgentWorktreeReaper(deps({ ...d }), { enabled: true, dryRun: false });

  it('(a) branch changed since eval (builder checked out a new unmerged branch) → KEEP, not reaped', async () => {
    // eval sees info.branch='echo/feature' merged/clean/idle ⇒ reap-eligible; at reclaim the
    // LIVE branch is a DIFFERENT one, so isMerged(info) is stale and must not authorize a delete.
    const removeWorktree = vi.fn();
    const res = await liveReap({ removeWorktree, currentBranch: () => 'echo/dashboard-f5f8' }).reap();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(res.reaped).toEqual([]);
    expect(res.evaluations[0].verdict).toBe('keep');
    expect(res.evaluations[0].reason).toBe('raced-changed-since-eval');
  });

  it('(b) worktree went dirty between eval and reclaim → KEEP', async () => {
    const removeWorktree = vi.fn();
    // clean at eval (1st call), dirty at the reclaim re-check (2nd)
    const isClean = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    const res = await liveReap({ removeWorktree, isClean }).reap();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(res.evaluations[0].reason).toBe('raced-now-dirty');
  });

  it('(c) worktree became in-use between eval and reclaim → KEEP', async () => {
    const removeWorktree = vi.fn();
    // idle at eval (1st), in-use at reclaim re-check (2nd)
    const isInUse = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const res = await liveReap({ removeWorktree, isInUse }).reap();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(res.evaluations[0].reason).toBe('raced-now-in-use');
  });

  it('(d) an .instar-build-active marker at reclaim time → KEEP (builder claim honored)', async () => {
    const removeWorktree = vi.fn();
    const res = await liveReap({ removeWorktree, hasActiveBuildMarker: () => true }).reap();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(res.evaluations[0].reason).toBe('raced-build-active-marker');
  });

  it('(e) genuinely still merged-clean-idle-unchanged at reclaim → REAPS (unchanged happy path)', async () => {
    const removeWorktree = vi.fn();
    const res = await liveReap({ removeWorktree }).reap(); // defaults: branch matches, no marker
    expect(removeWorktree).toHaveBeenCalledTimes(1);
    expect(res.reaped).toHaveLength(1);
    expect(res.evaluations[0].verdict).toBe('reap-eligible');
  });

  it('fail-closed: currentBranch read error (returns null) ≠ info.branch → KEEP, never reap on an unreadable branch', async () => {
    const removeWorktree = vi.fn();
    const res = await liveReap({ removeWorktree, currentBranch: () => null }).reap();
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(res.evaluations[0].reason).toBe('raced-changed-since-eval');
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

describe('fetchMergedPrHeadOids — gh-backed multi-commit-squash detection', () => {
  const ghOut = (rows: Array<{ headRefName: string; headRefOid: string }>): RunGh => () => JSON.stringify(rows);

  it('parses gh merged-PR JSON into a headRefName→headRefOid map', () => {
    const m = fetchMergedPrHeadOids('/repo', { runGh: ghOut([
      { headRefName: 'echo/feat-a', headRefOid: 'oidA' },
      { headRefName: 'echo/feat-b', headRefOid: 'oidB' },
    ]) });
    expect(m.get('echo/feat-a')).toBe('oidA');
    expect(m.get('echo/feat-b')).toBe('oidB');
    expect(m.size).toBe(2);
  });

  it('keeps the FIRST (newest) entry when a branch name is reused', () => {
    const m = fetchMergedPrHeadOids('/repo', { runGh: ghOut([
      { headRefName: 'echo/reused', headRefOid: 'newest' },
      { headRefName: 'echo/reused', headRefOid: 'older' },
    ]) });
    expect(m.get('echo/reused')).toBe('newest');
  });

  it('fail-safe to EMPTY map when gh is unavailable (null) — conservative KEEP', () => {
    const m = fetchMergedPrHeadOids('/repo', { runGh: () => null });
    expect(m.size).toBe(0);
  });

  it('fail-safe to EMPTY map on malformed JSON', () => {
    const m = fetchMergedPrHeadOids('/repo', { runGh: () => 'not json' });
    expect(m.size).toBe(0);
  });

  it('ignores rows missing name or oid', () => {
    const m = fetchMergedPrHeadOids('/repo', { runGh: () => JSON.stringify([
      { headRefName: 'ok', headRefOid: 'oidOk' },
      { headRefName: '', headRefOid: 'x' },
      { headRefOid: 'noName' },
      { headRefName: 'noOid' },
    ]) });
    expect(m.get('ok')).toBe('oidOk');
    expect(m.size).toBe(1);
  });
});

describe('makeAgentWorktreeReaperDeps.isMerged — multi-commit squash via PR map', () => {
  // readGit: rev-parse resolves a base; cherry reports UNMERGED (a "+" commit),
  // which is exactly the multi-commit-squash blind spot.
  const cherryUnmergedGit: ReadGit = (args) => {
    if (args.includes('rev-parse')) return ''; // base resolves
    if (args.includes('cherry')) return '+ aaa\n+ bbb'; // looks unmerged
    throw new Error('unexpected git call: ' + args.join(' '));
  };
  const wt = (branch: string, headSha: string) => ({ path: '/x', branch, headSha });

  it('MERGED when cherry says unmerged but a merged PR head-OID matches exactly', () => {
    const deps = makeAgentWorktreeReaperDeps({
      instarRepo: '/repo', worktreesDir: '/repo/.worktrees', readGit: cherryUnmergedGit,
      githubMergeCheck: true,
      mergedPrMap: () => new Map([['echo/feat', 'SQUASHED_OID']]),
    });
    expect(deps.isMerged(wt('echo/feat', 'SQUASHED_OID'))).toBe(true);
  });

  it('KEEP when the branch advanced past the merged PR (head-OID mismatch = unmerged work)', () => {
    const deps = makeAgentWorktreeReaperDeps({
      instarRepo: '/repo', worktreesDir: '/repo/.worktrees', readGit: cherryUnmergedGit,
      githubMergeCheck: true,
      mergedPrMap: () => new Map([['echo/feat', 'MERGED_OID']]),
    });
    // worktree HEAD is a NEW commit added after the merge → must be KEPT
    expect(deps.isMerged(wt('echo/feat', 'NEWER_OID_WITH_UNMERGED_WORK'))).toBe(false);
  });

  it('KEEP when no merged PR exists for the branch', () => {
    const deps = makeAgentWorktreeReaperDeps({
      instarRepo: '/repo', worktreesDir: '/repo/.worktrees', readGit: cherryUnmergedGit,
      githubMergeCheck: true,
      mergedPrMap: () => new Map(),
    });
    expect(deps.isMerged(wt('echo/feat', 'anySha'))).toBe(false);
  });

  it('KEEP (legacy cherry-only) when githubMergeCheck is disabled — never calls the PR map', () => {
    const prMap = vi.fn(() => new Map([['echo/feat', 'SQUASHED_OID']]));
    const deps = makeAgentWorktreeReaperDeps({
      instarRepo: '/repo', worktreesDir: '/repo/.worktrees', readGit: cherryUnmergedGit,
      githubMergeCheck: false,
      mergedPrMap: prMap,
    });
    expect(deps.isMerged(wt('echo/feat', 'SQUASHED_OID'))).toBe(false);
    expect(prMap).not.toHaveBeenCalled();
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
  const mkDeps = (worktreesDir: string, cwdRoots: () => Set<string>) => {
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots,
      commandLines: () => [], inboundLinks: async () => new Set<string>() });
    return deps;
  };

  it('in-use when a live process cwd is inside the worktree', () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = mkDeps(worktreesDir, () => new Set([fs.realpathSync(wtA)]));
    expect(deps.isInUse(wtA)).toBe(true);
  });

  it('NOT in-use when no lock and no process cwd inside', async () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = mkDeps(worktreesDir, () => new Set<string>());
    await deps.preparePass!();
    expect(deps.isInUse(wtA)).toBe(false);
  });

  it('in-use until the inbound-link index has been built, and when it failed (disk-steward §4)', async () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = mkDeps(worktreesDir, () => new Set<string>());
    expect(deps.isInUse(wtA)).toBe(true);
    const failed = makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots: () => new Set<string>(),
      commandLines: () => [], inboundLinks: async () => null });
    await failed.preparePass!();
    expect(failed.isInUse(wtA)).toBe(true);
  });

  it('in-use when another checkout or pipeline folder links into it, including through a chain', async () => {
    const { worktreesDir, wtA } = mkWorktree();
    const wtB = path.join(worktreesDir, 'b');
    const wtC = path.join(worktreesDir, 'c');
    fs.mkdirSync(path.join(wtA, 'node_modules'), { recursive: true });
    fs.mkdirSync(wtB); fs.mkdirSync(wtC);
    // b links into a; c links into b's link (a chain): removing b breaks c.
    fs.symlinkSync('../a/node_modules', path.join(wtB, 'node_modules'));
    fs.symlinkSync('../b/node_modules', path.join(wtC, 'node_modules'));
    const lanes = path.join(tmp, '.instar', 'lanes', 'x-artifacts');
    fs.mkdirSync(lanes, { recursive: true });
    const wtD = path.join(worktreesDir, 'd');
    fs.mkdirSync(wtD);
    fs.symlinkSync(wtD, path.join(lanes, 'head'));
    const index = await buildInboundLinkIndex(tmp, worktreesDir);
    expect(index).not.toBeNull();
    const real = (x: string) => fs.realpathSync(x);
    expect(index!.linked.has(real(wtA))).toBe(true);
    expect(index!.linked.has(real(wtB))).toBe(true); // lexical target of c's link
    expect(index!.linked.has(real(wtD))).toBe(true); // linked from the pipeline lanes
    expect(index!.linked.has(real(wtC))).toBe(false); // nothing links into c
    // A folder this account owns but cannot read makes the index unknown.
    const locked = path.join(lanes, 'locked');
    fs.mkdirSync(locked); fs.chmodSync(locked, 0o000);
    try { expect(await buildInboundLinkIndex(tmp, worktreesDir)).toBeNull(); }
    finally { fs.chmodSync(locked, 0o700); }
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots: () => new Set<string>(), commandLines: () => [] });
    await deps.preparePass!();
    expect(deps.isInUse(wtB)).toBe(true);
    expect(deps.isInUse(wtC)).toBe(false);
  });

  it('in-use when a .session.lock is present (even with empty cwd set)', () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = mkDeps(worktreesDir, () => new Set<string>());
    fs.writeFileSync(path.join(wtA, '.session.lock'), '');
    expect(deps.isInUse(wtA)).toBe(true);
  });

  it('in-use when a running process was started from files inside the worktree (disk-steward §4)', () => {
    const { worktreesDir, wtA } = mkWorktree();
    const real = fs.realpathSync(wtA);
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots: () => new Set<string>(),
      commandLines: () => ['/usr/bin/zsh', `node ${real}/dist/commands/server.js --foreground`] });
    expect(deps.isInUse(wtA)).toBe(true);
  });

  it('a relative or ~ spelling of the worktree in a command line also counts', () => {
    const { worktreesDir, wtA } = mkWorktree();
    for (const cmd of ['node .worktrees/a/dist/cli.js server start', "bash -c 'cd ~/.instar/agents/echo/.worktrees/a && npm test'"]) {
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots: () => new Set<string>(),
        commandLines: () => [cmd] });
      expect(deps.isInUse(wtA)).toBe(true);
    }
  });

  it('an index walk that started earlier but finished later never replaces a newer one', async () => {
    const { worktreesDir, wtA } = mkWorktree();
    const real = fs.realpathSync(wtA);
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    let call = 0;
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots: () => new Set<string>(), commandLines: () => [],
      inboundLinks: async () => { call++; if (call === 1) { await slow; return new Set<string>(); } return new Set([real]); } });
    const older = deps.preparePass!();
    await deps.preparePass!(); // newer walk sees a link into a
    release(); await older;   // the older walk finishes last, without the link
    expect(deps.isInUse(wtA)).toBe(true);
  });

  it('a file:// URL or a PATH-style list naming the worktree also counts', () => {
    const { worktreesDir, wtA } = mkWorktree();
    const real = fs.realpathSync(wtA);
    for (const cmd of [`node --import file://${real}/dist/a.js x`, `env NODE_PATH=/a:${real}/node_modules node x`]) {
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots: () => new Set<string>(),
        commandLines: () => [cmd] });
      expect(deps.isInUse(wtA)).toBe(true);
    }
  });

  it('a sibling whose name only shares a prefix does not count', async () => {
    const { worktreesDir, wtA } = mkWorktree();
    const real = fs.realpathSync(wtA);
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots: () => new Set<string>(),
      commandLines: () => [`node ${real}b/dist/cli.js`], inboundLinks: async () => new Set<string>() });
    await deps.preparePass!();
    expect(deps.isInUse(wtA)).toBe(false);
  });

  it('in-use when the working-folder scan cannot run', async () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots: () => null,
      commandLines: () => [], inboundLinks: async () => new Set<string>() });
    await deps.preparePass!();
    expect(deps.isInUse(wtA)).toBe(true);
  });

  it('in-use when the process list cannot be read', () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots: () => new Set<string>(),
      commandLines: () => null });
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
    const enumeration = deps.listWorktrees();
    expect(enumeration.ok).toBe(true); // real git against a real repo ⇒ success state
    if (!enumeration.ok) throw new Error('enumeration failed: ' + enumeration.error);
    const list = enumeration.worktrees;
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

  it('keeps a merged checkout with ignored unique files that git would delete without --force', () => {
    const mergedPath = path.join(worktreesDir, 'merged');
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\naudit-data/\n');
    fs.mkdirSync(path.join(mergedPath, 'audit-data'));
    fs.writeFileSync(path.join(mergedPath, 'audit-data', 'unique.txt'), 'preserve this');

    const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
    expect(deps.isClean(mergedPath)).toBe(false);
    expect(fs.readFileSync(path.join(mergedPath, 'audit-data', 'unique.txt'), 'utf8')).toBe('preserve this');
  });

  it('keeps ignored files under a generated-output directory', () => {
    const mergedPath = path.join(worktreesDir, 'merged');
    fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\ndist/\n');
    fs.mkdirSync(path.join(mergedPath, 'dist'));
    fs.writeFileSync(path.join(mergedPath, 'dist', 'unique.txt'), 'preserve this too');
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
    expect(deps.isClean(mergedPath)).toBe(false);
  });

  describe('regenerable ignored folders (disk-steward §4)', () => {
    const ignore = (line: string) => fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), `\n${line}\n`);
    // Commit a tracked file on the merged branch and fast-forward main to it. The
    // repo is promoted to an instar source tree in beforeEach (guarded), so the
    // commit runs with the promotion briefly removed, as afterEach does.
    const commitOnMerged = (mergedPath: string, file: string, body: string) => {
      const cfgPath = path.join(repo, '.git', 'config');
      const saved = fs.readFileSync(cfgPath, 'utf-8');
      fs.writeFileSync(cfgPath, saved.replace(/\[remote "origin"\][\s\S]*?(?=\n\[|$)/g, ''));
      try {
        fs.writeFileSync(path.join(mergedPath, file), body);
        g(mergedPath, ['add', file]);
        g(mergedPath, ['commit', '-qm', file]);
        g(repo, ['merge', '-q', '--ff-only', 'feat-merged']);
      } finally {
        fs.writeFileSync(cfgPath, saved);
      }
    };

    it('a node_modules symlink does not keep a merged checkout, and removal leaves its target intact', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-shared-nm-'));
      fs.writeFileSync(path.join(shared, 'keep.txt'), 'shared install');
      ignore('node_modules');
      fs.symlinkSync(shared, path.join(mergedPath, 'node_modules'));
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
      expect(deps.isClean(mergedPath)).toBe(true);
      deps.removeWorktree(mergedPath);
      expect(fs.existsSync(mergedPath)).toBe(false);
      expect(fs.readFileSync(path.join(shared, 'keep.txt'), 'utf8')).toBe('shared install');
      SafeFsExecutor.safeRmSync(shared, { recursive: true, force: true, operation: 'tests/unit/agent-worktree-reaper.test.ts:shared' });
    });

    it('a real node_modules directory, at any depth, keeps the checkout', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      ignore('node_modules/');
      fs.mkdirSync(path.join(mergedPath, 'pkg'));
      commitOnMerged(mergedPath, 'pkg/package.json', '{}');
      fs.mkdirSync(path.join(mergedPath, 'pkg', 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(mergedPath, 'pkg', 'node_modules', 'dep', 'index.js'), 'maybe patched by hand');
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
      expect(deps.isClean(mergedPath)).toBe(false);
      expect(() => deps.removeWorktree(mergedPath)).toThrow(/not gate-records-only/);
      expect(fs.existsSync(path.join(mergedPath, 'pkg', 'node_modules', 'dep', 'index.js'))).toBe(true);
    });

    it('a nested node_modules symlink is regenerable', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      ignore('node_modules');
      fs.mkdirSync(path.join(mergedPath, 'pkg'));
      commitOnMerged(mergedPath, 'pkg/package.json', '{}');
      const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-shared-nm2-'));
      fs.symlinkSync(shared, path.join(mergedPath, 'pkg', 'node_modules'));
      expect(makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir }).isClean(mergedPath)).toBe(true);
      SafeFsExecutor.safeRmSync(shared, { recursive: true, force: true, operation: 'tests/unit/agent-worktree-reaper.test.ts:shared2' });
    });

    it('root dist/ is regenerable only when every file maps back to compiled source', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      ignore('dist/');
      fs.mkdirSync(path.join(mergedPath, 'dist', 'data'), { recursive: true });
      for (const f of ['cli.js', 'cli.d.ts', 'cli.js.map', 'cli.d.ts.map']) fs.writeFileSync(path.join(mergedPath, 'dist', f), 'built');
      fs.writeFileSync(path.join(mergedPath, 'dist', 'data', 'manifest.json'), '{}'); // written by the build script
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
      expect(deps.isClean(mergedPath)).toBe(false); // no build config: not corroborated
      fs.mkdirSync(path.join(mergedPath, 'src'));
      commitOnMerged(mergedPath, 'src/cli.ts', 'export {}');
      commitOnMerged(mergedPath, 'tsconfig.json', '{\n  // build\n  "compilerOptions": { "outDir": "./dist/", "rootDir": "src" }\n}\n');
      expect(deps.isClean(mergedPath)).toBe(true);
      // A hand-placed file with no source behind it keeps the checkout.
      fs.writeFileSync(path.join(mergedPath, 'dist', 'hotfix.js'), 'hand written');
      expect(deps.isClean(mergedPath)).toBe(false);
      SafeFsExecutor.safeUnlinkSync(path.join(mergedPath, 'dist', 'hotfix.js'), { operation: 'tests/unit/agent-worktree-reaper.test.ts' });
      fs.writeFileSync(path.join(mergedPath, 'dist', 'notes.txt'), 'hand written');
      expect(deps.isClean(mergedPath)).toBe(false);
      SafeFsExecutor.safeUnlinkSync(path.join(mergedPath, 'dist', 'notes.txt'), { operation: 'tests/unit/agent-worktree-reaper.test.ts' });
      // A compiler output edited by hand after the build falls outside the build window.
      const later = new Date(Date.now() + 60 * 60_000);
      fs.utimesSync(path.join(mergedPath, 'dist', 'cli.js'), later, later);
      expect(deps.isClean(mergedPath)).toBe(false);
      const now = new Date();
      fs.utimesSync(path.join(mergedPath, 'dist', 'cli.js'), now, now);
      deps.removeWorktree(mergedPath);
      expect(fs.existsSync(mergedPath)).toBe(false);
    });

    it('a nested dist/ and an unknown ignored folder still keep the checkout', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      fs.mkdirSync(path.join(mergedPath, 'src'));
      commitOnMerged(mergedPath, 'src/cli.ts', 'export {}');
      commitOnMerged(mergedPath, 'tsconfig.json', '{"compilerOptions":{"outDir":"dist","rootDir":"src"}}');
      ignore('dist/');
      fs.mkdirSync(path.join(mergedPath, 'notes', 'dist'), { recursive: true });
      fs.writeFileSync(path.join(mergedPath, 'notes', 'dist', 'mine.md'), 'hand written');
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
      expect(deps.isClean(mergedPath)).toBe(false);
      expect(() => deps.removeWorktree(mergedPath)).toThrow(/not gate-records-only/);
      expect(fs.readFileSync(path.join(mergedPath, 'notes', 'dist', 'mine.md'), 'utf8')).toBe('hand written');
    });

    it('a coverage/ folder keeps the checkout (no rule for it)', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      ignore('coverage/');
      fs.mkdirSync(path.join(mergedPath, 'coverage'));
      fs.writeFileSync(path.join(mergedPath, 'coverage', 'lcov.info'), 'x');
      commitOnMerged(mergedPath, 'vitest.config.ts', 'export default {}');
      expect(makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir }).isClean(mergedPath)).toBe(false);
    });
  });

  describe('commit gate records', () => {
    const decision = '.instar/instar-dev-decisions/2026-10-23T19-33-42-871Z-some-change.json';
    const trace = '.instar/instar-dev-traces/2026-10-26T07-42-44-062Z-some-change-6648946c.json';
    const write = (root: string, rel: string, body: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    };

    it('archives an untracked decision record, then reclaims the checkout', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      write(mergedPath, decision, '{"d":1}');
      const archive = path.join(repo, 'archive');
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir, gateRecordArchiveDir: archive });
      expect(deps.isClean(mergedPath)).toBe(true);
      deps.removeWorktree(mergedPath);
      expect(fs.existsSync(mergedPath)).toBe(false);
      expect(fs.readFileSync(path.join(archive, 'merged', decision), 'utf8')).toBe('{"d":1}');
      expect(fs.readFileSync(path.join(archive, '.gitignore'), 'utf8')).toBe('*\n');
    });

    it('defaults the archive to the agent home', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      write(mergedPath, decision, '{"d":2}');
      makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir }).removeWorktree(mergedPath);
      expect(fs.readFileSync(path.join(repo, '.instar', 'instar-dev-decisions-archive', 'merged', decision), 'utf8')).toBe('{"d":2}');
    });

    it('archives an ignored trace, which git would otherwise delete silently', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), `\n${trace}\n`);
      write(mergedPath, trace, 'ignored');
      // A sibling keeps git listing the file rather than collapsing the folder, as the real tracked folder does.
      const sibling = trace.replace('6648946c', 'bbbbbbbb');
      write(mergedPath, sibling, 'untracked');
      const archive = path.join(repo, 'archive');
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir, gateRecordArchiveDir: archive });
      expect(deps.isClean(mergedPath)).toBe(true);
      deps.removeWorktree(mergedPath);
      expect(fs.existsSync(mergedPath)).toBe(false);
      expect(fs.readFileSync(path.join(archive, 'merged', trace), 'utf8')).toBe('ignored');
      expect(fs.readFileSync(path.join(archive, 'merged', sibling), 'utf8')).toBe('untracked');
    });

    it('keeps the checkout when git reports a whole record folder rather than named files', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), `\n${trace}\n`);
      write(mergedPath, trace, 'ignored');
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir, gateRecordArchiveDir: path.join(repo, 'archive') });
      expect(deps.isClean(mergedPath)).toBe(false);
    });

    it('never overwrites an archived record that holds different bytes', () => {
      const archive = path.join(repo, 'archive');
      write(path.join(archive, 'merged'), decision, 'older');
      const mergedPath = path.join(worktreesDir, 'merged');
      write(mergedPath, decision, 'newer');
      makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir, gateRecordArchiveDir: archive }).removeWorktree(mergedPath);
      const folder = path.dirname(path.join(archive, 'merged', decision));
      const contents = fs.readdirSync(folder).map((f) => fs.readFileSync(path.join(folder, f), 'utf8')).sort();
      expect(contents).toEqual(['newer', 'older']);
    });

    it('keeps the checkout when real work sits beside a record, and changes nothing', () => {
      const dirtyPath = path.join(worktreesDir, 'dirty');
      write(dirtyPath, decision, '{"d":3}');
      const archive = path.join(repo, 'archive');
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir, gateRecordArchiveDir: archive });
      expect(deps.isClean(dirtyPath)).toBe(false);
      expect(() => deps.removeWorktree(dirtyPath)).toThrow(/not gate-records-only/);
      expect(fs.existsSync(path.join(dirtyPath, decision))).toBe(true);
      expect(fs.existsSync(archive)).toBe(false);
    });

    it('keeps the checkout when an ignored non-record file sits beside a record', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      write(mergedPath, decision, '{"d":4}');
      fs.appendFileSync(path.join(repo, '.git', 'info', 'exclude'), '\ndist/\n');
      write(mergedPath, 'dist/out.js', 'built');
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir, gateRecordArchiveDir: path.join(repo, 'archive') });
      expect(deps.isClean(mergedPath)).toBe(false);
      expect(() => deps.removeWorktree(mergedPath)).toThrow(/not gate-records-only/);
      expect(fs.existsSync(mergedPath)).toBe(true);
    });

    it('keeps a symlink posing as a record, and leaves it in place', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      fs.mkdirSync(path.dirname(path.join(mergedPath, decision)), { recursive: true });
      fs.symlinkSync(path.join(repo, 'README.md'), path.join(mergedPath, decision));
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir, gateRecordArchiveDir: path.join(repo, 'archive') });
      expect(() => deps.removeWorktree(mergedPath)).toThrow(/not a regular file/);
      expect(fs.lstatSync(path.join(mergedPath, decision)).isSymbolicLink()).toBe(true);
    });

    it('leaves the records alone on a locked checkout', () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      write(mergedPath, decision, '{"d":7}');
      fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'merged', 'locked'), 'held');
      const archive = path.join(repo, 'archive');
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir, gateRecordArchiveDir: archive });
      expect(() => deps.removeWorktree(mergedPath)).toThrow(/locked/);
      expect(fs.existsSync(path.join(mergedPath, decision))).toBe(true);
      expect(fs.existsSync(archive)).toBe(false);
    });

    it('a dry run touches neither the records nor the checkout', async () => {
      const mergedPath = path.join(worktreesDir, 'merged');
      write(mergedPath, decision, '{"d":6}');
      const archive = path.join(repo, 'archive');
      const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir, gateRecordArchiveDir: archive, cwdRoots: () => new Set() });
      const result = await new AgentWorktreeReaper(deps, { enabled: true, dryRun: true }).reap();
      expect(result.reaped).toEqual([]);
      expect(fs.existsSync(path.join(mergedPath, decision))).toBe(true);
      expect(fs.existsSync(archive)).toBe(false);
    });
  });

  it('AgentWorktreeReaper end-to-end with real deps: reaps merged+clean, keeps dirty + unmerged', async () => {
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
    const reaper = new AgentWorktreeReaper(deps, { enabled: true, dryRun: true });
    await reaper.prepare(); // builds the real inbound-link index
    const enumeration = deps.listWorktrees();
    if (!enumeration.ok) throw new Error('enumeration failed: ' + enumeration.error);
    const verdicts = Object.fromEntries(
      enumeration.worktrees.map((w) => [path.basename(w.path), reaper.evaluate(w).verdict]),
    );
    expect(verdicts.merged).toBe('reap-eligible');
    expect(verdicts.dirty).not.toBe('reap-eligible');
    expect(verdicts.unmerged).not.toBe('reap-eligible');
  });
});

describe('makeAgentWorktreeReaperDeps.isClean — residue-aware + FAIL-CLOSED (worktree-reaper-untracked-blindspot)', () => {
  // A fake readGit that returns a fixed porcelain for the `status --porcelain` call.
  const withStatus = (porcelain: string): ReadGit => (args) => {
    if (args.includes('status')) return porcelain;
    return '';
  };
  const mk = (readGit: ReadGit) =>
    makeAgentWorktreeReaperDeps({ instarRepo: '/repo', worktreesDir: '/repo/.worktrees', readGit }).isClean('/repo/.worktrees/a');

  it('DIRTY (KEEP) even when the only entry has the Spotlight marker name', () => {
    expect(mk(withStatus('?? .metadata_never_index\n'))).toBe(false);
  });
  it('DIRTY (KEEP) when generated-output directories contain untracked files', () => {
    expect(mk(withStatus('?? dist/\n?? node_modules/\n'))).toBe(false);
  });
  it('DIRTY (KEEP) on a hand-authored trace under the audit directory', () => {
    expect(mk(withStatus('?? .instar/instar-dev-traces/run.json\n'))).toBe(false);
  });
  it('DIRTY (KEEP) on a tracked modification', () => {
    expect(mk(withStatus(' M src/core/x.ts\n'))).toBe(false);
  });
  it('DIRTY (KEEP) on a hand-authored untracked source file (possibly-precious)', () => {
    expect(mk(withStatus('?? src/newThing.ts\n'))).toBe(false);
  });
  it('DIRTY (KEEP) on broad entries the reaper denylist DELIBERATELY excludes (build/, *.log)', () => {
    // These match DEFAULT_RESIDUE_DENYLIST but NOT REAPER_RESIDUE_DENYLIST — a
    // user-authored build/deploy.md or analysis.log must never be silently reaped.
    expect(mk(withStatus('?? build/deploy.md\n'))).toBe(false);
    expect(mk(withStatus('?? analysis.log\n'))).toBe(false);
    expect(mk(withStatus('?? out/report.txt\n'))).toBe(false);
    expect(mk(withStatus('?? coverage/index.html\n'))).toBe(false);
  });
  it('FAIL-CLOSED: a git error → DIRTY (KEEP), never "looks clean → reapable" (the convergence BLOCKER)', () => {
    const throwing: ReadGit = () => { throw new Error('git status failed (lock contention)'); };
    expect(mk(throwing)).toBe(false);
  });
  it('CLEAN when the only entries are records the commit gate named itself', () => {
    expect(mk(withStatus('?? .instar/instar-dev-decisions/2026-10-23T19-33-42-871Z-x.json\n?? .instar/instar-dev-traces/2026-10-26T07-42-44-062Z-x-6648946c.json\n'))).toBe(true);
  });
  it('DIRTY (KEEP) on a nested or differently named file in the record folders', () => {
    expect(mk(withStatus('?? .instar/instar-dev-decisions/notes.json\n'))).toBe(false);
    expect(mk(withStatus('?? .instar/instar-dev-decisions/sub/2026-10-23T19-33-42-871Z-x.json\n'))).toBe(false);
    expect(mk(withStatus('?? .instar/instar-dev-decisions/\n'))).toBe(false);
  });
  it('DIRTY (KEEP) on a staged record or a locally edited tracked record', () => {
    expect(mk(withStatus('A  .instar/instar-dev-decisions/2026-10-23T19-33-42-871Z-x.json\n'))).toBe(false);
    expect(mk(withStatus(' M .instar/instar-dev-traces/2026-10-26T07-42-44-062Z-x-6648946c.json\n'))).toBe(false);
  });
  it('CLEAN on a truly empty worktree (no changes at all)', () => {
    expect(mk(withStatus(''))).toBe(true);
  });
  it('REAPER_RESIDUE_DENYLIST exempts no user-authorable entries', () => {
    expect(REAPER_RESIDUE_DENYLIST).not.toContain('.metadata_never_index');
    expect(REAPER_RESIDUE_DENYLIST).not.toContain('out/');
    expect(REAPER_RESIDUE_DENYLIST).not.toContain('build/');
    expect(REAPER_RESIDUE_DENYLIST).not.toContain('*.log');
    expect(REAPER_RESIDUE_DENYLIST).not.toContain('dist/');
    expect(REAPER_RESIDUE_DENYLIST).not.toContain('node_modules/');
    expect(REAPER_RESIDUE_DENYLIST).not.toContain('.instar/instar-dev-traces/');
  });
});

describe('AgentWorktreeReaper.start — one-time initial pass (reaper-never-fires fix)', () => {
  // Root cause under test: start() used to schedule ONLY the 24h interval, and
  // real servers restart more often than daily — so the interval reset forever
  // and an enabled+armed reaper never ran a single pass (2026-07-02 incident:
  // 86 worktrees / 25GB accumulated with the feature ON). The initial pass makes
  // "enabled" mean "actually runs" on realistic server lifetimes.
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const DELAY = 15 * 60 * 1000;

  it('fires ONE initial pass after initialPassDelayMs, before the 24h interval', async () => {
    const r = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: true, initialPassDelayMs: DELAY });
    const passes: unknown[] = [];
    r.on('pass', (p) => passes.push(p));
    r.start();
    await vi.advanceTimersByTimeAsync(DELAY - 1);
    expect(passes).toHaveLength(0); // not before the delay
    await vi.advanceTimersByTimeAsync(1);
    expect(passes).toHaveLength(1); // exactly one initial pass
    r.stop();
  });

  it('initial pass respects dry-run (classifies, never deletes)', async () => {
    const removeWorktree = vi.fn();
    const r = new AgentWorktreeReaper(deps({ removeWorktree }), { enabled: true, dryRun: true, initialPassDelayMs: DELAY });
    r.start();
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(removeWorktree).not.toHaveBeenCalled();
    r.stop();
  });

  it('no timers at all when the reaper is disabled', async () => {
    const r = new AgentWorktreeReaper(deps(), { enabled: false, initialPassDelayMs: DELAY });
    const passes: unknown[] = [];
    r.on('pass', (p) => passes.push(p));
    r.start();
    await vi.advanceTimersByTimeAsync(25 * 3600 * 1000);
    expect(passes).toHaveLength(0);
  });

  it('initialPassDelayMs <= 0 disables the initial pass (interval-only rollback lever)', async () => {
    const r = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: true, reapIntervalMs: 1000, initialPassDelayMs: 0 });
    const passes: unknown[] = [];
    r.on('pass', (p) => passes.push(p));
    r.start();
    await vi.advanceTimersByTimeAsync(999);
    expect(passes).toHaveLength(0); // nothing before the interval
    await vi.advanceTimersByTimeAsync(1);
    expect(passes).toHaveLength(1); // interval behavior unchanged
    r.stop();
  });

  it('stop() cancels the pending initial pass', async () => {
    const r = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: true, initialPassDelayMs: DELAY });
    const passes: unknown[] = [];
    r.on('pass', (p) => passes.push(p));
    r.start();
    r.stop();
    await vi.advanceTimersByTimeAsync(DELAY * 2);
    expect(passes).toHaveLength(0);
  });

  it('the 24h interval cadence is unchanged and keeps firing after the initial pass', async () => {
    const r = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: true, reapIntervalMs: 24 * 3600 * 1000, initialPassDelayMs: DELAY });
    const passes: unknown[] = [];
    r.on('pass', (p) => passes.push(p));
    r.start();
    await vi.advanceTimersByTimeAsync(DELAY);            // initial pass
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000); // first interval pass
    await vi.advanceTimersByTimeAsync(24 * 3600 * 1000); // second interval pass
    expect(passes).toHaveLength(3);
    r.stop();
  });

  it('snapshot reports initialPassPending honestly (pending → fired/stopped)', async () => {
    const r = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: true, initialPassDelayMs: DELAY });
    expect(r.snapshot().initialPassPending).toBe(false); // not started yet
    r.start();
    expect(r.snapshot().initialPassPending).toBe(true);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect(r.snapshot().initialPassPending).toBe(false); // fired
    r.stop();
  });
});

describe('AgentWorktreeReaper — per-path reclaim-failure breaker (No Unbounded Loops)', () => {
  it('stops attempting a path after the failure cap, surfaces keep(reclaim-failed), emits breaker once', async () => {
    const removeWorktree = vi.fn(() => { throw new Error('cannot remove (permission)'); });
    const r = new AgentWorktreeReaper(
      deps({ removeWorktree }),
      { enabled: true, dryRun: false, maxReclaimFailuresPerPath: 2 },
    );
    const trips: Array<{ path: string; failures: number }> = [];
    r.on('reclaim-breaker', (e) => trips.push(e));
    r.on('error', () => { /* swallow expected removal errors */ });

    const p1 = await r.reap(); // fail #1 (count 1)
    const p2 = await r.reap(); // fail #2 (count 2 == cap → trip)
    const p3 = await r.reap(); // breaker open → not attempted

    expect(removeWorktree).toHaveBeenCalledTimes(2);              // attempts stopped at the cap
    expect(p1.evaluations[0].verdict).toBe('reap-eligible');
    expect(p3.evaluations[0].reason).toBe('reclaim-failed');      // honest observability
    expect(p3.evaluations[0].verdict).toBe('keep');
    expect(trips).toHaveLength(1);                                // emitted exactly once
    expect(trips[0].path).toBe('/wt/a');
  });

  it('a successful removal clears the breaker count (no false trip from transient failures)', async () => {
    let calls = 0;
    const removeWorktree = vi.fn(() => { calls++; if (calls === 1) throw new Error('transient'); });
    const r = new AgentWorktreeReaper(
      deps({ removeWorktree }),
      { enabled: true, dryRun: false, maxReclaimFailuresPerPath: 2 },
    );
    r.on('error', () => {});
    await r.reap();                 // fail #1 (count 1)
    const ok = await r.reap();      // succeeds → count cleared
    expect(ok.reaped).toEqual(['/wt/a']);
    expect(removeWorktree).toHaveBeenCalledTimes(2);
  });
});

/**
 * Enumeration failure must NEVER read as a clean bill of health.
 *
 * This defect class has now occurred TWICE in production with different causes:
 *   1. SourceTreeGuard blocked every reaper git call → reported 0 reclaimable
 *      (guarded by the real-git describe block above).
 *   2. 2026-07-29: `config.projectDir` named a user directory that does not
 *      exist, so `git -C <repo> worktree list` failed outright → reported
 *      `reclaimable: 0` against 73 real worktrees, for an unknown duration.
 *
 * The first fix addressed the CAUSE (permit the reads). The swallow that turns
 * ANY enumeration failure into an empty list survived, so the class recurred.
 * These tests pin the PROPERTY instead: a guard whose input is a path must be
 * able to say "I could not look", distinctly from "I looked and found nothing".
 */
describe('AgentWorktreeReaper — enumeration failure is visible, not a clean zero', () => {
  it('snapshot reports reclaimable:null and enumerationOk:false on a failed enumeration', () => {
    const failed = () => ({ ok: false as const, error: "fatal: cannot change to '/nope'" });
    const snap = new AgentWorktreeReaper(deps({ listWorktrees: failed }), { enabled: true, dryRun: true }).snapshot();

    // The load-bearing assertion: NOT zero. Zero is a measurement; this is an absence.
    expect(snap.reclaimable).toBeNull();
    expect(snap.enumerationOk).toBe(false);
    expect(snap.enumerationError).toContain('cannot change to');
    expect(snap.worktrees).toEqual([]);
  });

  it('a healthy enumeration still reports a real number and enumerationOk:true', () => {
    // The discriminating control: without this, an implementation that always
    // returned null would pass the test above while reporting nothing useful.
    const snap = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: true }).snapshot();
    expect(snap.enumerationOk).toBe(true);
    expect(snap.enumerationError).toBeNull();
    expect(snap.reclaimable).toBe(1);
  });

  it('makeAgentWorktreeReaperDeps.listWorktrees returns {ok:false} on git failure, never an empty list', () => {
    // The root cause: the deps layer collapsed failure into []. The three-state
    // result makes the failure branch unskippable at the type level.
    const readGit: ReadGit = () => { throw new Error('fatal: not a git repository'); };
    const d = makeAgentWorktreeReaperDeps({ instarRepo: '/nope', worktreesDir: '/nope/.worktrees', readGit });
    const r = d.listWorktrees();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/worktree enumeration failed/);
  });

  it('a dep that THROWS in violation of its contract still does not produce a clean zero', () => {
    // Defensive backstop: the type stops honest callers, this stops a broken one.
    const boom = () => { throw new Error('unexpected'); };
    const snap = new AgentWorktreeReaper(deps({ listWorktrees: boom as never }), { enabled: true, dryRun: true }).snapshot();
    expect(snap.reclaimable).toBeNull();
    expect(snap.enumerationOk).toBe(false);
  });
});

/**
 * Regression guard for a hazard this change itself created.
 *
 * Making `listWorktrees` report failure turned a previously-DEAD `emit('error')`
 * into a reachable one. Node's EventEmitter special-cases `'error'`: emitting it
 * with no listener THROWS. Nothing subscribes to these components in production,
 * and `reap()`/`scan()` have only a `finally` — so the throw would have escaped as
 * an unhandled rejection from the interval callback, in exactly the enumeration-
 * failure case this change exists to handle.
 *
 * The fix is a named, non-special event. These tests pin the property that matters
 * to an operator: a broken enumeration must be quiet-and-visible, never fatal.
 */
describe('AgentWorktreeReaper — a failed enumeration never crashes an unlistening caller', () => {
  it('reap() resolves normally with NO listeners attached', async () => {
    const r = new AgentWorktreeReaper(
      deps({ listWorktrees: () => ({ ok: false as const, error: 'fatal: cannot change to /nope' }) }),
      { enabled: true, dryRun: true },
    );
    expect(r.listenerCount('error')).toBe(0); // the condition that makes 'error' fatal
    const res = await r.reap();               // must not throw
    expect(res.reaped).toEqual([]);
    expect(res.evaluations).toEqual([]);
  });

  it('emits a named enumeration-failed event carrying the reason', async () => {
    const r = new AgentWorktreeReaper(
      deps({ listWorktrees: () => ({ ok: false as const, error: 'fatal: cannot change to /nope' }) }),
      { enabled: true, dryRun: true },
    );
    const seen: Array<{ error: string }> = [];
    r.on('enumeration-failed', (e: { error: string }) => seen.push(e));
    await r.reap();
    expect(seen).toHaveLength(1);
    expect(seen[0].error).toMatch(/cannot change to/);
  });
});

describe('AgentWorktreeReaper — a failed enumeration leaves a passive trace', () => {
  it('warns (server log) when enumeration fails, naming UNKNOWN rather than zero', async () => {
    // Close the Loop: an event nobody subscribes to can rot. The warn default is
    // console.warn, which lands in the server log — so a blind guard leaves a
    // trace even when no one is asking it questions (subject to log retention).
    const lines: string[] = [];
    const r = new AgentWorktreeReaper(
      deps({
        listWorktrees: () => ({ ok: false as const, error: 'fatal: cannot change to /nope' }),
        warn: (l: string) => lines.push(l),
      }),
      { enabled: true, dryRun: true },
    );
    await r.reap();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/enumeration FAILED/);
    expect(lines[0]).toMatch(/UNKNOWN, not zero/);
  });

  it('does NOT warn on a healthy pass', async () => {
    const lines: string[] = [];
    const r = new AgentWorktreeReaper(deps({ warn: (l: string) => lines.push(l) }), { enabled: true, dryRun: true });
    await r.reap();
    expect(lines).toEqual([]); // control: the log fires on failure only
  });
});

describe('AgentWorktreeReaper — enumeration-failure metric', () => {
  const failing = () => deps({
    listWorktrees: () => ({ ok: false as const, error: 'fatal: cannot change to /nope' }),
    warn: () => {},
  });

  it('counts failed reap passes and records when the last one was', async () => {
    const r = new AgentWorktreeReaper(failing(), { enabled: true, dryRun: true });
    expect(r.snapshot().enumerationFailures).toBe(0);
    await r.reap();
    await r.reap();
    const snap = r.snapshot();
    expect(snap.enumerationFailures).toBe(2);
    expect(snap.lastEnumerationFailureAt).toBe(NOW);
  });

  it('does NOT count snapshot() calls — the metric measures passes, not polling', () => {
    const r = new AgentWorktreeReaper(failing(), { enabled: true, dryRun: true });
    r.snapshot(); r.snapshot(); r.snapshot();
    const snap = r.snapshot();
    expect(snap.enumerationFailures).toBe(0);  // four reads, zero passes
    expect(snap.enumerationOk).toBe(false);    // ...but the CURRENT state is still honest
  });

  it('stays at zero on healthy passes', async () => {
    const r = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: true });
    await r.reap();
    expect(r.snapshot().enumerationFailures).toBe(0);
  });

  it('publishes a live unknown verdict after a failed pass, advances the tick, and clears on recovery', async () => {
    let fail = true;
    let now = NOW;
    const r = new AgentWorktreeReaper(deps({
      listWorktrees: () => fail
        ? { ok: false as const, error: 'fatal: cannot enumerate' }
        : { ok: true as const, worktrees: [] },
      now: () => now,
      warn: () => {},
    }), { enabled: true, dryRun: false });

    expect(r.guardStatus()).toEqual({ enabled: true, dryRun: false, lastTickAt: 0 });
    await r.reap();
    expect(r.guardStatus()).toMatchObject({
      lastTickAt: NOW,
      verdictUnknown: true,
      verdictUnknownReason: 'fatal: cannot enumerate',
    });

    fail = false;
    now++;
    await r.reap();
    expect(r.guardStatus()).toEqual({ enabled: true, dryRun: false, lastTickAt: NOW + 1 });
    expect(r.snapshot().enumerationFailures).toBe(1);
  });

  it('reloads historical failure count/time without restoring a stale live blind verdict', () => {
    const history = { enumerationFailures: 7, lastEnumerationFailureAt: NOW - 5 };
    const r = new AgentWorktreeReaper(deps({ failureHistory: {
      load: () => history,
      recordFailure: () => history,
    } }), { enabled: true, dryRun: false });

    expect(r.snapshot()).toMatchObject(history);
    expect(r.guardStatus()).toEqual({ enabled: true, dryRun: false, lastTickAt: 0 });
  });
});

describe('summarizeEnumerationError — bounded, single-line, control-char-free', () => {
  const ESC = '\u001B';

  it('strips control characters, not just whitespace', () => {
    // git/path output can carry ANSI escapes; a `\s+` collapse leaves ESC intact,
    // and the result lands in a server log that a terminal may render.
    const out = summarizeEnumerationError(new Error(`fatal: bad ${ESC}[31mred${ESC}[0m path`));
    expect(out).not.toContain(ESC);
    expect(out).toContain('fatal: bad');
  });

  it('collapses newlines to a single line', () => {
    expect(summarizeEnumerationError(new Error('line one\nline two'))).toBe('line one line two');
  });

  it('clamps to the max length with an ellipsis', () => {
    const out = summarizeEnumerationError(new Error('x'.repeat(1000)));
    expect(out.length).toBe(MAX_ENUMERATION_ERROR_CHARS);
    expect(out.endsWith('\u2026')).toBe(true);
  });

  it('handles a non-Error throw', () => {
    expect(summarizeEnumerationError('plain string')).toBe('plain string');
  });
});
