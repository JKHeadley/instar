/**
 * The reaper's main-process half with an out-of-process runner
 * (docs/specs/reaper-removal-out-of-process.md §1, §3, §4, §6):
 *   - dryRun true: no child; the worker report is kept;
 *   - dryRun false: no git, lsof, ps or file walk on this thread; at most one child per pass;
 *   - the child's failure rows trip the breaker, and a tripped path is left out of the next run;
 *   - the route serves the child's full evaluation.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  AgentWorktreeReaper,
  DEFAULT_AGENT_WORKTREE_REAPER_CONFIG,
  type AgentWorktreeReaperDeps,
  type ReclaimAttemptOutcome,
  type ReclaimReportFile,
  type ReclaimRunnerPort,
} from '../../src/monitoring/AgentWorktreeReaper.js';

const forbidden = (name: string) => vi.fn(() => { throw new Error(`main thread called ${name}`); });

function syncDepsThatMustNotRun(): AgentWorktreeReaperDeps & { calls: () => number } {
  const fns = {
    preparePass: vi.fn(async () => { throw new Error('main thread called preparePass'); }),
    listWorktrees: forbidden('listWorktrees'),
    isClean: forbidden('isClean'),
    isMerged: forbidden('isMerged'),
    isInUse: forbidden('isInUse'),
    currentBranch: forbidden('currentBranch'),
    removeWorktree: forbidden('removeWorktree'),
    projectReclaim: forbidden('projectReclaim'),
    nodeModulesKind: forbidden('nodeModulesKind'),
    archiveBytes: forbidden('archiveBytes'),
    evaluateAllOffThread: vi.fn(async () => ({ ok: true as const, worktrees: [] })),
  };
  return {
    ...(fns as unknown as AgentWorktreeReaperDeps),
    warn: () => undefined,
    calls: () => Object.values(fns).reduce((a, f) => a + f.mock.calls.length, 0),
  };
}

function fakeRunner() {
  let outcomes: ReclaimAttemptOutcome[] = [];
  let report: ReclaimReportFile | null = null;
  let busy = false;
  let finish: (() => void) | null = null;
  const starts: Array<{ excludedPaths: string[] }> = [];
  const runner: ReclaimRunnerPort = {
    startRun: vi.fn(async (req) => {
      if (busy) return { started: false as const, reason: 'busy' };
      starts.push(req);
      busy = true;
      const done = new Promise<void>((r) => { finish = () => { busy = false; r(); }; });
      return { started: true as const, runId: `run${starts.length}`, done };
    }),
    collectOutcomes: vi.fn(async () => { const o = outcomes; outcomes = []; return o; }),
    readReport: vi.fn(async () => report),
    busy: () => busy,
  };
  return {
    runner, starts,
    finishWith: async (o: ReclaimAttemptOutcome[], r: ReclaimReportFile | null) => {
      outcomes = o; report = r; finish?.();
      for (let i = 0; i < 10; i++) await new Promise((res) => setImmediate(res));
    },
  };
}

describe('AgentWorktreeReaper with an out-of-process reclaim runner', () => {
  it('the default cadence is hourly and removal still ships dry-run', () => {
    expect(DEFAULT_AGENT_WORKTREE_REAPER_CONFIG.reapIntervalMs).toBe(3_600_000);
    expect(DEFAULT_AGENT_WORKTREE_REAPER_CONFIG.dryRun).toBe(true);
  });

  it('dryRun true: no child is started; the pass is the worker report', async () => {
    const deps = syncDepsThatMustNotRun();
    const f = fakeRunner();
    const reaper = new AgentWorktreeReaper({ ...deps, reclaimRunner: f.runner }, { enabled: true, dryRun: true });
    await reaper.reap();
    expect(f.runner.startRun).not.toHaveBeenCalled();
    expect(deps.evaluateAllOffThread).toHaveBeenCalledTimes(1);
    const rep = await reaper.report();
    expect(rep.source).toBe('last-pass');
  });

  it('dryRun false: a pass runs no git, lsof, ps or walk on this thread and starts exactly one child', async () => {
    const deps = syncDepsThatMustNotRun();
    const f = fakeRunner();
    const reaper = new AgentWorktreeReaper({ ...deps, reclaimRunner: f.runner }, { enabled: true, dryRun: false });
    const res = await reaper.reap();
    expect(res.dryRun).toBe(false);
    await reaper.reap(); // the first run is still going: no second child
    await reaper.report();
    expect(f.starts).toHaveLength(1);
    expect(deps.calls()).toBe(0);
  });

  it('the child failure rows trip the breaker; a tripped path is left out of the next run; a removal clears it', async () => {
    const deps = syncDepsThatMustNotRun();
    const f = fakeRunner();
    const reaper = new AgentWorktreeReaper({ ...deps, reclaimRunner: f.runner }, { enabled: true, dryRun: false, maxReclaimFailuresPerPath: 2 });
    const tripped = vi.fn();
    reaper.on('reclaim-breaker', tripped);
    await reaper.reap();
    await f.finishWith([
      { attemptId: 'x1', path: '/wt/stuck', kind: 'failed', reason: 'run ended mid-attempt before the rename' },
      { attemptId: 'x2', path: '/wt/stuck', kind: 'failed', reason: 'archive verification failed' },
      { attemptId: 'x3', path: '/wt/fine', kind: 'removed' },
    ], null);
    expect(tripped).toHaveBeenCalledWith({ path: '/wt/stuck', failures: 2 });
    await reaper.reap();
    expect(f.starts[1].excludedPaths).toEqual(['/wt/stuck']);
    await f.finishWith([{ attemptId: 'x4', path: '/wt/stuck', kind: 'removed' }], null);
    await reaper.reap();
    expect(f.starts[2].excludedPaths).toEqual([]);
    expect(deps.calls()).toBe(0);
  });

  it('in live mode the route serves the child\'s full evaluation', async () => {
    const deps = syncDepsThatMustNotRun();
    const f = fakeRunner();
    const reaper = new AgentWorktreeReaper({ ...deps, reclaimRunner: f.runner }, { enabled: true, dryRun: false });
    await reaper.reap();
    const during = await reaper.report();
    expect(during.passRunning).toBe(true);
    expect(during.enumerationOk).toBe(false); // no run has finished yet: unknown, not zero
    expect(during.reclaimable).toBeNull();
    const report: ReclaimReportFile = {
      runId: 'run1', at: 1_700_000_000_000, phase: 'final', enumerationOk: true, archiveBytes: 1234, removed: ['/wt/a'], stopReason: null,
      trash: { deleted: [], errors: [], stuck: [{ name: 'old-1', bytes: 4096, lastError: 'Operation not permitted' }], deferred: [] },
      worktrees: [
        { path: '/wt/a', branch: 'a', verdict: 'reap-eligible', reason: 'merged-clean-idle', outcome: 'removed' },
        { path: '/wt/b', branch: 'b', verdict: 'keep', reason: 'uncommitted-changes', nodeModules: 'real' },
        { path: '/wt/c', branch: 'c', verdict: 'keep', reason: 'in-use' },
      ],
    };
    await f.finishWith([{ attemptId: 'y', path: '/wt/a', kind: 'removed' }], report);
    const after = await reaper.report();
    expect(after.worktrees).toHaveLength(3);
    expect(after.reapedLastPass).toBe(1);
    expect(after.archiveBytes).toBe(1234);
    expect(after.evaluatedAt).toBe(report.at);
    expect(after.passRunning).toBe(false);
    expect(after.nodeModules.keptForRealNodeModules).toBe(1);
    expect(after.trash?.stuck).toEqual([{ name: 'old-1', bytes: 4096, lastError: 'Operation not permitted' }]);
    expect(deps.calls()).toBe(0);
  });

  it('a child report that could not enumerate is recorded as an enumeration failure (unknown, not zero)', async () => {
    const deps = syncDepsThatMustNotRun();
    const f = fakeRunner();
    const reaper = new AgentWorktreeReaper({ ...deps, reclaimRunner: f.runner }, { enabled: true, dryRun: false });
    await reaper.reap();
    await f.finishWith([], { runId: 'r', at: 5, phase: 'final', enumerationOk: false, enumerationError: 'git failed', worktrees: [], archiveBytes: null, removed: [] });
    const rep = await reaper.report();
    expect(rep.enumerationOk).toBe(false);
    expect(rep.enumerationError).toBe('git failed');
    expect(rep.enumerationFailures).toBe(1);
  });

  it('a run the runner refuses (unresolved ownership) starts nothing and is surfaced', async () => {
    const deps = syncDepsThatMustNotRun();
    const runner: ReclaimRunnerPort = {
      startRun: vi.fn(async () => ({ started: false as const, reason: 'unresolved' })),
      collectOutcomes: vi.fn(async () => []),
      readReport: vi.fn(async () => null),
      busy: () => true,
    };
    const reaper = new AgentWorktreeReaper({ ...deps, reclaimRunner: runner }, { enabled: true, dryRun: false });
    const skipped = vi.fn();
    reaper.on('reclaim-run-skipped', skipped);
    await reaper.reap();
    expect(skipped).toHaveBeenCalledWith({ reason: 'unresolved' });
    expect(deps.calls()).toBe(0);
  });
});
