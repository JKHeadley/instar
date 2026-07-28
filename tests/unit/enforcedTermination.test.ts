/**
 * Enforced Termination — pure decision-core tests (Tier 1).
 * Covers BOTH sides of every decision boundary in computeOverrun() and the
 * two-phase TerminationConfirmer. Spec: docs/specs/enforced-termination-watchdog.md.
 */
import { describe, it, expect } from 'vitest';
import {
  computeOverrun,
  TerminationConfirmer,
  DEFAULT_ENFORCED_TERMINATION_CONFIG,
  type AutonomousRunSnapshot,
  type EnforcedTerminationConfig,
} from '../../src/monitoring/enforcedTermination.js';

const H = 60 * 60 * 1000; // ms in an hour
const NOW = 1_000_000_000_000; // fixed clock

const cfg: EnforcedTerminationConfig = { ...DEFAULT_ENFORCED_TERMINATION_CONFIG };

function run(over: Partial<AutonomousRunSnapshot>): AutonomousRunSnapshot {
  return {
    topicId: '28744',
    startedAtMs: NOW - 1 * H,
    fileMtimeMs: NOW - 1 * H,
    durationSeconds: 24 * 60 * 60, // 24h budget
    iteration: 1,
    active: true,
    paused: false,
    moveSuspended: false,
    ...over,
  };
}

describe('computeOverrun — eligibility gates', () => {
  it('within budget → null (no overrun)', () => {
    expect(computeOverrun(run({ startedAtMs: NOW - 1 * H }), cfg, NOW)).toBeNull();
  });
  it('inactive run → null even if past budget', () => {
    expect(computeOverrun(run({ active: false, startedAtMs: NOW - 100 * H }), cfg, NOW)).toBeNull();
  });
  it('paused run → null even if past budget', () => {
    expect(computeOverrun(run({ paused: true, startedAtMs: NOW - 100 * H }), cfg, NOW)).toBeNull();
  });
  it('mid-move run → null even if past budget (destination re-evaluates)', () => {
    expect(computeOverrun(run({ moveSuspended: true, startedAtMs: NOW - 100 * H }), cfg, NOW)).toBeNull();
  });
});

describe('computeOverrun — time budget', () => {
  it('exactly at budget but within grace → null', () => {
    // 24h budget, started 24h ago + 60s (under the 120s grace)
    const r = run({ durationSeconds: 24 * 60 * 60, startedAtMs: NOW - (24 * H + 60_000) });
    expect(computeOverrun(r, cfg, NOW)).toBeNull();
  });
  it('past budget + grace → time-budget overrun', () => {
    const r = run({ durationSeconds: 24 * 60 * 60, startedAtMs: NOW - (24 * H + 121_000) });
    const o = computeOverrun(r, cfg, NOW);
    expect(o?.kind).toBe('time-budget');
    if (o?.kind === 'time-budget') expect(o.budgetSeconds).toBe(24 * 60 * 60);
  });
  it('the 46h-on-24h incident (topic 27515) → time-budget overrun', () => {
    const r = run({ durationSeconds: 24 * 60 * 60, startedAtMs: NOW - 46 * H, iteration: 216 });
    expect(computeOverrun(r, cfg, NOW)?.kind).toBe('time-budget');
  });
});

describe('computeOverrun — absolute ceiling (the holes the in-hook check misses)', () => {
  it('UNBOUNDED run (no duration) under ceiling → null', () => {
    const r = run({ durationSeconds: null, startedAtMs: NOW - 10 * H });
    expect(computeOverrun(r, cfg, NOW)).toBeNull();
  });
  it('UNBOUNDED run past the 26h ceiling → absolute-ceiling overrun (started_at clock)', () => {
    const r = run({ durationSeconds: null, startedAtMs: NOW - 27 * H });
    const o = computeOverrun(r, cfg, NOW);
    expect(o?.kind).toBe('absolute-ceiling');
    if (o?.kind === 'absolute-ceiling') expect(o.clock).toBe('started_at');
  });
  it('duration_seconds:0 treated as unbounded → ceiling still applies', () => {
    const r = run({ durationSeconds: 0, startedAtMs: NOW - 27 * H });
    expect(computeOverrun(r, cfg, NOW)?.kind).toBe('absolute-ceiling');
  });
  it('UNPARSEABLE started_at, file mtime older than ceiling → absolute-ceiling (file-mtime clock)', () => {
    const r = run({ startedAtMs: null, durationSeconds: null, fileMtimeMs: NOW - 27 * H });
    const o = computeOverrun(r, cfg, NOW);
    expect(o?.kind).toBe('absolute-ceiling');
    if (o?.kind === 'absolute-ceiling') expect(o.clock).toBe('file-mtime');
  });
  it('UNPARSEABLE started_at but file mtime recent → null (a fresh run with a bad stamp is not killed)', () => {
    const r = run({ startedAtMs: null, durationSeconds: null, fileMtimeMs: NOW - 1 * H });
    expect(computeOverrun(r, cfg, NOW)).toBeNull();
  });
});

describe('computeOverrun — iteration ceiling (opt-in)', () => {
  it('no maxIterations configured → iteration never triggers', () => {
    const r = run({ iteration: 9999, startedAtMs: NOW - 1 * H });
    expect(computeOverrun(r, cfg, NOW)).toBeNull();
  });
  it('iteration >= maxIterations → iteration-ceiling overrun', () => {
    const r = run({ iteration: 500, startedAtMs: NOW - 1 * H });
    const o = computeOverrun(r, { ...cfg, maxIterations: 500 }, NOW);
    expect(o?.kind).toBe('iteration-ceiling');
  });
  it('iteration below maxIterations → null', () => {
    const r = run({ iteration: 499, startedAtMs: NOW - 1 * H });
    expect(computeOverrun(r, { ...cfg, maxIterations: 500 }, NOW)).toBeNull();
  });
});

describe('TerminationConfirmer — two-phase confirm', () => {
  it('a single overrun tick does NOT confirm (absorbs a blip)', () => {
    const c = new TerminationConfirmer();
    expect(c.reconcile(['28744'])).toEqual([]);
    expect(c.pendingTopics()).toEqual(['28744']);
  });
  it('two consecutive overrun ticks → confirmed', () => {
    const c = new TerminationConfirmer();
    c.reconcile(['28744']);
    expect(c.reconcile(['28744'])).toEqual(['28744']);
  });
  it('a topic that drops out between ticks resets its streak (transient overrun never kills)', () => {
    const c = new TerminationConfirmer();
    c.reconcile(['28744']); // tick 1: pending
    expect(c.reconcile([])).toEqual([]); // tick 2: cleared
    expect(c.reconcile(['28744'])).toEqual([]); // tick 3: pending again, not confirmed
    expect(c.reconcile(['28744'])).toEqual(['28744']); // tick 4: confirmed
  });
  it('clear() drops a topic after actuation', () => {
    const c = new TerminationConfirmer();
    c.reconcile(['28744']);
    c.reconcile(['28744']); // confirmed
    c.clear('28744');
    expect(c.pendingTopics()).toEqual([]);
    expect(c.reconcile(['28744'])).toEqual([]); // streak restarted from zero
  });
  it('multiple topics tracked independently', () => {
    const c = new TerminationConfirmer();
    c.reconcile(['a', 'b']);
    const confirmed = c.reconcile(['a', 'b']);
    expect(confirmed.sort()).toEqual(['a', 'b']);
  });
  it('confirmThreshold of 1 confirms immediately (for tests/overrides)', () => {
    const c = new TerminationConfirmer(1);
    expect(c.reconcile(['x'])).toEqual(['x']);
  });
});
