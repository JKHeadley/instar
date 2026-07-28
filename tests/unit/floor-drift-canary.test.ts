/**
 * Tier-1 tests for FloorDriftCanary (green-pr-automerge R8, round-6 per-family
 * references + round-7 newest-qualifying-wins). Both sides: ok / floor-drift /
 * floor-drift-unverifiable, PR-family vs push-family references, and the
 * skip-ci-HEAD case that motivated the per-family design.
 */

import { describe, it, expect } from 'vitest';
import {
  FloorDriftCanary,
  pinSatisfiedAt,
  qualifiesAsPushReference,
  qualifiesAsPrReference,
  type FloorPin,
  type ReferenceCandidate,
  type FloorDriftDeps,
} from '../../src/monitoring/floorDriftCanary.js';

const eli16Pin: FloorPin = { context: 'eli16', workflowPath: '.github/workflows/eli16-pr-gate.yml', appSlug: 'github-actions', trigger: 'pull_request' };
const ciPin: FloorPin = { context: 'E2E Tests', workflowPath: '.github/workflows/ci.yml', appSlug: 'github-actions', trigger: 'push' };

const run = (over: Partial<ReferenceCandidate['checkRuns'][number]> = {}) => ({ name: 'eli16', conclusion: 'success', appSlug: 'github-actions', workflowPath: '.github/workflows/eli16-pr-gate.yml', ...over });

function deps(over: Partial<{ pr: ReferenceCandidate[]; push: ReferenceCandidate[] }>): FloorDriftDeps {
  return {
    recentMergedPrRefs: async () => over.pr ?? [],
    recentDefaultBranchRefs: async () => over.push ?? [],
  };
}
const cfg = { floorDriftLookbackPrs: 10, floorDriftLookbackCommits: 30 };

describe('pinSatisfiedAt', () => {
  it('requires name + success + producer match', () => {
    expect(pinSatisfiedAt(eli16Pin, { sha: 'x', checkRuns: [run()] })).toBe(true);
    expect(pinSatisfiedAt(eli16Pin, { sha: 'x', checkRuns: [run({ workflowPath: '.github/workflows/evil.yml' })] })).toBe(false);
    expect(pinSatisfiedAt(eli16Pin, { sha: 'x', checkRuns: [run({ conclusion: 'failure' })] })).toBe(false);
  });
});

describe('reference qualification', () => {
  it('a skip-ci default-branch commit (no runs) does NOT qualify as a push reference', () => {
    expect(qualifiesAsPushReference({ sha: 'skipci', checkRuns: [] })).toBe(false);
  });
  it('a commit with completed runs qualifies', () => {
    expect(qualifiesAsPushReference({ sha: 'x', checkRuns: [{ name: 'Build', conclusion: 'success', appSlug: 'github-actions', workflowPath: '.github/workflows/ci.yml' }] })).toBe(true);
  });
  it('a PR head with any completed runs qualifies as a PR reference', () => {
    expect(qualifiesAsPrReference({ sha: 'x', checkRuns: [run()] })).toBe(true);
  });
});

describe('FloorDriftCanary.check', () => {
  it('PR-family pin satisfied at the newest merged PR head → ok', async () => {
    const c = new FloorDriftCanary([eli16Pin], deps({ pr: [{ sha: 'head1', checkRuns: [run()] }] }), cfg);
    const r = await c.check();
    expect(r.findings[0].cls).toBe('ok');
  });

  it('PR-family pin renamed → floor-drift at the newest qualifying reference', async () => {
    // Newest PR head ran the gate under a NEW name; the old pinned name is absent.
    const c = new FloorDriftCanary([eli16Pin], deps({ pr: [{ sha: 'head1', checkRuns: [run({ name: 'eli16-v2' })] }] }), cfg);
    const r = await c.check();
    expect(r.findings[0].cls).toBe('floor-drift');
    expect(r.drifted.length).toBe(1);
  });

  it('newest-qualifying-wins: a rename on the newest head drifts even if older heads satisfy', async () => {
    const c = new FloorDriftCanary([eli16Pin], deps({ pr: [
      { sha: 'newest', checkRuns: [run({ name: 'eli16-renamed' })] },
      { sha: 'older', checkRuns: [run()] }, // still satisfies the old name
    ] }), cfg);
    const r = await c.check();
    expect(r.findings[0].cls).toBe('floor-drift');
  });

  it('no qualifying PR reference within bound → floor-drift-unverifiable, never floor-drift', async () => {
    const c = new FloorDriftCanary([eli16Pin], deps({ pr: [{ sha: 'empty', checkRuns: [] }] }), cfg);
    const r = await c.check();
    expect(r.findings[0].cls).toBe('floor-drift-unverifiable');
    expect(r.drifted.length).toBe(0);
  });

  it('push-family validates against the newest QUALIFYING default-branch commit, skipping skip-ci HEAD', async () => {
    const c = new FloorDriftCanary([ciPin], deps({ push: [
      { sha: 'skipci-head', checkRuns: [] }, // release commit, no runs → skipped
      { sha: 'real', checkRuns: [{ name: 'E2E Tests', conclusion: 'success', appSlug: 'github-actions', workflowPath: '.github/workflows/ci.yml' }] },
    ] }), cfg);
    const r = await c.check();
    expect(r.findings[0].cls).toBe('ok');
  });
});
