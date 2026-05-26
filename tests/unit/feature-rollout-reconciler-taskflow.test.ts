/**
 * FeatureRolloutReconciler on the TaskFlow-enabled (PRODUCTION) path. The
 * review caught that `status:'archived'` maps to TaskFlow's TERMINAL `cancelled`
 * state — sealing a default-on track against a later regression. The fix parks
 * default-on tracks as 'paused' (non-terminal). This test exercises the real
 * TaskFlow store and asserts the reopen actually persists — it would FAIL on the
 * pre-fix 'archived' code.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { TaskFlowStore } from '../../src/tasks/task-flow-registry.store.sqlite.js';
import { TaskFlowRegistry } from '../../src/tasks/TaskFlowRegistry.js';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { FeatureRolloutReconciler, type SpecArtifact } from '../../src/core/FeatureRolloutReconciler.js';
import type { RolloutFlagObservation } from '../../src/core/featureRollout.js';

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

async function taskFlowTracker(): Promise<InitiativeTracker> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-tf-'));
  const store = new TaskFlowStore({ dbPath: path.join(dir, 'task-flows.db') });
  await store.open();
  const tracker = new InitiativeTracker(dir);
  tracker.setTaskFlowRegistry(new TaskFlowRegistry({ store }), 'test-instance-1');
  cleanups.push(() => { store.close(); SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/feature-rollout-reconciler-taskflow.test.ts' }); });
  return tracker;
}

const shipsStaged: SpecArtifact = {
  id: 'feat-x', specPath: 'docs/specs/FEAT-X.md', title: 'Feat X',
  approved: true, reviewConverged: true, shipsStaged: true,
  flagPath: 'monitoring.featX', traceExists: true, merged: true, mergedRecently: true,
};

function reconciler(tracker: InitiativeTracker, flag: RolloutFlagObservation): FeatureRolloutReconciler {
  return new FeatureRolloutReconciler({ tracker, listSpecArtifacts: () => [shipsStaged], observeFlag: () => flag });
}

describe('FeatureRolloutReconciler × TaskFlow (production path)', () => {
  it('a default-on track is parked (paused, non-terminal) and REOPENS on regression', async () => {
    const tracker = await taskFlowTracker();
    // Reach default-on (shipped default enabled).
    await reconciler(tracker, { defaultEnabled: true }).reconcile();
    let got = tracker.get('feat-x')!;
    expect(got.status).toBe('paused');
    expect(got.rollout?.stage).toBe('default-on');

    // Revert: shipped default off, feature now only live in this agent's config.
    const summary = await reconciler(tracker, { flagEnabled: true, flagDryRun: false }).reconcile();
    got = tracker.get('feat-x')!;
    // THE assertion that fails on the pre-fix 'archived'→terminal-cancelled code:
    expect(summary.regressed).toContain('feat-x');
    expect(got.status).toBe('active');         // reopened — not sealed
    expect(got.pipelineStage).toBe('regressed');
    expect(got.rollout?.stage).toBe('live');
  });

  it('dry-run → live advance persists through TaskFlow', async () => {
    const tracker = await taskFlowTracker();
    await reconciler(tracker, { flagEnabled: true, flagDryRun: true }).reconcile();
    expect(tracker.get('feat-x')!.rollout?.stage).toBe('dry-run');
    await reconciler(tracker, { flagEnabled: true, flagDryRun: false }).reconcile();
    expect(tracker.get('feat-x')!.rollout?.stage).toBe('live');
    expect(tracker.get('feat-x')!.status).toBe('active');
  });
});
