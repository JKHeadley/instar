/**
 * Unit tests for ProjectRoundExecution.runRound.
 *
 * Covers:
 *   - Lock-already-held returns failed without spawning.
 *   - First-attempt complete: verifyMergedItems returns the full set
 *     on first pass, child never spawns.
 *   - Natural exit → verifyMergedItems gates outcome.
 *   - Partially-complete when subset verified.
 *   - Dynamic stop revalidation: itemIds mutation mid-run triggers
 *     relaunch; relaunchCount increments.
 *   - Halt mid-run: haltedAt set while child is running → SIGTERM.
 *   - Worktrees allocated lazily.
 *   - `.worktrees/` is appended to `.git/info/exclude`.
 *
 * The autonomous child is replaced with a harmless `bash -c "..."`
 * command so the test doesn't require `claude` or the autonomous
 * skill on PATH.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { ProjectRoundLock } from '../../src/core/ProjectRoundLock.js';
import { runRound, type MergedVerificationResult } from '../../src/core/ProjectRoundExecution.js';
import { ProjectRoundWorktrees } from '../../src/core/ProjectRoundWorktrees.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

/**
 * These stubs return the SAME three-state verdict the real verifier returns, so
 * the tests exercise the contract production runs rather than a simpler one.
 *
 * `notLanded` uses the no-mergeCommitOid reason deliberately: that is exactly
 * what `verifyMergedItemsViaGit` reports for work that has not landed yet, and
 * the runner must read it as work-to-do — never as "could not check", which
 * would stall every fresh round.
 */
const allVerified = (ids: string[]): MergedVerificationResult =>
  ({ verified: new Set(ids), regressed: new Set(), unverifiable: new Map() });
const notLanded = (ids: string[]): MergedVerificationResult =>
  ({
    verified: new Set(),
    regressed: new Set(),
    unverifiable: new Map(ids.map((i) => [i, 'no mergeCommitOid recorded on the item'])),
  });
const someVerified = (verifiedIds: string[], regressedIds: string[]): MergedVerificationResult =>
  ({ verified: new Set(verifiedIds), regressed: new Set(regressedIds), unverifiable: new Map() });

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pre-state-'));
}
function makeGitRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pre-target-'));
  SafeGitExecutor.run(['init', '-q'], { cwd: d, operation: 'tests/unit/ProjectRoundExecution.test.ts:makeGitRepo' });
  // A commit is required before `git worktree add --detach` will succeed.
  SafeGitExecutor.run(['config', 'user.email', 'test@test'], { cwd: d, operation: 'cfg' });
  SafeGitExecutor.run(['config', 'user.name', 'test'], { cwd: d, operation: 'cfg' });
  fs.writeFileSync(path.join(d, 'README'), 'x');
  SafeGitExecutor.run(['add', '.'], { cwd: d, operation: 'cfg' });
  SafeGitExecutor.run(['commit', '-m', 'init', '-q'], { cwd: d, operation: 'cfg' });
  return d;
}

async function newProject(
  tracker: InitiativeTracker,
  id: string,
  itemIds: string[],
  targetRepo: string
) {
  await tracker.create({
    id,
    title: `Project ${id}`,
    description: 'fixture',
    phases: [{ id: 'overview', name: 'overview' }],
    kind: 'project',
    rounds: [{ name: 'r0', itemIds }],
    targetRepoPath: targetRepo,
  });
  for (const child of itemIds) {
    await tracker.create({
      id: child,
      title: `Item ${child}`,
      description: 'item',
      phases: [{ id: 'p', name: 'p' }],
      parentProjectId: id,
      pipelineStage: 'outline',
    });
  }
}

describe('ProjectRoundExecution.runRound', () => {
  let stateDir: string;
  let targetRepo: string;
  let tracker: InitiativeTracker;

  beforeEach(() => {
    stateDir = makeStateDir();
    targetRepo = makeGitRepo();
    tracker = new InitiativeTracker(stateDir);
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundExecution.test.ts:state' }); } catch { /* ignore */ }
    try { SafeFsExecutor.safeRmSync(targetRepo, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundExecution.test.ts:repo' }); } catch { /* ignore */ }
  });

  it('lock-already-held returns failed without spawning anything', async () => {
    // Take the lock from a separate "machine" so our runner sees it held.
    const lock = new ProjectRoundLock({ stateDir });
    lock.acquire('p-already', 0);
    await newProject(tracker, 'p-already', ['i1'], targetRepo);

    let spawned = 0;
    const r = await runRound(
      {
        tracker,
        projectId: 'p-already',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: 'bash',
        spawnArgs: ['-c', 'exit 0'],
        pollIntervalMs: 50,
        sigtermGraceMs: 100,
        verifyMergedItems: async (ids) => { spawned++; return notLanded(ids); },
      },
      { stateDir }
    );
    expect(r.outcome).toBe('failed');
    expect(r.reason).toMatch(/lock held/);
    expect(spawned).toBe(0);
  });

  it('first-pass complete: verifyMergedItems returns the full set, no child spawn', async () => {
    await newProject(tracker, 'p-instant', ['i1', 'i2'], targetRepo);
    let spawnedCalls = 0;
    const r = await runRound(
      {
        tracker,
        projectId: 'p-instant',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        // Use a command that would fail loudly if invoked, so we know
        // it wasn't.
        spawnCommand: 'bash',
        spawnArgs: ['-c', 'exit 99'],
        pollIntervalMs: 50,
        sigtermGraceMs: 100,
        verifyMergedItems: async (ids) => {
          spawnedCalls++;
          return allVerified(ids);
        },
      },
      { stateDir }
    );
    expect(r.outcome).toBe('complete');
    expect(r.mergedItemIds).toEqual(['i1', 'i2']);
    expect(r.relaunchCount).toBe(0);
    expect(r.resumeAttempts).toBe(0);
    // verifyMergedItems was called exactly once (the pre-spawn check),
    // not after a spawn.
    expect(spawnedCalls).toBe(1);
  });

  it('natural exit + full verification → complete', async () => {
    await newProject(tracker, 'p-nat', ['i1'], targetRepo);
    // Step 1: pre-spawn check returns 0 → child spawns.
    // Step 2 (post-spawn): we verify-merged on natural exit.
    let calls = 0;
    const verify = async (ids: string[]): Promise<MergedVerificationResult> => {
      calls++;
      // First call (pre-spawn): nothing landed yet. Second (post-spawn): all verified.
      return calls === 1 ? notLanded(ids) : allVerified(ids);
    };
    const r = await runRound(
      {
        tracker,
        projectId: 'p-nat',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: 'bash',
        spawnArgs: ['-c', 'exit 0'], // exits immediately
        pollIntervalMs: 50,
        sigtermGraceMs: 100,
        verifyMergedItems: verify,
      },
      { stateDir }
    );
    expect(r.outcome).toBe('complete');
    expect(r.mergedItemIds).toEqual(['i1']);
  });

  it('natural exit + subset verified → partially-complete', async () => {
    await newProject(tracker, 'p-part', ['i1', 'i2', 'i3'], targetRepo);
    let calls = 0;
    const verify = async (ids: string[]): Promise<MergedVerificationResult> => {
      calls++;
      if (calls === 1) return notLanded(ids);
      // Only the first landed; the rest are GENUINELY not merged (git exit 1).
      // They must be `regressed`, not `unverifiable` — `partially-complete`
      // asserts real non-landing, and an uncheckable item cannot support it.
      return someVerified([ids[0]], ids.slice(1));
    };
    const r = await runRound(
      {
        tracker,
        projectId: 'p-part',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: 'bash',
        spawnArgs: ['-c', 'exit 0'],
        pollIntervalMs: 50,
        sigtermGraceMs: 100,
        verifyMergedItems: verify,
      },
      { stateDir }
    );
    expect(r.outcome).toBe('partially-complete');
    expect(r.mergedItemIds).toEqual(['i1']);
    expect(r.unmergedItemIds).toEqual(['i2', 'i3']);
    // round.status updated.
    const after = tracker.get('p-part')!;
    expect(after.rounds![0].status).toBe('partially-complete');
  });

  it('halt mid-run: haltedAt set during child sleep → outcome=halted', async () => {
    await newProject(tracker, 'p-halt', ['i1'], targetRepo);
    let phase = 0;
    const verify = async (ids: string[]): Promise<MergedVerificationResult> => {
      phase++;
      return notLanded(ids); // never landed — child has to run
    };
    // The child sleeps 10s but the runner halts mid-poll.
    const runPromise = runRound(
      {
        tracker,
        projectId: 'p-halt',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: 'bash',
        spawnArgs: ['-c', 'sleep 10'],
        pollIntervalMs: 100,
        sigtermGraceMs: 200,
        verifyMergedItems: verify,
      },
      { stateDir }
    );
    // Wait briefly so the child is running, then set haltedAt.
    await new Promise((r) => setTimeout(r, 150));
    const proj = tracker.get('p-halt')!;
    const rounds = (proj.rounds ?? []).map((r, i) => i === 0 ? { ...r, haltedAt: new Date().toISOString(), haltReason: 'test' } : r);
    await tracker.update('p-halt', { rounds, ifMatch: proj.version });

    const r = await runPromise;
    expect(r.outcome).toBe('halted');
    expect(r.reason).toMatch(/halted/i);
    expect(phase).toBeGreaterThan(0);
  });

  it('dynamic stop revalidation: itemIds change → relaunch counter increments', async () => {
    await newProject(tracker, 'p-dyn', ['i1', 'i2'], targetRepo);
    let calls = 0;
    const verify = async (ids: string[]): Promise<MergedVerificationResult> => {
      calls++;
      // 1st pre-spawn: nothing landed. After relaunch: all verified (clean exit).
      return calls >= 2 ? allVerified(ids) : notLanded(ids);
    };
    // Long-running child, runner relaunches it on itemIds change.
    const runPromise = runRound(
      {
        tracker,
        projectId: 'p-dyn',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: 'bash',
        spawnArgs: ['-c', 'sleep 10'],
        pollIntervalMs: 100,
        sigtermGraceMs: 200,
        verifyMergedItems: verify,
      },
      { stateDir }
    );
    // Wait briefly so the child is running, then mutate the itemIds.
    await new Promise((r) => setTimeout(r, 150));
    const proj = tracker.get('p-dyn')!;
    const rounds = (proj.rounds ?? []).map((r, i) => i === 0 ? { ...r, itemIds: ['i1'] } : r); // dropped i2
    await tracker.update('p-dyn', { rounds, ifMatch: proj.version });

    const r = await runPromise;
    expect(r.relaunchCount).toBeGreaterThanOrEqual(1);
    expect(r.outcome).toBe('complete');
    expect(r.mergedItemIds).toEqual(['i1']);
  });

  it('worktree path is allocated for the first item', async () => {
    await newProject(tracker, 'p-wt', ['i1'], targetRepo);
    await runRound(
      {
        tracker,
        projectId: 'p-wt',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: 'bash',
        spawnArgs: ['-c', 'exit 0'],
        pollIntervalMs: 50,
        sigtermGraceMs: 100,
        verifyMergedItems: async (ids) => allVerified(ids), // instant complete
      },
      { stateDir }
    );
    const wt = ProjectRoundWorktrees.pathFor({ targetRepoPath: targetRepo, projectId: 'p-wt', roundIndex: 0, itemId: 'i1' });
    expect(fs.existsSync(wt)).toBe(true);
  });

  it('appends .worktrees/ to .git/info/exclude on first allocation', async () => {
    await newProject(tracker, 'p-ex', ['i1'], targetRepo);
    await runRound(
      {
        tracker,
        projectId: 'p-ex',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: 'bash',
        spawnArgs: ['-c', 'exit 0'],
        pollIntervalMs: 50,
        sigtermGraceMs: 100,
        verifyMergedItems: async (ids) => allVerified(ids),
      },
      { stateDir }
    );
    const exclude = fs.readFileSync(path.join(targetRepo, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('.worktrees/');
  });
});

/**
 * A child that cannot START is a different fact from a child that started and
 * failed, and the round record must not render them the same.
 *
 * `child_process.spawn` reports a failure to start by emitting `'error'`, NOT
 * `'exit'`. Before this change nothing listened for it, so:
 *   - the unhandled `'error'` became a process-level uncaught exception, which
 *     `uncaughtExceptionPolicy` correctly crashes on (it cannot know an unknown
 *     exception is safe to swallow) — taking the whole agent server down; and
 *   - `'exit'` never fires, so a waiter listening only for `'exit'` waits for an
 *     event that cannot arrive.
 *
 * These tests use a genuinely nonexistent binary, so the ENOENT is REAL rather
 * than mocked — the same failure the server hit twice on 2026-07-30.
 *
 * DISCRIMINATION: tests 1-3 were run against the pre-change source and FAIL
 * there. Test 4 is a CONTROL — it passes on both revisions and is included to
 * prove the ordinary exit path is untouched, not as evidence for this change.
 */
describe('ProjectRoundExecution.runRound — child that cannot start', () => {
  let stateDir: string;
  let targetRepo: string;
  let tracker: InitiativeTracker;

  beforeEach(() => {
    stateDir = makeStateDir();
    targetRepo = makeGitRepo();
    tracker = new InitiativeTracker(stateDir);
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundExecution.test.ts:state' }); } catch { /* ignore */ }
    try { SafeFsExecutor.safeRmSync(targetRepo, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundExecution.test.ts:repo' }); } catch { /* ignore */ }
  });

  const MISSING_BINARY = '/nonexistent/instar-test-definitely-not-a-real-binary';

  it('DISCRIMINATING: an unstartable child resolves as a failed round instead of crashing the process', async () => {
    await newProject(tracker, 'p-nospawn', ['i1'], targetRepo);
    const r = await runRound(
      {
        tracker,
        projectId: 'p-nospawn',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: MISSING_BINARY,
        spawnArgs: [],
        pollIntervalMs: 50,
        sigtermGraceMs: 100,
        verifyMergedItems: async (ids) => notLanded(ids),
      },
      { stateDir }
    );
    expect(r.outcome).toBe('failed');
  });

  it('DISCRIMINATING: the reason NAMES the start failure rather than reporting exhausted attempts', async () => {
    await newProject(tracker, 'p-reason', ['i1'], targetRepo);
    const r = await runRound(
      {
        tracker,
        projectId: 'p-reason',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: MISSING_BINARY,
        spawnArgs: [],
        pollIntervalMs: 50,
        sigtermGraceMs: 100,
        verifyMergedItems: async (ids) => notLanded(ids),
      },
      { stateDir }
    );
    // The honest cause, not a proxy for it.
    expect(r.reason).toMatch(/could not start/i);
    expect(r.reason).toMatch(/ENOENT/);
    // "attempts exhausted" would be a TRUE-sounding but WRONG reason: the
    // problem is not that retries ran out, it is that the binary is not there.
    expect(r.reason).not.toMatch(/attempts exhausted/i);
  });

  it('DISCRIMINATING: a start failure does not burn the resume-attempt budget', async () => {
    await newProject(tracker, 'p-noresume', ['i1'], targetRepo);
    const r = await runRound(
      {
        tracker,
        projectId: 'p-noresume',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: MISSING_BINARY,
        spawnArgs: [],
        pollIntervalMs: 50,
        sigtermGraceMs: 100,
        verifyMergedItems: async (ids) => notLanded(ids),
      },
      { stateDir }
    );
    // Relaunching a binary that does not exist cannot succeed, so spending the
    // budget on it only delays the honest answer and mislabels the cause.
    expect(r.resumeAttempts).toBe(0);
  });

  it('CONTROL (passes on both revisions): an ordinary non-zero exit still exhausts resumes and reports that', async () => {
    await newProject(tracker, 'p-control-exit', ['i1'], targetRepo);
    const r = await runRound(
      {
        tracker,
        projectId: 'p-control-exit',
        roundIndex: 0,
        targetRepoPath: targetRepo,
        spawnCommand: 'bash',
        spawnArgs: ['-c', 'exit 3'],
        pollIntervalMs: 50,
        sigtermGraceMs: 100,
        verifyMergedItems: async (ids) => notLanded(ids),
      },
      { stateDir }
    );
    expect(r.outcome).toBe('failed');
    expect(r.reason).toMatch(/attempts exhausted/i);
    expect(r.resumeAttempts).toBeGreaterThan(0);
  });
});
