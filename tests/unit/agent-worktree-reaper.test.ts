/**
 * AgentWorktreeReaper — the safety-critical classifier for reclaiming stale CLI
 * worktrees. THE hard requirement under test: NEVER delete unmerged or dirty
 * work. A worktree is reap-eligible ONLY when not-active AND clean AND merged AND
 * stale; any single failing gate ⇒ KEEP. Also covers dry-run (classify, never
 * delete), the blast-radius cap, and the merged-detection (git cherry) helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import {
  AgentWorktreeReaper,
  type AgentWorktreeReaperDeps,
  type WorktreeInfo,
} from '../../src/monitoring/AgentWorktreeReaper.js';
import { isBranchMerged, resolveBaseRef, makeAgentWorktreeReaperDeps, fetchMergedPrHeadOids, REAPER_RESIDUE_DENYLIST, type ReadGit, type RunGh } from '../../src/monitoring/agentWorktreeGit.js';
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
  // evaluate() is async since the event-loop fix — await at every call site.

  it('reap-eligible only when not-in-use AND clean AND merged', async () => {
    expect((await reap({})).verdict).toBe('reap-eligible');
    expect((await reap({})).reason).toBe('merged-clean-idle');
  });

  it('KEEPs an in-use worktree (lock or live process cwd)', async () => {
    const e = await reap({ isInUse: () => true });
    expect(e.verdict).toBe('keep'); expect(e.reason).toBe('in-use');
  });

  it('KEEPs a dirty worktree (uncommitted changes)', async () => {
    const e = await reap({ isClean: () => false });
    expect(e.verdict).toBe('keep'); expect(e.reason).toBe('uncommitted-changes');
  });

  it('KEEPs an unmerged worktree', async () => {
    const e = await reap({ isMerged: () => false });
    expect(e.verdict).toBe('keep'); expect(e.reason).toBe('unmerged');
  });

  it('KEEPs a detached/unknown-branch worktree', async () => {
    const e = await new AgentWorktreeReaper(deps(), { enabled: true }).evaluate(wt({ branch: null }));
    expect(e.verdict).toBe('keep'); expect(e.reason).toBe('detached-or-unknown-branch');
  });

  it('does NOT call isMerged (a git op) for a dirty or in-use worktree (cheap gates first)', async () => {
    const isMerged = vi.fn(() => true);
    await new AgentWorktreeReaper(deps({ isClean: () => false, isMerged }), { enabled: true }).evaluate(wt());
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

  it('snapshot reports the reclaimable count without side effects', async () => {
    const removeWorktree = vi.fn();
    const snap = await new AgentWorktreeReaper(deps({ removeWorktree }), { enabled: true, dryRun: true }).snapshot();
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

  it('parses gh merged-PR JSON into a headRefName→headRefOid map', async () => {
    const m = await fetchMergedPrHeadOids('/repo', { runGh: ghOut([
      { headRefName: 'echo/feat-a', headRefOid: 'oidA' },
      { headRefName: 'echo/feat-b', headRefOid: 'oidB' },
    ]) });
    expect(m.get('echo/feat-a')).toBe('oidA');
    expect(m.get('echo/feat-b')).toBe('oidB');
    expect(m.size).toBe(2);
  });

  it('keeps the FIRST (newest) entry when a branch name is reused', async () => {
    const m = await fetchMergedPrHeadOids('/repo', { runGh: ghOut([
      { headRefName: 'echo/reused', headRefOid: 'newest' },
      { headRefName: 'echo/reused', headRefOid: 'older' },
    ]) });
    expect(m.get('echo/reused')).toBe('newest');
  });

  it('fail-safe to EMPTY map when gh is unavailable (null) — conservative KEEP', async () => {
    const m = await fetchMergedPrHeadOids('/repo', { runGh: () => null });
    expect(m.size).toBe(0);
  });

  it('fail-safe to EMPTY map on malformed JSON', async () => {
    const m = await fetchMergedPrHeadOids('/repo', { runGh: () => 'not json' });
    expect(m.size).toBe(0);
  });

  it('ignores rows missing name or oid', async () => {
    const m = await fetchMergedPrHeadOids('/repo', { runGh: () => JSON.stringify([
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

  it('MERGED when cherry says unmerged but a merged PR head-OID matches exactly', async () => {
    const deps = makeAgentWorktreeReaperDeps({
      instarRepo: '/repo', worktreesDir: '/repo/.worktrees', readGit: cherryUnmergedGit,
      githubMergeCheck: true,
      mergedPrMap: () => new Map([['echo/feat', 'SQUASHED_OID']]),
    });
    expect(await deps.isMerged(wt('echo/feat', 'SQUASHED_OID'))).toBe(true);
  });

  it('KEEP when the branch advanced past the merged PR (head-OID mismatch = unmerged work)', async () => {
    const deps = makeAgentWorktreeReaperDeps({
      instarRepo: '/repo', worktreesDir: '/repo/.worktrees', readGit: cherryUnmergedGit,
      githubMergeCheck: true,
      mergedPrMap: () => new Map([['echo/feat', 'MERGED_OID']]),
    });
    // worktree HEAD is a NEW commit added after the merge → must be KEPT
    expect(await deps.isMerged(wt('echo/feat', 'NEWER_OID_WITH_UNMERGED_WORK'))).toBe(false);
  });

  it('KEEP when no merged PR exists for the branch', async () => {
    const deps = makeAgentWorktreeReaperDeps({
      instarRepo: '/repo', worktreesDir: '/repo/.worktrees', readGit: cherryUnmergedGit,
      githubMergeCheck: true,
      mergedPrMap: () => new Map(),
    });
    expect(await deps.isMerged(wt('echo/feat', 'anySha'))).toBe(false);
  });

  it('KEEP (legacy cherry-only) when githubMergeCheck is disabled — never calls the PR map', async () => {
    const prMap = vi.fn(() => new Map([['echo/feat', 'SQUASHED_OID']]));
    const deps = makeAgentWorktreeReaperDeps({
      instarRepo: '/repo', worktreesDir: '/repo/.worktrees', readGit: cherryUnmergedGit,
      githubMergeCheck: false,
      mergedPrMap: prMap,
    });
    expect(await deps.isMerged(wt('echo/feat', 'SQUASHED_OID'))).toBe(false);
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
  const mkDeps = (worktreesDir: string, cwdRoots: () => Set<string>) =>
    makeAgentWorktreeReaperDeps({ instarRepo: tmp, worktreesDir, readGit: () => '', cwdRoots });

  it('in-use when a live process cwd is inside the worktree', async () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = mkDeps(worktreesDir, () => new Set([fs.realpathSync(wtA)]));
    expect(await deps.isInUse(wtA)).toBe(true);
  });

  it('NOT in-use when no lock and no process cwd inside', async () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = mkDeps(worktreesDir, () => new Set<string>());
    expect(await deps.isInUse(wtA)).toBe(false);
  });

  it('in-use when a .session.lock is present (even with empty cwd set)', async () => {
    const { worktreesDir, wtA } = mkWorktree();
    const deps = mkDeps(worktreesDir, () => new Set<string>());
    fs.writeFileSync(path.join(wtA, '.session.lock'), '');
    expect(await deps.isInUse(wtA)).toBe(true);
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

  it('listWorktrees + isClean + isMerged all work against the source tree (no guard error)', async () => {
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
    const list = await deps.listWorktrees();
    // main checkout excluded by `within`; only the three under .worktrees/
    const byName = Object.fromEntries(list.map((w) => [path.basename(w.path), w]));
    expect(Object.keys(byName).sort()).toEqual(['dirty', 'merged', 'unmerged']);

    expect(await deps.isClean(byName.merged.path)).toBe(true);
    expect(await deps.isClean(byName.dirty.path)).toBe(false);

    expect(await deps.isMerged(byName.merged)).toBe(true);
    expect(await deps.isMerged(byName.unmerged)).toBe(false);
  });

  it('removeWorktree actually reclaims a merged+clean worktree through the guard', () => {
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
    const mergedPath = path.join(worktreesDir, 'merged');
    expect(fs.existsSync(mergedPath)).toBe(true);
    expect(() => deps.removeWorktree(mergedPath)).not.toThrow();
    expect(fs.existsSync(mergedPath)).toBe(false);
  });

  it('AgentWorktreeReaper end-to-end with real deps: reaps merged+clean, keeps dirty + unmerged', async () => {
    const deps = makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir });
    const reaper = new AgentWorktreeReaper(deps, { enabled: true, dryRun: true });
    const verdicts = Object.fromEntries(
      await Promise.all((await deps.listWorktrees()).map(async (w) => [path.basename(w.path), (await reaper.evaluate(w)).verdict])),
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
  // isClean() is async since the event-loop fix; the injected sync `readGit` still
  // drives it (the deps factory derives the async reader from it).
  const mk = (readGit: ReadGit) =>
    makeAgentWorktreeReaperDeps({ instarRepo: '/repo', worktreesDir: '/repo/.worktrees', readGit }).isClean('/repo/.worktrees/a');

  it('CLEAN when the only entry is the instar Spotlight marker (the dominant blocker)', async () => {
    expect(await mk(withStatus('?? .metadata_never_index\n'))).toBe(true);
  });
  it('CLEAN when entries are only narrow residue (dist/, node_modules/, trace dir)', async () => {
    expect(await mk(withStatus('?? dist/\n?? node_modules/\n?? .instar/instar-dev-traces/run.json\n'))).toBe(true);
  });
  it('DIRTY (KEEP) on a tracked modification', async () => {
    expect(await mk(withStatus(' M src/core/x.ts\n'))).toBe(false);
  });
  it('DIRTY (KEEP) on a hand-authored untracked source file (possibly-precious)', async () => {
    expect(await mk(withStatus('?? src/newThing.ts\n'))).toBe(false);
  });
  it('DIRTY (KEEP) on broad entries the reaper denylist DELIBERATELY excludes (build/, *.log)', async () => {
    // These match DEFAULT_RESIDUE_DENYLIST but NOT REAPER_RESIDUE_DENYLIST — a
    // user-authored build/deploy.md or analysis.log must never be silently reaped.
    expect(await mk(withStatus('?? build/deploy.md\n'))).toBe(false);
    expect(await mk(withStatus('?? analysis.log\n'))).toBe(false);
    expect(await mk(withStatus('?? out/report.txt\n'))).toBe(false);
    expect(await mk(withStatus('?? coverage/index.html\n'))).toBe(false);
  });
  it('FAIL-CLOSED: a git error → DIRTY (KEEP), never "looks clean → reapable" (the convergence BLOCKER)', async () => {
    const throwing: ReadGit = () => { throw new Error('git status failed (lock contention)'); };
    expect(await mk(throwing)).toBe(false);
  });
  it('CLEAN on a truly empty worktree (no changes at all)', async () => {
    expect(await mk(withStatus(''))).toBe(true);
  });
  it('REAPER_RESIDUE_DENYLIST is narrow — excludes the broad user-authorable entries', () => {
    expect(REAPER_RESIDUE_DENYLIST).toContain('.metadata_never_index');
    expect(REAPER_RESIDUE_DENYLIST).not.toContain('out/');
    expect(REAPER_RESIDUE_DENYLIST).not.toContain('build/');
    expect(REAPER_RESIDUE_DENYLIST).not.toContain('*.log');
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
    expect((await r.snapshot()).initialPassPending).toBe(false); // not started yet
    r.start();
    expect((await r.snapshot()).initialPassPending).toBe(true);
    await vi.advanceTimersByTimeAsync(DELAY);
    expect((await r.snapshot()).initialPassPending).toBe(false); // fired
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
 * The fail-CLOSED direction of `isInUse` — the one signal whose failure CLEARS a delete
 * gate. Added after a round-2 adversarial reviewer reverted the fix and watched all 86
 * tests stay green: the delete-authorising direction was pinned by nothing.
 *
 * Pre-fix, a failed process scan returned an EMPTY set, which reads as "no process is
 * using this worktree" — indistinguishable from a genuine idle, and it clears a gate on
 * the path to an irreversible `git worktree remove`. The scan now reports 'unknown' and
 * `isInUse` answers KEEP.
 */
describe('isInUse — fail-CLOSED on an undeterminable process scan', () => {
  // A REAL directory: `isInUse` realpaths the worktree, and an unresolvable path is
  // itself fail-closed (KEEP). Using a fake path would make every case below pass for
  // the wrong reason — which the CONTROL case caught when this suite was first written.
  let realWt: string;
  let realWtRoot: string;
  beforeAll(() => {
    realWtRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'inuse-'));
    realWt = path.join(realWtRoot, '.worktrees', 'a');
    fs.mkdirSync(realWt, { recursive: true });
  });
  afterAll(() => {
    try {
      SafeFsExecutor.safeRmSync(realWtRoot, {
        recursive: true, force: true,
        operation: 'tests/unit/agent-worktree-reaper.test.ts:isInUse-failclosed',
      });
    } catch { /* best effort */ }
  });

  const mkDeps = (cwdRoots: () => Set<string> | 'unknown' | Promise<Set<string> | 'unknown'>) =>
    makeAgentWorktreeReaperDeps({
      instarRepo: realWtRoot,
      worktreesDir: path.join(realWtRoot, '.worktrees'),
      readGit: () => '',
      githubMergeCheck: false,
      cwdRoots,
    });

  it("an 'unknown' scan yields IN-USE (KEEP), never 'idle'", async () => {
    // Revert the fix (return an empty Set here) and this test fails. That is the point.
    expect(await mkDeps(() => 'unknown').isInUse(realWt)).toBe(true);
  });

  it('a THROWING scan yields IN-USE (KEEP)', async () => {
    expect(await mkDeps(() => { throw new Error('lsof exploded'); }).isInUse(realWt)).toBe(true);
  });

  it('a REJECTING scan yields IN-USE (KEEP)', async () => {
    expect(await mkDeps(() => Promise.reject(new Error('lsof timed out'))).isInUse(realWt)).toBe(true);
  });

  it('CONTROL: a real empty scan result still yields NOT-in-use', async () => {
    // Passes before and after the fix — it pins that the fix did not simply make
    // everything in-use, which would disable the reaper rather than protect it.
    expect(await mkDeps(() => new Set<string>()).isInUse(realWt)).toBe(false);
  });
});

/**
 * Tier 1 — WALL-CLOCK BOUNDS: a signal that never settles must not wedge the guard.
 *
 * WHY THESE EXIST, AND WHY THEY LIVE HERE. Round-two review found that the pass
 * marker (`running`) and the single-flight markers are all cleared in `finally`
 * blocks — and a `finally` NEVER RUNS on a promise that never settles. The
 * consequence is not a slow read: one non-settling signal leaves `running` true
 * for the life of the process, so the background reaper silently stops running
 * passes. That is a healthy-looking guard that never finds anything, which is the
 * exact failure shape the reaper exists to prevent.
 *
 * These are the DISCRIMINATING tests for that fix: remove the deadline and each
 * one hangs until the vitest timeout instead of passing. They are deliberately
 * driven by INJECTED never-settling signals rather than a real subprocess —
 * every `deps.*` signal is injectable, so the bounds inside the read primitives
 * do not cover a wiring that supplies its own, and that gap is what the ceiling
 * at this layer is for. (An earlier attempt tested this at the subprocess layer with
 * a fake git whose grandchild holds stdout open, and this comment used to claim it
 * could not reproduce under the test runner. That was WRONG — round four rebuilt it
 * and it settles exactly at the deadline, proving `close` never fires. The real
 * defect was its own loose assertion, which accepted either outcome. That test is
 * RESTORED with a tight assertion in tests/unit/SafeGitExecutor.test.ts. The wrong
 * version is corrected rather than deleted because it told a future author that
 * demonstrably-writable coverage could not be written.)
 */
describe('AgentWorktreeReaper — a non-settling signal cannot wedge the pass marker', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const neverSettles = <T>(): Promise<T> => new Promise<T>(() => { /* deliberately never */ });

  it('reap() SETTLES when listWorktrees never settles, and HOLDS `running` until the work does', async () => {
    const d = deps({ listWorktrees: () => neverSettles<WorktreeInfo[]>() });
    const reaper = new AgentWorktreeReaper(d, { enabled: true, dryRun: true });
    reaper.on('error', () => { /* the deadline surfaces as an error event; assert below */ });

    const first = reaper.reap();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    const r1 = await first;
    expect(r1.reaped).toEqual([]);        // an honest empty pass, not a fabricated result
    expect(r1.evaluations).toEqual([]);

    // The load-bearing half: `running` cleared, so the NEXT pass is not locked out.
    // Without the ceiling this second call returns the "already running" short-circuit
    // forever — the silent-stop shape.
    //
    // ROUND-FIVE CORRECTION — this assertion was INVERTED by the latch fix, and the
    // inversion is the point. Round three released the latch at the CALLER ceiling,
    // so a second pass could start (and delete) while the first was still running.
    // Now the latch is bound to the WORK: while the abandoned pass is still alive, a
    // second `reap()` MUST take the already-running short-circuit and return
    // immediately, doing nothing. That is what stops two passes deleting at once.
    let secondSettled = false;
    const second = reaper.reap().then((r) => { secondSettled = true; return r; });
    await Promise.resolve();
    await Promise.resolve();
    expect(secondSettled).toBe(true);          // short-circuited: no overlapping pass
    expect((await second).reaped).toEqual([]);
  }, 20_000);

  it('reap() emits an error rather than failing silently when the pass is abandoned', async () => {
    const errors: unknown[] = [];
    const d = deps({ listWorktrees: () => neverSettles<WorktreeInfo[]>() });
    const reaper = new AgentWorktreeReaper(d, { enabled: true, dryRun: true });
    reaper.on('error', (e) => errors.push(e));
    const p = reaper.reap();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    await p;
    expect(errors.length).toBe(1);
    expect(String((errors[0] as Error).message)).toMatch(/wall-clock bound/);
  }, 20_000);

  it('snapshot() SETTLES when a signal never settles, and clears the in-flight marker', async () => {
    const d = deps({ isInUse: () => neverSettles<boolean>() });
    const reaper = new AgentWorktreeReaper(d, { enabled: false, dryRun: true });

    // NOTE the assertion is attached BEFORE the clock is advanced. Attaching it
    // after leaves the promise momentarily unhandled, and node flags an unhandled
    // rejection that shows up as a suite-level error — noise that would mask a real one.
    const first = reaper.snapshot();
    const firstRejects = expect(first).rejects.toThrow(/wall-clock bound/);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    await firstRejects;

    // Marker cleared: a later caller starts a FRESH pass instead of joining the
    // abandoned one. Without the ceiling, `pendingSnapshot` is pinned and every
    // subsequent request to the read route joins a promise that never resolves.
    //
    // snapshot() REJECTS where reap() returns an empty result — deliberate: an
    // empty snapshot would assert "nothing reclaimable" on the surface that
    // reports what the deleter sees. The route renders this as a 500.
    const second = reaper.snapshot();
    const secondRejects = expect(second).rejects.toThrow(/wall-clock bound/);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
    await secondRejects;
    expect(first).not.toBe(second);
  }, 20_000);

  it('CONTROL: a normally-settling pass is untouched by the ceiling', async () => {
    // Pins that the ceiling did not simply break the happy path — the failure mode
    // of a badly-sized bound is a guard that abandons real work.
    const reaper = new AgentWorktreeReaper(deps(), { enabled: true, dryRun: true });
    const r = await reaper.reap();
    expect(r.evaluations.length).toBe(1);
    expect(r.evaluations[0]!.verdict).toBe('reap-eligible');
  });
});

/**
 * Tier 1 — the lock/marker gates must FAIL CLOSED on an unreadable file.
 *
 * WHY THIS EXISTS. Round-two review found that these gates wrapped
 * `fs.existsSync` in a `try/catch` whose catch is UNREACHABLE: `existsSync`
 * swallows every error internally and returns `false`. So a lock file that EXISTS
 * but cannot be read (EACCES, IO error) was reported as ABSENT — "no in-flight
 * work here" — which CLEARS a delete gate. The fail-closed comment sitting above
 * those catches described a branch that could never run, which is the same defect
 * class as the false exemption comment that started this whole change: a safety
 * claim in prose that the code did not implement.
 *
 * DISCRIMINATING: revert to `fs.existsSync` and the first test fails (the gate
 * reports idle for a worktree whose lock it cannot read).
 */
describe('makeAgentWorktreeReaperDeps — lock gates fail CLOSED on an unreadable lock', () => {
  let root: string;
  let wt: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awg-perm-')));
    fs.mkdirSync(path.join(root, '.worktrees'), { recursive: true });
    wt = path.join(root, '.worktrees', 'a');
    fs.mkdirSync(wt);
  });
  afterEach(() => {
    try { fs.chmodSync(wt, 0o755); } catch { /* best effort */ }
    try {
      SafeFsExecutor.safeRmSync(root, {
        recursive: true, force: true,
        operation: 'tests/unit/agent-worktree-reaper.test.ts:perm-gates-afterEach',
      });
    } catch { /* best effort */ }
  });

  const mkDeps = () => makeAgentWorktreeReaperDeps({
    instarRepo: root,
    worktreesDir: path.join(root, '.worktrees'),
    readGit: () => '',
    githubMergeCheck: false,
    cwdRoots: () => new Set<string>(),   // no live process — isolate the lock gate
  });

  it('an UNREADABLE session lock yields IN-USE (KEEP), not idle', () => {
    fs.writeFileSync(path.join(wt, '.session.lock'), 'x');
    fs.chmodSync(wt, 0o000);
    // Guard rather than assert blindly: as root (or on a filesystem that ignores
    // mode bits) the read succeeds and this scenario does not exist. Skipping
    // loudly beats a test that is green because its premise never held.
    let unreadable = false;
    try { fs.statSync(path.join(wt, '.session.lock')); } catch { unreadable = true; }
    if (!unreadable) {
      // LOUD, as the comment above promises. The previous version returned silently,
      // so as root (or on a mode-ignoring filesystem) this went green having asserted
      // nothing — the same premise-never-held shape the comment claims to avoid.
      // eslint-disable-next-line no-console
      console.warn('[fail-closed] SKIPPED — this filesystem/uid did not make the lock unreadable; premise absent.');
      return;
    }
    expect(fs.existsSync(path.join(wt, '.session.lock'))).toBe(false); // the defect, demonstrated
    return expect(mkDeps().isInUse(wt)).resolves.toBe(true);           // the fix
  });

  it('an UNREADABLE build marker counts as PRESENT (KEEP)', () => {
    fs.writeFileSync(path.join(wt, '.instar-build-active'), 'x');
    fs.chmodSync(wt, 0o000);
    let unreadable = false;
    try { fs.statSync(path.join(wt, '.instar-build-active')); } catch { unreadable = true; }
    if (!unreadable) {
      // eslint-disable-next-line no-console
      console.warn('[fail-closed] SKIPPED — this filesystem/uid did not make the marker unreadable; premise absent.');
      return;
    }
    expect(mkDeps().hasActiveBuildMarker!(wt)).toBe(true);
  });

  it('CONTROL: a genuinely absent lock still yields NOT-in-use', async () => {
    // Pins that fail-closed did not become always-closed, which would disable the
    // reaper entirely rather than protect it — the inert-guard failure mode.
    expect(await mkDeps().isInUse(wt)).toBe(false);
  });

  it('CONTROL: a genuinely absent build marker is still absent', () => {
    expect(mkDeps().hasActiveBuildMarker!(wt)).toBe(false);
  });
});

/**
 * Tier 1 — fail-closed must not become ALWAYS-closed.
 *
 * WHY THIS EXISTS. The first version of `existsFailClosed` treated every non-ENOENT
 * stat error as "cannot tell → PRESENT". In a worktree `.git` is a FILE (a gitdir
 * pointer), not a directory, so `stat(<wt>/.git/index.lock)` fails ENOTDIR — the
 * lock cannot exist at that path. Under that version EVERY worktree read as in-use
 * and the reaper reclaimed nothing: an inert guard, which is the same failure the
 * un-awaited-promise defect produced, reached from the opposite direction. The
 * end-to-end test caught it within a minute; this pins it directly so the next
 * person sees WHY ENOTDIR is enumerated rather than deleting it as noise.
 */
describe('existsFailClosed — structural absence vs genuine ambiguity', () => {
  let root: string;
  let wt: string;
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awg-enotdir-')));
    fs.mkdirSync(path.join(root, '.worktrees'), { recursive: true });
    wt = path.join(root, '.worktrees', 'a');
    fs.mkdirSync(wt);
    // Reproduce the real worktree shape: `.git` is a FILE, not a directory.
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(root, '.git', 'worktrees', 'a')}\n`);
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(root, {
        recursive: true, force: true,
        operation: 'tests/unit/agent-worktree-reaper.test.ts:enotdir-afterEach',
      });
    } catch { /* best effort */ }
  });

  it('a `.git` FILE (so the index lock cannot exist) does NOT read as in-use', async () => {
    const deps = makeAgentWorktreeReaperDeps({
      instarRepo: root,
      worktreesDir: path.join(root, '.worktrees'),
      readGit: () => '',
      githubMergeCheck: false,
      cwdRoots: () => new Set<string>(),
    });
    expect(await deps.isInUse(wt)).toBe(false);
  });
});

/**
 * Tier 1 — ROUND FOUR: `emit('error')` must never be able to kill the process.
 *
 * WHY THIS EXISTS. Three round-four reviewers independently found that this class
 * emits `'error'` while the PRODUCTION construction site attaches no listener —
 * verified across the source tree AND the deployed build. In Node, emitting
 * `'error'` with zero listeners THROWS; both drivers call `void this.reap()` from a
 * timer, so the throw escapes as an unhandled rejection into a policy that treats
 * an unrecognised one as FATAL and exits the process. On an ARMED agent a single
 * failed `git worktree remove` therefore stops the server. Round three made it
 * worse by adding a third emit site (the pass ceiling).
 *
 * The tests that certified the ceiling could not see this because they attach an
 * error listener — without one the test runner itself crashes. So they installed
 * exactly the thing whose absence was the defect. These tests deliberately attach
 * NOTHING, which is the production shape.
 *
 * DISCRIMINATING: remove the constructor's default listener and every case here
 * throws instead of returning.
 */
describe('AgentWorktreeReaper — emit(error) is safe with NO listener attached', () => {
  it('a removal failure does NOT throw when nothing is listening', async () => {
    const boom = new Error('git worktree remove failed: locked');
    const reaper = new AgentWorktreeReaper(
      deps({ removeWorktree: () => { throw boom; } }),
      { enabled: true, dryRun: false },
    );
    // NOTE: no reaper.on('error', …) — this is the production wiring.
    const r = await reaper.reap();
    expect(r.reaped).toEqual([]);                 // kept, not deleted
    const snap = await reaper.snapshot();
    expect(snap.recentErrors.some((e) => e.message.includes('locked'))).toBe(true);
  });

  it('an enumeration failure does NOT throw, and is reported as UNDETERMINED', async () => {
    // The other half: `reclaimable: 0` must not be readable as "nothing to reclaim"
    // when the truth is "could not tell".
    const reaper = new AgentWorktreeReaper(
      deps({ listWorktrees: () => { throw new Error('worktree list unreadable'); } }),
      { enabled: false, dryRun: true },
    );
    const snap = await reaper.snapshot();
    expect(snap.enumerationFailed).toBe(true);
    expect(snap.reclaimable).toBe(0);
    expect(snap.recentErrors.some((e) => e.message.includes('unreadable'))).toBe(true);
  });

  it('CONTROL: a healthy pass reports no enumeration failure and no errors', async () => {
    // Pins that the honesty flags did not become always-on, which would make the
    // surface useless in the other direction.
    const reaper = new AgentWorktreeReaper(deps(), { enabled: false, dryRun: true });
    const snap = await reaper.snapshot();
    expect(snap.enumerationFailed).toBe(false);
    expect(snap.recentErrors).toEqual([]);
    expect(snap.worktrees.length).toBe(1);
  });

  it('a consumer that DOES attach a listener still receives every error', async () => {
    // The default listener must not shadow a real consumer.
    const seen: unknown[] = [];
    const reaper = new AgentWorktreeReaper(
      deps({ listWorktrees: () => { throw new Error('seen-by-consumer'); } }),
      { enabled: false, dryRun: true },
    );
    reaper.on('error', (e) => seen.push(e));
    await reaper.snapshot();
    expect(seen.length).toBe(1);
  });
});

/**
 * Tier 1 — ROUND FOUR: the MEMO-layer wall-clock ceiling.
 *
 * WHY THIS EXISTS. Round three added deadlines at three layers and the spec claimed
 * the discriminating coverage lived "at the memo and pass layers". The adversarial
 * reviewer showed no memo-layer test existed — every never-settling injection was at
 * the deps/pass layer — and that the memo deadline could therefore be reverted with
 * the whole suite green. The pin was trivially writable and simply had not been
 * written, while the document asserted it had.
 *
 * DISCRIMINATING: remove the deadline on the cwd-roots memo and this times out.
 */
describe('makeAgentWorktreeReaperDeps — a non-settling MEMO callee cannot pin its in-flight slot', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a cwd-roots scan that never settles still lets isInUse answer (KEEP)', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awg-memo-')));
    try {
      fs.mkdirSync(path.join(root, '.worktrees', 'a'), { recursive: true });
      const deps = makeAgentWorktreeReaperDeps({
        instarRepo: root,
        worktreesDir: path.join(root, '.worktrees'),
        readGit: () => '',
        githubMergeCheck: false,
        cwdRoots: () => new Promise<Set<string>>(() => { /* never settles */ }),
      });
      const p = deps.isInUse(path.join(root, '.worktrees', 'a'));
      await vi.advanceTimersByTimeAsync(60_000 + 1_000);
      // The memo's deadline rejects the scan; isInUse treats that as "cannot tell"
      // and answers KEEP rather than hanging forever.
      expect(await p).toBe(true);
    } finally {
      try {
        SafeFsExecutor.safeRmSync(root, {
          recursive: true, force: true,
          operation: 'tests/unit/agent-worktree-reaper.test.ts:memo-deadline',
        });
      } catch { /* best effort */ }
    }
  }, 20_000);
});

/**
 * Tier 1 — ROUND FIVE: two passes must never delete at once.
 *
 * WHY THIS EXISTS. Round three released the `running` latch at the CALLER ceiling,
 * in a `finally`. The abandoned pass is NOT cancelled — it keeps calling
 * `removeWorktree` — so releasing the latch let the NEXT pass start and delete
 * concurrently, and `maxReapsPerPass` (documented as "bounded blast radius per
 * pass") stopped being a rate limit: N overlapping passes could delete N x the cap.
 * Round four recorded that honestly and deferred it; the round-four scalability
 * reviewer and the round-five external reviewer independently said deferring is
 * weak precisely BECAUSE this component deletes.
 *
 * The fix separates the two clocks: the caller is freed at PASS_DEADLINE_MS, the
 * latch only when the work actually SETTLES (with LATCH_CEILING_MS as a last-resort
 * backstop so a never-settling pass cannot hold it for the process lifetime).
 *
 * DISCRIMINATING: move the latch release back into the caller path and the
 * overlap assertion below fails — a second pass starts and deletes.
 */
describe('AgentWorktreeReaper — an abandoned pass keeps the latch, so deletes cannot overlap', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a second reap() while the abandoned pass is still alive deletes NOTHING', async () => {
    const removed: string[] = [];
    let releaseFirst: (() => void) | null = null;
    // The first pass hangs inside listWorktrees; we release it by hand later.
    const gate = new Promise<WorktreeInfo[]>((res) => { releaseFirst = () => res([wt()]); });
    let call = 0;
    const d = deps({
      listWorktrees: () => (call++ === 0 ? gate : [wt()]),
      removeWorktree: (p: string) => { removed.push(p); },
    });
    const reaper = new AgentWorktreeReaper(d, { enabled: true, dryRun: false });

    const first = reaper.reap();
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);   // caller ceiling fires
    expect((await first).reaped).toEqual([]);                  // honest empty pass

    // THE ASSERTION. The abandoned pass is still alive and could still delete, so a
    // second pass must not start. Before the fix, this second call ran a full pass
    // and reaped — two passes deleting at once.
    const second = await reaper.reap();
    expect(second.reaped).toEqual([]);
    expect(removed).toEqual([]);

    // Once the original work settles, the latch frees and the reaper resumes normally.
    releaseFirst!();
    await vi.advanceTimersByTimeAsync(10);
    const third = await reaper.reap();
    expect(third.reaped.length).toBe(1);
  }, 20_000);

  it('CONTROL: back-to-back healthy passes are unaffected by the latch change', async () => {
    // Pins that binding the latch to the work did not make the reaper single-shot.
    const reaper = new AgentWorktreeReaper(deps({ removeWorktree: vi.fn() }), { enabled: true, dryRun: false });
    expect((await reaper.reap()).reaped.length).toBe(1);
    expect((await reaper.reap()).reaped.length).toBe(1);
  });
});
