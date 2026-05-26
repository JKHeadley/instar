/**
 * FeatureRolloutReconciler — auto-registration logic against a real
 * InitiativeTracker (tmp dir), with injected spec/flag observation. Covers:
 * pipelineStage derivation, bounded backfill, idempotency + OCC, rollout
 * stage advance, archive-at-default-on (reopenable), regression, rename.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  FeatureRolloutReconciler,
  derivePipelineStage,
  type SpecArtifact,
  type ReconcilerDeps,
} from '../../src/core/FeatureRolloutReconciler.js';
import type { RolloutFlagObservation } from '../../src/core/featureRollout.js';

let tmpDir: string;
let tracker: InitiativeTracker;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rollout-reconciler-'));
  tracker = new InitiativeTracker(tmpDir);
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/feature-rollout-reconciler.test.ts' });
});

function art(over: Partial<SpecArtifact>): SpecArtifact {
  return {
    id: 'feat-x', specPath: 'docs/specs/FEAT-X.md', title: 'Feat X',
    approved: true, reviewConverged: true, shipsStaged: false,
    traceExists: false, merged: false, mergedRecently: false,
    ...over,
  };
}

function makeReconciler(specs: SpecArtifact[], flag: RolloutFlagObservation = {}): FeatureRolloutReconciler {
  const deps: ReconcilerDeps = {
    tracker,
    listSpecArtifacts: () => specs,
    observeFlag: () => flag,
  };
  return new FeatureRolloutReconciler(deps);
}

describe('derivePipelineStage', () => {
  it('maps artifact state to the dev stage', () => {
    expect(derivePipelineStage(art({ approved: false, reviewConverged: false }))).toBe('spec-drafted');
    expect(derivePipelineStage(art({ approved: false, reviewConverged: true }))).toBe('spec-converged');
    expect(derivePipelineStage(art({ approved: true }))).toBe('approved');
    expect(derivePipelineStage(art({ approved: true, traceExists: true }))).toBe('building');
    expect(derivePipelineStage(art({ merged: true }))).toBe('merged');
    expect(derivePipelineStage(art({ abandoned: true }))).toBe('skipped');
  });
});

describe('FeatureRolloutReconciler', () => {
  it('auto-creates a task at the right pipelineStage (dogfood: a spec appears on its own)', async () => {
    await makeReconciler([art({ approved: true, traceExists: true, prNumber: 42 })]).reconcile();
    const got = tracker.get('feat-x')!;
    expect(got).toBeDefined();
    expect(got.kind).toBe('task');
    expect(got.pipelineStage).toBe('building');
    expect(got.specPath).toBe('docs/specs/FEAT-X.md');
  });

  it('is idempotent — a second pass does not duplicate or churn', async () => {
    const specs = [art({ approved: true, traceExists: true })];
    await makeReconciler(specs).reconcile();
    const v1 = tracker.get('feat-x')!.version;
    const summary = await makeReconciler(specs).reconcile();
    expect(tracker.list().filter(i => i.id === 'feat-x')).toHaveLength(1);
    expect(summary.unchanged).toContain('feat-x');
    expect(tracker.get('feat-x')!.version).toBe(v1); // no churn write
  });

  it('bounded backfill: a historical merged spec (not recent, no rollout) registers ARCHIVED', async () => {
    await makeReconciler([art({ merged: true, mergedRecently: false })]).reconcile();
    expect(tracker.get('feat-x')!.status).toBe('archived');
  });

  it('a recently-merged spec stays active', async () => {
    await makeReconciler([art({ merged: true, mergedRecently: true })]).reconcile();
    expect(tracker.get('feat-x')!.status).toBe('active');
  });

  it('ships-staged + merged + flag dry-run → active rollout track at dry-run', async () => {
    const specs = [art({ merged: true, shipsStaged: true, flagPath: 'monitoring.featX' })];
    await makeReconciler(specs, { flagEnabled: true, flagDryRun: true }).reconcile();
    const got = tracker.get('feat-x')!;
    expect(got.status).toBe('active');
    expect(got.rollout?.stage).toBe('dry-run');
    expect(got.phases.find(p => p.id === 'dry-run')?.status).toBe('in-progress');
  });

  it('advances dry-run → live when the observed flag flips', async () => {
    const specs = [art({ merged: true, shipsStaged: true, flagPath: 'monitoring.featX' })];
    await makeReconciler(specs, { flagEnabled: true, flagDryRun: true }).reconcile();
    await makeReconciler(specs, { flagEnabled: true, flagDryRun: false }).reconcile();
    const got = tracker.get('feat-x')!;
    expect(got.rollout?.stage).toBe('live');
    expect(got.phases.find(p => p.id === 'dry-run')?.status).toBe('done');
    expect(got.phases.find(p => p.id === 'live')?.status).toBe('in-progress');
  });

  it('default-on ARCHIVES (reopenable) and never marks all phases done', async () => {
    const specs = [art({ merged: true, shipsStaged: true, flagPath: 'monitoring.featX' })];
    await makeReconciler(specs, { defaultEnabled: true }).reconcile();
    const got = tracker.get('feat-x')!;
    expect(got.status).toBe('archived');
    expect(got.phases.every(p => p.status === 'done')).toBe(false); // not sealed
  });

  it('detects a regression (default-on → live) and reactivates with pipelineStage regressed', async () => {
    const specs = [art({ merged: true, shipsStaged: true, flagPath: 'monitoring.featX' })];
    await makeReconciler(specs, { defaultEnabled: true }).reconcile();
    const summary = await makeReconciler(specs, { flagEnabled: true, flagDryRun: false }).reconcile();
    const got = tracker.get('feat-x')!;
    expect(summary.regressed).toContain('feat-x');
    expect(got.pipelineStage).toBe('regressed');
    expect(got.status).toBe('active');
    expect(got.rollout?.stage).toBe('live');
  });

  it('rename: a spec keeps its record (matched by specPath) when its id would differ', async () => {
    await makeReconciler([art({ id: 'feat-x', specPath: 'docs/specs/FEAT-X.md', approved: true })]).reconcile();
    // Same specPath, different derived id (e.g. title-based slug drift) → updates existing, no dup.
    await makeReconciler([art({ id: 'feat-x-renamed', specPath: 'docs/specs/FEAT-X.md', approved: true, traceExists: true })]).reconcile();
    expect(tracker.get('feat-x')).toBeDefined();
    expect(tracker.get('feat-x-renamed')).toBeUndefined();
    expect(tracker.get('feat-x')!.pipelineStage).toBe('building');
  });
});
