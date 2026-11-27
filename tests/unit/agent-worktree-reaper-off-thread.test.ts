/**
 * AgentWorktreeReaper off the main thread (fb-91e824f4-920): a pass that removes
 * nothing uses the off-thread evaluator, the report answers from the last pass,
 * a failed pass reads unknown (never zero), and a live (dryRun:false) pass keeps
 * the in-process path. The worker launcher ends a worker that never answers.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentWorktreeReaper, type AgentWorktreeReaperDeps, type WorktreeEvaluation } from '../../src/monitoring/AgentWorktreeReaper.js';
import { evaluateAgentWorktreesInWorker, runAgentWorktreeEvaluation } from '../../src/monitoring/agentWorktreeEvaluationJob.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const evals: WorktreeEvaluation[] = [
  { path: '/w/a', branch: 'a', verdict: 'reap-eligible', reason: 'merged-clean-idle' },
  { path: '/w/b', branch: 'b', verdict: 'keep', reason: 'in-use' },
];

function deps(over: Partial<AgentWorktreeReaperDeps> = {}): AgentWorktreeReaperDeps & { calls: { list: number; off: number; removed: string[] } } {
  const calls = { list: 0, off: 0, removed: [] as string[] };
  return {
    calls,
    listWorktrees: () => { calls.list++; return { ok: true, worktrees: [{ path: '/w/a', branch: 'a', headSha: 'x' }] }; },
    isClean: () => true,
    isMerged: () => true,
    isInUse: () => false,
    currentBranch: () => 'a',
    removeWorktree: (p: string) => { calls.removed.push(p); },
    evaluateAllOffThread: async () => { calls.off++; return { ok: true, worktrees: evals }; },
    ...over,
  } as AgentWorktreeReaperDeps & { calls: { list: number; off: number; removed: string[] } };
}

describe('AgentWorktreeReaper off-thread pass', () => {
  it('a dry-run pass uses the off-thread evaluator and never lists on the main thread', async () => {
    const d = deps();
    const r = new AgentWorktreeReaper(d, { enabled: true, dryRun: true });
    const out = await r.reap();
    expect(d.calls.off).toBe(1);
    expect(d.calls.list).toBe(0);
    expect(out.evaluations).toEqual(evals);
    expect(d.calls.removed).toEqual([]);
  });

  it('the report answers from the last pass without evaluating again', async () => {
    const d = deps();
    const r = new AgentWorktreeReaper(d, { enabled: true, dryRun: true });
    await r.reap();
    const rep = await r.report();
    expect(d.calls.off).toBe(1);
    expect(rep.source).toBe('last-pass');
    expect(rep.reclaimable).toBe(1);
    expect(rep.worktrees).toHaveLength(2);
    expect(typeof rep.evaluatedAt).toBe('number');
  });

  it('with no pass yet, the report runs one pass off-thread (also when the reaper is disabled)', async () => {
    const d = deps();
    const r = new AgentWorktreeReaper(d, { enabled: false, dryRun: true });
    const rep = await r.report();
    expect(d.calls.off).toBe(1);
    expect(d.calls.list).toBe(0);
    expect(rep.reclaimable).toBe(1);
  });

  it('a failed off-thread pass reads unknown, never zero, and counts as an enumeration failure', async () => {
    const d = deps({ evaluateAllOffThread: async () => ({ ok: false, error: 'worker exited' }) });
    const r = new AgentWorktreeReaper(d, { enabled: true, dryRun: true });
    await r.reap();
    const rep = await r.report();
    expect(rep.enumerationOk).toBe(false);
    expect(rep.reclaimable).toBeNull();
    expect(rep.enumerationError).toContain('worker exited');
    expect(rep.enumerationFailures).toBe(1);
    expect(r.guardStatus().verdictUnknown).toBe(true);
  });

  it('a live pass (dryRun false) keeps the in-process path, so removal still has its re-check', async () => {
    const d = deps();
    const r = new AgentWorktreeReaper(d, { enabled: true, dryRun: false });
    r.on('error', () => {});
    await r.reap();
    expect(d.calls.off).toBe(0);
    expect(d.calls.list).toBe(1);
    expect(d.calls.removed).toEqual(['/w/a']);
  });

  it('a read never starts a pass on a live reaper (dryRun false): no removal from GET', async () => {
    const d = deps();
    const r = new AgentWorktreeReaper(d, { enabled: true, dryRun: false });
    const rep = await r.report();
    expect(d.calls.list).toBe(0);
    expect(d.calls.off).toBe(0);
    expect(d.calls.removed).toEqual([]);
    expect(rep.enumerationError).toBe('no pass has finished yet');
  });

  it('a stale or failed last pass is refreshed in the background, not on the request', async () => {
    let clock = 1_000_000;
    let fail = true;
    let offCalls = 0;
    const d = deps({ evaluateAllOffThread: async () => { offCalls++; return fail ? { ok: false, error: 'boom' } : { ok: true, worktrees: evals }; } });
    const r = new AgentWorktreeReaper({ ...d, now: () => clock }, { enabled: false, dryRun: true, reapIntervalMs: 60_000 });
    await r.reap();
    fail = false;
    // Within the backoff, reads do not retry the failed pass.
    const early = await r.report();
    expect(early.passRunning).toBe(false);
    expect(offCalls).toBe(1);
    clock += 61_000; // past min(reapIntervalMs 60 s, 5 min)
    const first = await r.report();
    expect(first.passRunning).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    const second = await r.report();
    expect(second.reclaimable).toBe(1);
    clock += 120_000;
    const third = await r.report();
    expect(third.passRunning).toBe(true);
  });

  it('without an off-thread evaluator the report keeps the old synchronous shape', async () => {
    const d = deps({ evaluateAllOffThread: undefined });
    const r = new AgentWorktreeReaper(d, { enabled: true, dryRun: true });
    const rep = await r.report();
    expect(rep.source).toBe('live');
    expect(d.calls.list).toBe(1);
  });
});

describe('evaluateAgentWorktreesInWorker', () => {
  let dir = '';
  afterEach(() => { if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/agent-worktree-reaper-off-thread.test.ts' }); dir = ''; });

  it('ends a worker that never answers and resolves a failure (never rejects)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-worker-'));
    const hang = path.join(dir, 'hang.mjs');
    fs.writeFileSync(hang, 'setInterval(() => {}, 1000);\n');
    const started = Date.now();
    const r = await evaluateAgentWorktreesInWorker({ instarRepo: dir, worktreesDir: dir, githubMergeCheck: false, timeoutMs: 300, workerUrl: pathToFileURL(hang) });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain('still running');
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('a worker that exits without answering resolves a failure', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-worker-'));
    const quit = path.join(dir, 'quit.mjs');
    fs.writeFileSync(quit, 'process.exit(0);\n');
    const r = await evaluateAgentWorktreesInWorker({ instarRepo: dir, worktreesDir: dir, githubMergeCheck: false, timeoutMs: 10_000, workerUrl: pathToFileURL(quit) });
    expect(r.ok).toBe(false);
  });

  it('the worker body evaluates a real repo and returns one evaluation per checkout', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awr-real-'));
    const repo = path.join(dir, 'home');
    fs.mkdirSync(repo);
    const git = (...args: string[]) => SafeGitExecutor.execSync(['-C', repo, ...args], { cwd: repo, stdio: 'pipe', operation: 'tests/unit/agent-worktree-reaper-off-thread.test.ts:real-repo' });
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'base');
    git('worktree', 'add', '-q', '-b', 'feat', path.join(repo, '.worktrees', 'feat'));
    const r = await runAgentWorktreeEvaluation({ instarRepo: repo, worktreesDir: path.join(repo, '.worktrees'), githubMergeCheck: false });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.worktrees).toHaveLength(1);
      expect(r.worktrees[0].path).toContain('feat');
      expect(['keep', 'reap-eligible']).toContain(r.worktrees[0].verdict);
    }
  });
});
