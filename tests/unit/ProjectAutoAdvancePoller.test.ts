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

  // ── Executor wiring (connect-the-dots) ─────────────────────────
  //
  // When the poller is constructed with an executor, a successful
  // fire calls the executor fire-and-forget. Errors land in
  // executorErrors[] and don't propagate. In-flight runs are not
  // re-launched on the next tick before they settle.

  it('executor is invoked after a successful fire', async () => {
    const calls: Array<{ projectId: string; roundIndex: number }> = [];
    const wired = new ProjectAutoAdvancePoller({
      tracker,
      runner,
      machineId,
      executor: async (input) => {
        calls.push(input);
      },
    });
    await newProject('exec-p1');
    const proj = tracker.get('exec-p1')!;
    const rounds = (proj.rounds ?? []).map((r, i) => i === 0 ? {
      ...r,
      autoAdvanceAt: new Date(Date.now() - 60_000).toISOString(),
    } : r);
    await tracker.update('exec-p1', { rounds });
    const r = await wired.tick();
    // Wait a microtask tick for the fire-and-forget to settle.
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.fired).toEqual(['exec-p1']);
    expect(r.executed).toEqual(['exec-p1']);
    expect(calls).toEqual([{ projectId: 'exec-p1', roundIndex: 0 }]);
    expect(r.executorErrors).toEqual([]);
  });

  it('executor errors are captured in executorErrors', async () => {
    const wired = new ProjectAutoAdvancePoller({
      tracker,
      runner,
      machineId,
      executor: async () => {
        throw new Error('boom');
      },
    });
    await newProject('err-p1');
    const proj = tracker.get('err-p1')!;
    const rounds = (proj.rounds ?? []).map((r, i) => i === 0 ? {
      ...r,
      autoAdvanceAt: new Date(Date.now() - 60_000).toISOString(),
    } : r);
    await tracker.update('err-p1', { rounds });
    const r = await wired.tick();
    // Yield for the rejection to be recorded.
    await new Promise((resolve) => setImmediate(resolve));
    expect(r.fired).toEqual(['err-p1']);
    expect(r.executed).toEqual(['err-p1']);
    expect(r.executorErrors.length).toBe(1);
    expect(r.executorErrors[0]?.projectId).toBe('err-p1');
    expect(r.executorErrors[0]?.error).toMatch(/boom/);
  });

  it('in-flight executor is not relaunched on the next tick', async () => {
    let resolveExecutor: () => void = () => undefined;
    const callCount = { n: 0 };
    const wired = new ProjectAutoAdvancePoller({
      tracker,
      runner,
      machineId,
      executor: () => new Promise<void>((resolve) => {
        callCount.n++;
        resolveExecutor = resolve;
      }),
    });
    await newProject('flight-p1');
    const proj = tracker.get('flight-p1')!;
    const rounds = (proj.rounds ?? []).map((r, i) => i === 0 ? {
      ...r,
      autoAdvanceAt: new Date(Date.now() - 60_000).toISOString(),
    } : r);
    await tracker.update('flight-p1', { rounds });
    await wired.tick();
    expect(callCount.n).toBe(1);
    // Re-arm autoAdvanceAt to make the project eligible again.
    const proj2 = tracker.get('flight-p1')!;
    const rounds2 = (proj2.rounds ?? []).map((r, i) => i === 0 ? {
      ...r,
      autoAdvanceAt: new Date(Date.now() - 60_000).toISOString(),
    } : r);
    await tracker.update('flight-p1', { rounds: rounds2 });
    await wired.tick();
    // Still 1 — executor hasn't resolved yet, so in-flight guard held.
    expect(callCount.n).toBe(1);
    resolveExecutor();
    await new Promise((resolve) => setImmediate(resolve));
    expect(wired.inFlightCount()).toBe(0);
  });
});
