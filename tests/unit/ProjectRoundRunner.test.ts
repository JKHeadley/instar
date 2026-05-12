/**
 * Unit tests for ProjectRoundRunner — Phase 1b PR 3.
 *
 * Covers the preflight gate (all reject codes + happy path), the halt
 * idempotent path, recordAck, and acceptPartial. The HTTP routes that
 * wrap these methods are exercised by tests/integration/projects-api.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InitiativeTracker, type Initiative } from '../../src/core/InitiativeTracker.js';
import { ProjectRoundRunner } from '../../src/core/ProjectRoundRunner.js';
import { ProjectRoundLock } from '../../src/core/ProjectRoundLock.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'round-runner-'));
}

/** Initialize a real git repo in `dir` so step 8 (targetRepoPath is a git repo) passes. */
function makeGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'round-runner-target-'));
  SafeGitExecutor.run(['init', '-q'], { cwd: dir, operation: 'tests/unit/ProjectRoundRunner.test.ts:makeGitRepo' });
  return dir;
}

async function createProject(
  tracker: InitiativeTracker,
  id: string,
  overrides: Partial<{
    targetRepoPath: string;
    rounds: Array<{ name: string; itemIds: string[]; status?: 'pending' | 'ready' | 'in-progress' | 'failed' | 'complete' }>;
    firstLaunchAckAt?: string;
    lastAckedRoundIndex?: number;
    unacknowledgedAdvanceCount?: number;
    ownerMachineId?: string;
    status?: 'active' | 'archived';
  }> = {}
): Promise<Initiative> {
  const init = await tracker.create({
    id,
    title: `Project ${id}`,
    description: 'test fixture',
    phases: [{ id: 'overview', name: 'overview' }],
    kind: 'project',
    rounds: overrides.rounds ?? [{ name: 'r1', itemIds: [] }],
    targetRepoPath: overrides.targetRepoPath,
    ownerMachineId: overrides.ownerMachineId,
  });
  // create() doesn't accept firstLaunchAckAt / unacknowledgedAdvanceCount /
  // lastAckedRoundIndex; we set them via update() to match how the runner
  // observes them in production (mutated after create).
  const updates: Record<string, unknown> = {};
  if (overrides.firstLaunchAckAt !== undefined) updates.firstLaunchAckAt = overrides.firstLaunchAckAt;
  if (overrides.lastAckedRoundIndex !== undefined) updates.lastAckedRoundIndex = overrides.lastAckedRoundIndex;
  if (overrides.unacknowledgedAdvanceCount !== undefined) updates.unacknowledgedAdvanceCount = overrides.unacknowledgedAdvanceCount;
  if (overrides.status && overrides.status !== 'active') updates.status = overrides.status;
  if (Object.keys(updates).length > 0) {
    return tracker.update(id, updates as never);
  }
  return init;
}

async function createChild(tracker: InitiativeTracker, id: string, parentId: string, stage: string = 'outline'): Promise<Initiative> {
  return tracker.create({
    id,
    title: `Child ${id}`,
    description: 'child fixture',
    phases: [{ id: 'p', name: 'p' }],
    parentProjectId: parentId,
    pipelineStage: stage as never,
  });
}

describe('ProjectRoundRunner.preflight', () => {
  let stateDir: string;
  let targetRepo: string;
  let tracker: InitiativeTracker;
  let runner: ProjectRoundRunner;
  const machineId = 'machine-A';

  beforeEach(() => {
    stateDir = makeStateDir();
    targetRepo = makeGitRepo();
    tracker = new InitiativeTracker(stateDir);
    runner = new ProjectRoundRunner({ tracker, stateDir, machineId });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:afterEach-state' }); } catch { /* ignore */ }
    try { SafeFsExecutor.safeRmSync(targetRepo, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:afterEach-repo' }); } catch { /* ignore */ }
  });

  it('happy path — round 0 with firstLaunchAckAt populated passes', async () => {
    await createProject(tracker, 'p1', {
      targetRepoPath: targetRepo,
      firstLaunchAckAt: new Date().toISOString(),
      rounds: [{ name: 'r0', itemIds: ['p1-1'] }],
    });
    await createChild(tracker, 'p1-1', 'p1');
    const r = runner.preflight('p1', 0);
    expect(r.ok).toBe(true);
  });

  it('PROJECT_NOT_FOUND when project id is unknown', () => {
    const r = runner.preflight('does-not-exist', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PROJECT_NOT_FOUND');
  });

  it('PROJECT_NOT_PROJECT_KIND when the record is a regular task', async () => {
    await tracker.create({
      id: 'not-a-project',
      title: 'just a task',
      description: 'plain',
      phases: [{ id: 'p', name: 'p' }],
    });
    const r = runner.preflight('not-a-project', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PROJECT_NOT_PROJECT_KIND');
  });

  it('PROJECT_INACTIVE when status is archived', async () => {
    await createProject(tracker, 'p1', { targetRepoPath: targetRepo, status: 'archived' });
    const r = runner.preflight('p1', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PROJECT_INACTIVE');
  });

  it('ROUND_INDEX_OUT_OF_RANGE when index is past the rounds array', async () => {
    await createProject(tracker, 'p1', { targetRepoPath: targetRepo });
    const r = runner.preflight('p1', 5);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ROUND_INDEX_OUT_OF_RANGE');
  });

  it('PROJECT_HALTED when the round was halted', async () => {
    await createProject(tracker, 'p1', {
      targetRepoPath: targetRepo,
      firstLaunchAckAt: new Date().toISOString(),
      rounds: [{ name: 'r0', itemIds: [] }],
    });
    // Manually halt the round.
    const p = tracker.get('p1')!;
    const halted = (p.rounds ?? []).map((r, i) => i === 0 ? { ...r, haltedAt: new Date().toISOString(), haltReason: 'test' } : r);
    await tracker.update('p1', { rounds: halted });

    const r = runner.preflight('p1', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PROJECT_HALTED');
  });

  it('FIRST_LAUNCH_ACK_REQUIRED when round 0 has no firstLaunchAckAt', async () => {
    await createProject(tracker, 'p1', { targetRepoPath: targetRepo });
    const r = runner.preflight('p1', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('FIRST_LAUNCH_ACK_REQUIRED');
  });

  it('UNACKED_ADVANCES_OVER_CAP when count is at or over the cap', async () => {
    await createProject(tracker, 'p1', {
      targetRepoPath: targetRepo,
      firstLaunchAckAt: new Date().toISOString(),
      unacknowledgedAdvanceCount: 2,
    });
    const r = runner.preflight('p1', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('UNACKED_ADVANCES_OVER_CAP');
  });

  it('ROUND_ACK_GAP_TOO_LARGE when roundIndex is more than ackGapCap ahead of lastAckedRoundIndex', async () => {
    await createProject(tracker, 'p1', {
      targetRepoPath: targetRepo,
      firstLaunchAckAt: new Date().toISOString(),
      lastAckedRoundIndex: 0,
      rounds: [
        { name: 'r0', itemIds: [] },
        { name: 'r1', itemIds: [] },
        { name: 'r2', itemIds: [] },
        { name: 'r3', itemIds: [] },
      ],
    });
    // lastAckedRoundIndex=0, requested=3 → gap=3 > cap=2.
    const r = runner.preflight('p1', 3);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('ROUND_ACK_GAP_TOO_LARGE');
  });

  it('NOT_OWNER_MACHINE when ownerMachineId is a different machine', async () => {
    await createProject(tracker, 'p1', {
      targetRepoPath: targetRepo,
      firstLaunchAckAt: new Date().toISOString(),
      ownerMachineId: 'machine-B',
    });
    const r = runner.preflight('p1', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('NOT_OWNER_MACHINE');
  });

  it('TARGET_REPO_PATH_INVALID when path is missing', async () => {
    await createProject(tracker, 'p1', {
      firstLaunchAckAt: new Date().toISOString(),
    }); // no targetRepoPath
    const r = runner.preflight('p1', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TARGET_REPO_PATH_INVALID');
  });

  it('TARGET_REPO_PATH_INVALID when path exists but is not a git repo', async () => {
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-git-'));
    try {
      await createProject(tracker, 'p1', {
        targetRepoPath: notARepo,
        firstLaunchAckAt: new Date().toISOString(),
      });
      const r = runner.preflight('p1', 0);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('TARGET_REPO_PATH_INVALID');
    } finally {
      SafeFsExecutor.safeRmSync(notARepo, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:not-a-repo-cleanup' });
    }
  });

  it('LOCK_HELD when another live PID holds the lock', async () => {
    // Write a lock file pointing at our own PID (definitely alive).
    const lock = new ProjectRoundLock({ stateDir });
    lock.acquire('other-project', 0);

    await createProject(tracker, 'p1', {
      targetRepoPath: targetRepo,
      firstLaunchAckAt: new Date().toISOString(),
    });
    const r = runner.preflight('p1', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('LOCK_HELD');
      expect(r.currentHolder?.projectId).toBe('other-project');
    }
  });

  it('ITEMS_NOT_ALL_APPROVED when a referenced child id does not resolve', async () => {
    await createProject(tracker, 'p1', {
      targetRepoPath: targetRepo,
      firstLaunchAckAt: new Date().toISOString(),
      rounds: [{ name: 'r0', itemIds: ['missing-child'] }],
    });
    const r = runner.preflight('p1', 0);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('ITEMS_NOT_ALL_APPROVED');
      expect(r.failingItemIds).toEqual(['missing-child']);
    }
  });
});

describe('ProjectRoundRunner.halt', () => {
  let stateDir: string;
  let targetRepo: string;
  let tracker: InitiativeTracker;
  let runner: ProjectRoundRunner;

  beforeEach(() => {
    stateDir = makeStateDir();
    targetRepo = makeGitRepo();
    tracker = new InitiativeTracker(stateDir);
    runner = new ProjectRoundRunner({ tracker, stateDir, machineId: 'machine-A' });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:halt-afterEach-state' }); } catch { /* ignore */ }
    try { SafeFsExecutor.safeRmSync(targetRepo, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:halt-afterEach-repo' }); } catch { /* ignore */ }
  });

  it('halts the first pending round and writes haltReason', async () => {
    await createProject(tracker, 'p1', { targetRepoPath: targetRepo });
    const r = await runner.halt('p1', 'user said stop');
    expect(r).not.toBeNull();
    if (r) {
      expect(r.roundIndex).toBe(0);
      const round = r.project.rounds?.[0];
      expect(round?.haltedAt).toBeDefined();
      expect(round?.haltReason).toBe('user said stop');
      expect(round?.status).toBe('failed');
    }
  });

  it('is idempotent — halting an already-halted round is a no-op', async () => {
    await createProject(tracker, 'p1', { targetRepoPath: targetRepo });
    const first = await runner.halt('p1', 'one');
    const firstHaltAt = first?.project.rounds?.[0]?.haltedAt;
    expect(firstHaltAt).toBeDefined();
    // Second call should not change the haltedAt or haltReason.
    const second = await runner.halt('p1', 'two');
    expect(second?.project.rounds?.[0]?.haltedAt).toBe(firstHaltAt);
    expect(second?.project.rounds?.[0]?.haltReason).toBe('one');
  });

  it('returns null when project does not exist', async () => {
    const r = await runner.halt('nope', 'reason');
    expect(r).toBeNull();
  });

  it('releases the lock if held by the halted round', async () => {
    await createProject(tracker, 'p1', { targetRepoPath: targetRepo });
    const lock = new ProjectRoundLock({ stateDir });
    lock.acquire('p1', 0);
    expect(lock.read()).not.toBeNull();
    await runner.halt('p1', 'release me');
    expect(lock.read()).toBeNull();
  });
});

describe('ProjectRoundRunner.recordAck', () => {
  let stateDir: string;
  let targetRepo: string;
  let tracker: InitiativeTracker;
  let runner: ProjectRoundRunner;

  beforeEach(() => {
    stateDir = makeStateDir();
    targetRepo = makeGitRepo();
    tracker = new InitiativeTracker(stateDir);
    runner = new ProjectRoundRunner({ tracker, stateDir, machineId: 'machine-A' });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:ack-afterEach-state' }); } catch { /* ignore */ }
    try { SafeFsExecutor.safeRmSync(targetRepo, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:ack-afterEach-repo' }); } catch { /* ignore */ }
  });

  it('populates firstLaunchAckAt + lastAckedRoundIndex + resets unackedCount', async () => {
    await createProject(tracker, 'p1', {
      targetRepoPath: targetRepo,
      unacknowledgedAdvanceCount: 2,
    });
    const r = await runner.recordAck('p1', 0);
    expect(r).not.toBeNull();
    expect(r?.firstLaunchAckAt).toBeDefined();
    expect(r?.lastAckedRoundIndex).toBe(0);
    expect(r?.unacknowledgedAdvanceCount).toBe(0);
  });

  it('is idempotent on lastAckedRoundIndex (calling twice with same index is a no-op semantically)', async () => {
    await createProject(tracker, 'p1', { targetRepoPath: targetRepo });
    const a = await runner.recordAck('p1', 1);
    const b = await runner.recordAck('p1', 1);
    expect(a?.lastAckedRoundIndex).toBe(1);
    expect(b?.lastAckedRoundIndex).toBe(1);
  });

  it('never moves lastAckedRoundIndex backwards', async () => {
    await createProject(tracker, 'p1', { targetRepoPath: targetRepo });
    await runner.recordAck('p1', 5);
    const r = await runner.recordAck('p1', 2);
    expect(r?.lastAckedRoundIndex).toBe(5);
  });

  it('returns null when project does not exist', async () => {
    const r = await runner.recordAck('nope', 0);
    expect(r).toBeNull();
  });
});

describe('ProjectRoundRunner.acceptPartial', () => {
  let stateDir: string;
  let targetRepo: string;
  let tracker: InitiativeTracker;
  let runner: ProjectRoundRunner;

  beforeEach(() => {
    stateDir = makeStateDir();
    targetRepo = makeGitRepo();
    tracker = new InitiativeTracker(stateDir);
    runner = new ProjectRoundRunner({ tracker, stateDir, machineId: 'machine-A' });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:partial-afterEach-state' }); } catch { /* ignore */ }
    try { SafeFsExecutor.safeRmSync(targetRepo, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:partial-afterEach-repo' }); } catch { /* ignore */ }
  });

  it('skips non-merged items, marks round complete-with-skips, advances lastAckedRoundIndex', async () => {
    await createProject(tracker, 'p1', {
      targetRepoPath: targetRepo,
      rounds: [{ name: 'r0', itemIds: ['c1', 'c2', 'c3'] }],
    });
    await createChild(tracker, 'c1', 'p1', 'merged');
    await createChild(tracker, 'c2', 'p1', 'building');
    await createChild(tracker, 'c3', 'p1', 'outline');

    const r = await runner.acceptPartial('p1', 0, 'time pressure', 'echo');
    expect(r).not.toBeNull();
    if (r) {
      expect(r.skippedItemIds.sort()).toEqual(['c2', 'c3']);
      const round = r.project.rounds?.[0];
      expect(round?.status).toBe('complete-with-skips');
      expect(r.project.lastAckedRoundIndex).toBe(0);
    }
    expect(tracker.get('c1')?.pipelineStage).toBe('merged');
    expect(tracker.get('c2')?.pipelineStage).toBe('skipped');
    expect(tracker.get('c3')?.pipelineStage).toBe('skipped');
  });

  it('returns null when roundIndex is out of range', async () => {
    await createProject(tracker, 'p1', { targetRepoPath: targetRepo });
    const r = await runner.acceptPartial('p1', 99, 'reason', 'echo');
    expect(r).toBeNull();
  });
});

describe('ProjectRoundRunner.validateChildFrontmatter', () => {
  it('passes for a spec with review-convergence: true AND approved: true', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-check-'));
    try {
      fs.mkdirSync(path.join(repo, 'docs', 'specs'), { recursive: true });
      const spec = `---
title: "X"
review-convergence: true
approved: true
---

body
`;
      fs.writeFileSync(path.join(repo, 'docs', 'specs', 'x.md'), spec);
      const r = ProjectRoundRunner.validateChildFrontmatter(repo, 'docs/specs/x.md');
      expect(r.ok).toBe(true);
    } finally {
      SafeFsExecutor.safeRmSync(repo, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:fm-cleanup' });
    }
  });

  it('rejects when review-convergence is missing', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fm-check-'));
    try {
      fs.mkdirSync(path.join(repo, 'docs', 'specs'), { recursive: true });
      const spec = `---
title: "X"
approved: true
---
`;
      fs.writeFileSync(path.join(repo, 'docs', 'specs', 'x.md'), spec);
      const r = ProjectRoundRunner.validateChildFrontmatter(repo, 'docs/specs/x.md');
      expect(r.ok).toBe(false);
    } finally {
      SafeFsExecutor.safeRmSync(repo, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundRunner.test.ts:fm-missing-cleanup' });
    }
  });

  it('rejects when the spec file is missing', () => {
    const r = ProjectRoundRunner.validateChildFrontmatter('/tmp', 'no-such-spec.md');
    expect(r.ok).toBe(false);
  });
});
