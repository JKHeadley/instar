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
import { runRound } from '../../src/core/ProjectRoundExecution.js';
import { ProjectRoundWorktrees } from '../../src/core/ProjectRoundWorktrees.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

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
        verifyMergedItems: async () => { spawned++; return new Set<string>(); },
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
          return new Set(ids);
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
    const verify = async (ids: string[]): Promise<Set<string>> => {
      calls++;
      // First call (pre-spawn): nothing verified. Second call (post-spawn): all verified.
      return calls === 1 ? new Set<string>() : new Set(ids);
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
    const verify = async (ids: string[]): Promise<Set<string>> => {
      calls++;
      if (calls === 1) return new Set<string>();
      return new Set([ids[0]]); // only first item verified
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
    const verify = async (): Promise<Set<string>> => {
      phase++;
      return new Set<string>(); // never verified — child has to run
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
    const verify = async (ids: string[]): Promise<Set<string>> => {
      calls++;
      // 1st pre-spawn: nothing. After relaunch: all verified (so we exit cleanly).
      return calls >= 2 ? new Set(ids) : new Set<string>();
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
        verifyMergedItems: async (ids) => new Set(ids), // instant complete
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
        verifyMergedItems: async (ids) => new Set(ids),
      },
      { stateDir }
    );
    const exclude = fs.readFileSync(path.join(targetRepo, '.git', 'info', 'exclude'), 'utf-8');
    expect(exclude).toContain('.worktrees/');
  });
});
