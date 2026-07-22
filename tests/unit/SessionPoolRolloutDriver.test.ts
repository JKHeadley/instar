import { describe, it, expect } from 'vitest';
import { SessionPoolRolloutDriver } from '../../src/core/SessionPoolRolloutDriver.js';
import { StageAdvancer, type SessionPoolStage } from '../../src/core/StageAdvancer.js';
import type { SessionPoolE2EResultStore, StageE2EResult } from '../../src/core/SessionPoolE2EResultStore.js';

const SHA = 'commit-abc';

/** A minimal in-memory result store: the only two methods StageAdvancer calls. */
function fakeStore(rows: Partial<Record<number, StageE2EResult>>): SessionPoolE2EResultStore {
  return {
    getLatestForStage: (idx: number) => rows[idx] ?? null,
    // A row present in the map is considered signature-valid for the test.
    verify: (row: StageE2EResult) => !!row,
  } as unknown as SessionPoolE2EResultStore;
}

function row(stage: number, result: 'green' | 'red', commitSha = SHA): StageE2EResult {
  return { stage, result, commitSha, ranAt: '2026-07-22T00:00:00Z', evidenceRef: `ref-${stage}`, signature: 'sig' } as StageE2EResult;
}

/** Build a driver over a REAL StageAdvancer with an in-memory stage var. */
function harness(opts: {
  initialStage: SessionPoolStage;
  results: Partial<Record<number, StageE2EResult>>;
  enabled: boolean;
  ceiling?: SessionPoolStage;
}) {
  let stage = opts.initialStage;
  const advancer = new StageAdvancer({
    resultStore: fakeStore(opts.results),
    currentCommitSha: () => SHA,
    readStage: () => stage,
    writeStageConfig: (s) => { stage = s; },
  });
  const driver = new SessionPoolRolloutDriver({
    advancer,
    enabled: () => opts.enabled,
    targetCeiling: () => opts.ceiling ?? 'dark',
  });
  return { driver, getStage: () => stage };
}

describe('SessionPoolRolloutDriver', () => {
  it('is a strict no-op when disabled — no reconcile, no advance', () => {
    const { driver, getStage } = harness({
      initialStage: 'shadow',
      results: { 1: row(1, 'green') }, // a green that WOULD promote if enabled
      enabled: false,
      ceiling: 'live-transfer',
    });
    const r = driver.tick();
    expect(r.ran).toBe(false);
    expect(r.advancedTo).toBeNull();
    expect(getStage()).toBe('shadow'); // untouched
  });

  it('advances one stage when the prior-stage E2E is green and below the ceiling', () => {
    const { driver, getStage } = harness({
      initialStage: 'shadow',
      results: { 1: row(1, 'green') }, // green for stage 'shadow' (idx 1) gates advance to 'live-transfer' (idx 2)
      enabled: true,
      ceiling: 'live-transfer',
    });
    const r = driver.tick();
    expect(r.ran).toBe(true);
    expect(r.advancedTo).toBe('live-transfer');
    expect(r.advanceSkippedReason).toBeNull();
    expect(getStage()).toBe('live-transfer');
  });

  it('refuses to advance when no green E2E exists (gate not passed)', () => {
    const { driver, getStage } = harness({
      initialStage: 'shadow',
      results: {}, // no results at all
      enabled: true,
      ceiling: 'live-transfer',
    });
    const r = driver.tick();
    expect(r.ran).toBe(true);
    expect(r.advancedTo).toBeNull();
    expect(r.advanceSkippedReason).toBe('e2e-gate-not-passed');
    expect(getStage()).toBe('shadow'); // stays put — the gate held
  });

  it('never advances past the operator ceiling even with a green E2E', () => {
    const { driver, getStage } = harness({
      initialStage: 'shadow',
      results: { 1: row(1, 'green') },
      enabled: true,
      ceiling: 'shadow', // ceiling == current
    });
    const r = driver.tick();
    expect(r.ran).toBe(true);
    expect(r.advancedTo).toBeNull();
    expect(r.advanceSkippedReason).toBe('at-ceiling');
    expect(getStage()).toBe('shadow');
  });

  it('default ceiling "dark" means enabled-but-no-advance (safety default)', () => {
    const { driver, getStage } = harness({
      initialStage: 'dark',
      results: { 0: row(0, 'green') },
      enabled: true,
      // no ceiling ⇒ defaults to 'dark'
    });
    const r = driver.tick();
    expect(r.ran).toBe(true);
    expect(r.advancedTo).toBeNull();
    expect(r.advanceSkippedReason).toBe('at-ceiling');
    expect(getStage()).toBe('dark');
  });

  it('reconciles FIRST: a red regression on the current stage reverts before any advance', () => {
    const { driver, getStage } = harness({
      initialStage: 'live-transfer',
      // current stage 'live-transfer' (idx 2) recorded RED for this commit → must revert to 'shadow'.
      // No green for 'shadow' (idx 1) so it cannot immediately re-advance.
      results: { 2: row(2, 'red') },
      enabled: true,
      ceiling: 'live-transfer',
    });
    const r = driver.tick();
    expect(r.ran).toBe(true);
    expect(r.reconciledTo).toBe('shadow');            // reverted
    expect(r.advancedTo).toBeNull();                  // did not bounce straight back up
    expect(r.advanceSkippedReason).toBe('e2e-gate-not-passed');
    expect(getStage()).toBe('shadow');
  });

  it('a stale red from a PRIOR commit is not a regression — no revert', () => {
    const { driver, getStage } = harness({
      initialStage: 'live-transfer',
      results: { 2: row(2, 'red', 'old-commit') }, // red but for a different commit
      enabled: true,
      ceiling: 'live-transfer',
    });
    const r = driver.tick();
    expect(r.reconciledTo).toBe('live-transfer'); // unchanged
    expect(getStage()).toBe('live-transfer');
  });
});
