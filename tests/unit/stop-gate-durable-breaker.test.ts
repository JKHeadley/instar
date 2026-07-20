import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { StopGateDb } from '../../src/core/StopGateDb.js';
import { UnjustifiedStopGate, type EvaluateInput } from '../../src/core/UnjustifiedStopGate.js';
import type { IntelligenceProvider } from '../../src/core/types.js';
import { normalizeStopGateBreakerState, stopGateBreakerKey } from '../../src/core/StopGateBreakerState.js';

const INPUT: EvaluateInput = {
  evidenceMetadata: { artifacts: [], signals: {}, sessionStartTs: null },
  untrustedContent: { stopReason: 'done', recentTurns: [] },
};

function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms: number) => { value += ms; } };
}

describe('durable Stop-gate breaker — restart-survival class closure', () => {
  afterEach(() => vi.useRealTimers());

  it('keys only on stable route identity and clamps corrupt durable state', () => {
    const a = stopGateBreakerKey({ defaultFramework: 'claude-code', failureSwap: ['codex-cli'] });
    const same = stopGateBreakerKey({ defaultFramework: 'claude-code', failureSwap: ['codex-cli'] });
    const reordered = stopGateBreakerKey({ defaultFramework: 'claude-code', failureSwap: ['gemini-cli', 'codex-cli'] });
    expect(a).toBe(same);
    expect(a).not.toBe(reordered);
    expect(stopGateBreakerKey({ defaultFramework: 'unknown', failureSwap: ['codex-cli', 'codex-cli', 'unknown'] }))
      .toBe(stopGateBreakerKey({ failureSwap: ['codex-cli'] }));
    const clamped = normalizeStopGateBreakerState({
      breakerKey: a,
      consecutiveFailures: Number.POSITIVE_INFINITY,
      openUntil: Number.MAX_SAFE_INTEGER,
      probeLeaseUntil: Number.MAX_SAFE_INTEGER,
      probeToken: 'x'.repeat(200),
      firstOpenedAt: Number.MAX_SAFE_INTEGER,
      suppressedCount: -4,
      updatedAt: Number.MAX_SAFE_INTEGER,
    }, 1_000, 5_000, 2_500);
    expect(clamped).toMatchObject({
      consecutiveFailures: 0,
      openUntil: 11_000,
      probeLeaseUntil: 8_500,
      probeToken: null,
      suppressedCount: 0,
    });
  });

  it('does not mint a fresh timeout budget across repeated reconstruction', async () => {
    const db = new StopGateDb({ db: new Database(':memory:') });
    const c = clock();
    let calls = 0;
    const provider: IntelligenceProvider = { evaluate: async () => { calls += 1; throw new Error('down'); } };
    const make = () => new UnjustifiedStopGate({
      intelligence: provider,
      breakerThreshold: 3,
      breakerCooldownMs: 60_000,
      breakerStateStore: db,
      breakerKey: 'route-a',
      now: c.now,
    });

    const first = make();
    await first.evaluate(INPUT);
    await first.evaluate(INPUT);
    const opening = await first.evaluate(INPUT);
    expect(opening.ok).toBe(false);
    if (!opening.ok) expect(opening.failure.kind).toBe('breakerOpen');
    expect(calls).toBe(3);

    for (let restart = 0; restart < 5; restart++) {
      const result = await make().evaluate(INPUT);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe('breakerOpen');
    }
    expect(calls).toBe(3);
    expect(db.loadBreakerState('route-a')?.consecutiveFailures).toBe(3);
    db.close();
  });

  it('admits exactly one durable half-open probe across concurrent gate instances', async () => {
    const db = new StopGateDb({ db: new Database(':memory:') });
    const c = clock();
    let calls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const provider: IntelligenceProvider = { evaluate: async () => { calls += 1; await blocked; throw new Error('still down'); } };
    const make = () => new UnjustifiedStopGate({
      intelligence: provider,
      breakerThreshold: 1,
      breakerCooldownMs: 1_000,
      clientTimeoutMs: 10_000,
      breakerStateStore: db,
      breakerKey: 'route-b',
      now: c.now,
    });
    await new UnjustifiedStopGate({
      intelligence: { evaluate: async () => { throw new Error('seed'); } },
      breakerThreshold: 1,
      breakerCooldownMs: 1_000,
      breakerStateStore: db,
      breakerKey: 'route-b',
      now: c.now,
    }).evaluate(INPUT);
    c.advance(1_001);

    const a = make();
    const b = make();
    const inFlight = a.evaluate(INPUT);
    await Promise.resolve();
    const refused = await b.evaluate(INPUT);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.failure.kind).toBe('breakerOpen');
    expect(calls).toBe(1);
    release();
    await inFlight;
    db.close();
  });

  it('counts malformed authority output toward the unusable-authority breaker', async () => {
    const db = new StopGateDb({ db: new Database(':memory:') });
    let calls = 0;
    const provider: IntelligenceProvider = { evaluate: async () => { calls += 1; return 'not-json'; } };
    const gate = new UnjustifiedStopGate({
      intelligence: provider,
      breakerThreshold: 2,
      breakerStateStore: db,
      breakerKey: 'route-c',
    });
    expect((await gate.evaluate(INPUT) as { failure: { kind: string } }).failure.kind).toBe('malformed');
    expect((await gate.evaluate(INPUT) as { failure: { kind: string } }).failure.kind).toBe('breakerOpen');
    expect((await gate.evaluate(INPUT) as { failure: { kind: string } }).failure.kind).toBe('breakerOpen');
    expect(calls).toBe(2);
    db.close();
  });

  it('contains persistence failure and preserves fail-open behavior', async () => {
    let signaled = 0;
    const gate = new UnjustifiedStopGate({
      intelligence: { evaluate: async () => { throw new Error('provider down'); } },
      breakerThreshold: 2,
      breakerStateStore: {
        loadBreakerState: () => { throw new Error('locked'); },
        recordBreakerFailure: () => { throw new Error('locked'); },
        tryAcquireBreakerProbe: () => { throw new Error('locked'); },
        resetBreakerState: () => { throw new Error('locked'); },
        addBreakerSuppressions: () => { throw new Error('locked'); },
      },
      onBreakerPersistenceError: () => { signaled += 1; },
    });
    const result = await gate.evaluate(INPUT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure.kind).toBe('llmUnavailable');
    expect(signaled).toBeGreaterThanOrEqual(2); // hydration + failure transition
  });

  it('coalesces open-breaker suppressions into one durable flush per minute', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const db = new StopGateDb({ db: new Database(':memory:') });
    const gate = new UnjustifiedStopGate({
      intelligence: { evaluate: async () => { throw new Error('provider down'); } },
      breakerThreshold: 1,
      breakerCooldownMs: 120_000,
      breakerStateStore: db,
      breakerKey: 'suppression-accounting',
    });
    await gate.evaluate(INPUT); // opens
    await gate.evaluate(INPUT);
    await gate.evaluate(INPUT);
    await gate.evaluate(INPUT);
    expect(db.loadBreakerState('suppression-accounting')?.suppressedCount).toBe(0);
    expect(gate.breakerState().suppressedCount).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(db.loadBreakerState('suppression-accounting')?.suppressedCount).toBe(3);
    expect(gate.breakerState().suppressedCount).toBe(3);
    db.close();
  });

  it('rejects stale lease settlement after success/reset and after a newer lease', () => {
    const db = new StopGateDb({ db: new Database(':memory:') });
    const key = 'lease-order';
    db.recordBreakerFailure({ breakerKey: key, now: 1_000, threshold: 1, cooldownMs: 100 });
    const first = db.tryAcquireBreakerProbe({ breakerKey: key, now: 1_101, cooldownMs: 100, leaseMs: 50 });
    expect(first.acquired).toBe(true);
    db.resetBreakerState(key, first.token);
    const staleFailure = db.recordBreakerFailure({ breakerKey: key, now: 1_102, threshold: 1, cooldownMs: 100, probeToken: first.token });
    expect(staleFailure.consecutiveFailures).toBe(0);

    db.recordBreakerFailure({ breakerKey: key, now: 1_200, threshold: 1, cooldownMs: 100 });
    const newer = db.tryAcquireBreakerProbe({ breakerKey: key, now: 1_301, cooldownMs: 100, leaseMs: 50 });
    expect(newer.acquired).toBe(true);
    const staleReset = db.resetBreakerState(key, first.token);
    expect(staleReset.probeToken).toBe(newer.token);
    db.close();
  });

  it('expires a crash-stranded probe lease and admits one replacement', () => {
    const db = new StopGateDb({ db: new Database(':memory:') });
    const key = 'crash-lease';
    db.recordBreakerFailure({ breakerKey: key, now: 10_000, threshold: 1, cooldownMs: 100 });
    const first = db.tryAcquireBreakerProbe({ breakerKey: key, now: 10_101, cooldownMs: 100, leaseMs: 50 });
    expect(first.acquired).toBe(true);
    expect(db.tryAcquireBreakerProbe({ breakerKey: key, now: 10_149, cooldownMs: 100, leaseMs: 50 }).acquired).toBe(false);
    const replacement = db.tryAcquireBreakerProbe({ breakerKey: key, now: 10_152, cooldownMs: 100, leaseMs: 50 });
    expect(replacement.acquired).toBe(true);
    expect(replacement.token).not.toBe(first.token);
    db.close();
  });

  it('durably resets after one usable half-open authority verdict', async () => {
    const db = new StopGateDb({ db: new Database(':memory:') });
    const c = clock();
    db.recordBreakerFailure({ breakerKey: 'recovered', now: c.now(), threshold: 1, cooldownMs: 100 });
    c.advance(101);
    const gate = new UnjustifiedStopGate({
      intelligence: { evaluate: async () => JSON.stringify({ decision: 'allow', rule: 'U_LEGIT_COMPLETION', evidence_pointer: {}, rationale: 'complete' }) },
      breakerThreshold: 1,
      breakerCooldownMs: 100,
      breakerStateStore: db,
      breakerKey: 'recovered',
      now: c.now,
    });
    expect((await gate.evaluate(INPUT)).ok).toBe(true);
    expect(db.loadBreakerState('recovered')).toMatchObject({ consecutiveFailures: 0, openUntil: 0, probeToken: null });
    db.close();
  });

  it('retains independent A and B route budgets across A → B → A', () => {
    const db = new StopGateDb({ db: new Database(':memory:') });
    db.recordBreakerFailure({ breakerKey: 'A', now: 1_000, threshold: 1, cooldownMs: 5_000 });
    db.recordBreakerFailure({ breakerKey: 'B', now: 1_001, threshold: 2, cooldownMs: 5_000 });
    expect(db.loadBreakerState('A')).toMatchObject({ consecutiveFailures: 1, openUntil: 6_000 });
    expect(db.loadBreakerState('B')).toMatchObject({ consecutiveFailures: 1, openUntil: 0 });
    db.close();
  });

  it('keeps 1,000 durable transitions below the declared p99 latency budget', () => {
    const db = new StopGateDb({ db: new Database(':memory:') });
    const samples: number[] = [];
    for (let i = 0; i < 1_000; i++) {
      const start = performance.now();
      db.recordBreakerFailure({ breakerKey: `perf-${i % 4}`, now: i + 1, threshold: 10_000, cooldownMs: 5_000 });
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length * 0.99)]).toBeLessThan(10);
    db.close();
  });

  it.each([
    { name: 'backward clock', now: 1_000, updatedAt: 4_000, openUntil: 9_000, expectedOpen: 9_000 },
    { name: 'forward clock', now: 20_000, updatedAt: 4_000, openUntil: 9_000, expectedOpen: 9_000 },
    { name: 'non-finite state', now: 1_000, updatedAt: Number.NaN, openUntil: Number.POSITIVE_INFINITY, expectedOpen: 0 },
  ])('normalizes $name deterministically', ({ now, updatedAt, openUntil, expectedOpen }) => {
    const state = normalizeStopGateBreakerState({
      breakerKey: 'clock', consecutiveFailures: 1, openUntil,
      probeLeaseUntil: openUntil, probeToken: 'token', firstOpenedAt: updatedAt,
      suppressedCount: 1, updatedAt,
    }, now, 5_000, 2_500);
    expect(state.openUntil).toBe(expectedOpen);
    expect(state.probeLeaseUntil).toBeLessThanOrEqual(Math.max(now, state.updatedAt) + 2_500);
  });
});
