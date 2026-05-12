/**
 * Unit tests for ProjectAutoAdvancePoller.
 *
 * Covers:
 *   - Tick on an empty tracker is a no-op
 *   - Project with no autoAdvanceAt is not fired
 *   - Project with autoAdvanceAt in the future is not fired
 *   - Project with autoAdvanceAt elapsed AND preflight ok IS fired
 *   - Owner machine mismatch skips
 *   - unacknowledgedAdvanceCount at cap skips
 *   - Preflight reject (structural) clears autoAdvanceAt
 *   - Preflight reject (transient) leaves autoAdvanceAt in place
 *   - Successful fire bookkeeps: clears autoAdvanceAt + bumps unacked
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { ProjectRoundRunner } from '../../src/core/ProjectRoundRunner.js';
import { ProjectAutoAdvancePoller } from '../../src/core/ProjectAutoAdvancePoller.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'poller-'));
}
function makeGitRepo(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'poller-target-'));
  SafeGitExecutor.run(['init', '-q'], { cwd: d, operation: 'tests/unit/ProjectAutoAdvancePoller.test.ts:makeGitRepo' });
  return d;
}

describe('ProjectAutoAdvancePoller', () => {
  let stateDir: string;
  let targetRepo: string;
  let tracker: InitiativeTracker;
  let runner: ProjectRoundRunner;
  let poller: ProjectAutoAdvancePoller;
  const machineId = 'm-test';

  beforeEach(() => {
    stateDir = makeStateDir();
    targetRepo = makeGitRepo();
    tracker = new InitiativeTracker(stateDir);
    runner = new ProjectRoundRunner({ tracker, stateDir, machineId });
    poller = new ProjectAutoAdvancePoller({ tracker, runner, machineId });
  });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/ProjectAutoAdvancePoller.test.ts:afterEach-state' }); } catch { /* ignore */ }
    try { SafeFsExecutor.safeRmSync(targetRepo, { recursive: true, force: true, operation: 'tests/unit/ProjectAutoAdvancePoller.test.ts:afterEach-repo' }); } catch { /* ignore */ }
  });

  async function newProject(id: string, ack = true): Promise<void> {
    await tracker.create({
      id,
      title: `Project ${id}`,
      description: 'fixture',
      phases: [{ id: 'overview', name: 'overview' }],
      kind: 'project',
      rounds: [{ name: 'r0', itemIds: [] }],
      targetRepoPath: targetRepo,
    });
    if (ack) {
      await tracker.update(id, { firstLaunchAckAt: new Date().toISOString() });
    }
  }

  it('empty tracker → no fires', async () => {
    const r = await poller.tick();
    expect(r.scanned).toBe(0);
    expect(r.fired).toEqual([]);
  });

  it('project without autoAdvanceAt is not fired', async () => {
    await newProject('p1');
    const r = await poller.tick();
    expect(r.scanned).toBe(1);
    expect(r.fired).toEqual([]);
  });

  it('project with autoAdvanceAt in the future is not fired', async () => {
    await newProject('p1');
    const proj = tracker.get('p1')!;
    const rounds = (proj.rounds ?? []).map((r, i) => i === 0 ? {
      ...r,
      autoAdvanceAt: new Date(Date.now() + 60_000).toISOString(),
    } : r);
    await tracker.update('p1', { rounds });
    const r = await poller.tick();
    expect(r.fired).toEqual([]);
  });

  it('project with autoAdvanceAt elapsed AND preflight ok fires and bookkeeps', async () => {
    await newProject('p1');
    const proj = tracker.get('p1')!;
    const rounds = (proj.rounds ?? []).map((r, i) => i === 0 ? {
      ...r,
      autoAdvanceAt: new Date(Date.now() - 60_000).toISOString(),
    } : r);
    await tracker.update('p1', { rounds });
    const r = await poller.tick();
    expect(r.fired).toEqual(['p1']);
    const after = tracker.get('p1')!;
    expect(after.rounds![0].autoAdvanceAt).toBeUndefined();
    expect(after.unacknowledgedAdvanceCount).toBe(1);
  });

  it('owner machine mismatch is skipped silently', async () => {
    await newProject('p1');
    const proj = tracker.get('p1')!;
    const rounds = (proj.rounds ?? []).map((r, i) => i === 0 ? {
      ...r,
      autoAdvanceAt: new Date(Date.now() - 60_000).toISOString(),
    } : r);
    await tracker.update('p1', { rounds, ownerMachineId: 'other-machine' });
    const r = await poller.tick();
    expect(r.fired).toEqual([]);
    expect(r.rejected).toEqual([]);
    // Timestamp left in place — it's not the local machine's job.
    expect(tracker.get('p1')!.rounds![0].autoAdvanceAt).toBeDefined();
  });

  it('unacknowledgedAdvanceCount at cap skips', async () => {
    await newProject('p1');
    const proj = tracker.get('p1')!;
    const rounds = (proj.rounds ?? []).map((r, i) => i === 0 ? {
      ...r,
      autoAdvanceAt: new Date(Date.now() - 60_000).toISOString(),
    } : r);
    await tracker.update('p1', { rounds, unacknowledgedAdvanceCount: 2 });
    const r = await poller.tick();
    expect(r.fired).toEqual([]);
  });

  it('preflight reject with FIRST_LAUNCH_ACK_REQUIRED clears autoAdvanceAt', async () => {
    await newProject('p1', /* ack */ false);
    const proj = tracker.get('p1')!;
    const rounds = (proj.rounds ?? []).map((r, i) => i === 0 ? {
      ...r,
      autoAdvanceAt: new Date(Date.now() - 60_000).toISOString(),
    } : r);
    await tracker.update('p1', { rounds });
    const r = await poller.tick();
    expect(r.fired).toEqual([]);
    expect(r.rejected[0]?.code).toBe('FIRST_LAUNCH_ACK_REQUIRED');
    expect(r.cleared).toContain('p1');
    expect(tracker.get('p1')!.rounds![0].autoAdvanceAt).toBeUndefined();
  });
});
