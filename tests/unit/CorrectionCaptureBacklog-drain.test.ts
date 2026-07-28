/**
 * Unit + wiring-integrity — the capture→backlog→drain semantics in
 * CorrectionCaptureLoop (the resilience extension).
 *
 *   - isCapacityThrow: classifies the four capacity shapes (daily-cap, reserve,
 *     LlmAbortedError, breaker-open) as backloggable; a genuine fault is not.
 *   - captureAndDistill: a CAPACITY distill throw → 'distill-backlogged' (entry
 *     persisted, ONLY pre-scrubbed text). A NON-capacity throw → 'distill-dropped'
 *     (no entry). No backlog wired → old 'distill-dropped'. Fire-and-forget holds.
 *   - drainBacklog: SKIPPED while the breaker is open (no claim, no distill).
 *     When available, distills each entry → ledger, markDistilled on success,
 *     bumpAttempt on failure. Off-hot-path (returns a result; never throws).
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  captureAndDistill,
  drainBacklog,
  isCapacityThrow,
  CaptureRing,
} from '../../src/monitoring/CorrectionCaptureLoop.js';
import { CorrectionCaptureBacklog } from '../../src/monitoring/CorrectionCaptureBacklog.js';
import { CorrectionLedger } from '../../src/monitoring/CorrectionLedger.js';
import { LlmAbortedError } from '../../src/monitoring/LlmQueue.js';
import { LlmCircuitOpenError } from '../../src/core/LlmCircuitBreaker.js';

function freshRing() {
  return new CaptureRing({ captureContextTurns: 6, captureTopicMapMax: 10, topicTtlMs: 600_000 });
}

describe('isCapacityThrow', () => {
  it('classifies the four capacity shapes as backloggable', () => {
    expect(isCapacityThrow(new Error('LLM daily spend cap exceeded'))).toBe(true);
    expect(isCapacityThrow(new Error('LLM background lane would breach interactive reserve'))).toBe(true);
    expect(isCapacityThrow(new LlmAbortedError())).toBe(true);
    expect(isCapacityThrow(new LlmCircuitOpenError(15_000))).toBe(true);
    expect(isCapacityThrow(new Error('429 Too Many Requests'))).toBe(true);
    expect(isCapacityThrow(new Error('quota exceeded'))).toBe(true);
  });
  it('does NOT classify a genuine fault as capacity (it drops, preserving old behavior)', () => {
    expect(isCapacityThrow(new Error('JSON parse error'))).toBe(false);
    expect(isCapacityThrow(new Error('ECONNREFUSED'))).toBe(false);
    expect(isCapacityThrow(null)).toBe(false);
    expect(isCapacityThrow(undefined)).toBe(false);
  });
});

describe('captureAndDistill — capacity throw routes to the backlog', () => {
  let ledger: CorrectionLedger | null = null;
  let backlog: CorrectionCaptureBacklog | null = null;
  afterEach(() => { ledger?.close(); backlog?.close(); ledger = null; backlog = null; });

  it('a CAPACITY distill throw enqueues the pre-scrubbed capture and returns distill-backlogged', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    const decision = await captureAndDistill(
      {
        ring: freshRing(),
        ledger,
        backlog,
        distill: async () => { throw new Error('LLM daily spend cap exceeded'); },
      },
      { topicId: 42, text: 'from now on lead with the action', fromUser: true, deterministicWeight: 3, isLearningSignal: true },
    );
    expect(decision).toBe('distill-backlogged');
    expect(backlog.count()).toBe(1);
  });

  it('only pre-scrubbed turn text lands in the backlog (a secret is scrubbed)', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    await captureAndDistill(
      {
        ring: freshRing(),
        ledger,
        backlog,
        distill: async () => { throw new LlmCircuitOpenError(15_000); },
      },
      { topicId: 1, text: `my token ${secret} stop asking`, fromUser: true, deterministicWeight: 3, isLearningSignal: true },
    );
    const [entry] = backlog.claimBatch(10);
    const text = entry.turns.map((t) => t.text).join(' ');
    expect(text).not.toContain(secret);
  });

  it('a NON-capacity distill throw drops (no backlog entry)', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    const decision = await captureAndDistill(
      {
        ring: freshRing(),
        ledger,
        backlog,
        distill: async () => { throw new Error('malformed provider output'); },
      },
      { topicId: 1, text: 'x', fromUser: true, deterministicWeight: 3, isLearningSignal: true },
    );
    expect(decision).toBe('distill-dropped');
    expect(backlog.count()).toBe(0);
  });

  it('no backlog wired → capacity throw still drops (old behavior preserved)', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const decision = await captureAndDistill(
      {
        ring: freshRing(),
        ledger,
        backlog: null,
        distill: async () => { throw new Error('LLM daily spend cap exceeded'); },
      },
      { topicId: 1, text: 'x', fromUser: true, deterministicWeight: 3, isLearningSignal: true },
    );
    expect(decision).toBe('distill-dropped');
  });

  it('a backlog enqueue fault falls back to the old drop (never throws into the seam)', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    const throwingBacklog = { enqueue: () => { throw new Error('disk full'); } } as unknown as CorrectionCaptureBacklog;
    const promise = captureAndDistill(
      {
        ring: freshRing(),
        ledger,
        backlog: throwingBacklog,
        distill: async () => { throw new Error('429 rate limit'); },
      },
      { topicId: 1, text: 'x', fromUser: true, deterministicWeight: 3, isLearningSignal: true },
    );
    await expect(promise).resolves.toBe('distill-dropped');
  });
});

describe('drainBacklog — off-hot-path, breaker-gated retry', () => {
  let ledger: CorrectionLedger | null = null;
  let backlog: CorrectionCaptureBacklog | null = null;
  afterEach(() => { ledger?.close(); backlog?.close(); ledger = null; backlog = null; });

  function seedOne() {
    backlog!.enqueue({ topicId: 7, turns: [{ fromUser: true, text: 'lead with the action', at: 0 }], deterministicWeight: 3 });
  }

  it('is SKIPPED while the breaker is open — no claim, no distill', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    seedOne();
    const distill = vi.fn(async () => '{}');
    const result = await drainBacklog(
      { backlog, ledger, distill, llmAvailable: () => false },
      5,
    );
    expect(result.skipped).toBe('breaker-open');
    expect(distill).not.toHaveBeenCalled();
    expect(backlog.count()).toBe(1); // entry untouched
  });

  it('drains a backlogged capture into the ledger when the LLM is available, then deletes the row', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    seedOne();
    const distill = vi.fn(async () =>
      JSON.stringify({ learning: 'lead with the action', kind: 'user-preference', llm_confidence: 0.9, scrubbed_summary: 'lead with the action' }),
    );
    const result = await drainBacklog(
      { backlog, ledger, distill, llmAvailable: () => true },
      5,
    );
    expect(result.recorded).toBe(1);
    expect(backlog.count()).toBe(0);     // distilled → deleted
    expect(ledger.countRecords()).toBe(1);
  });

  it('a failed drain distill bumps the attempt (entry retained until exhausted)', async () => {
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:', maxRetries: 3, minRetryGapMs: 0 });
    seedOne();
    const distill = vi.fn(async () => { throw new Error('LLM daily spend cap exceeded'); });
    const result = await drainBacklog(
      { backlog, ledger, distill, llmAvailable: () => true },
      5,
    );
    expect(result.failed).toBe(1);
    expect(result.dropped).toBe(0);
    expect(backlog.count()).toBe(1); // retained
  });

  it('off-hot-path + fail-open: never throws even if the ledger record path faults', async () => {
    backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:' });
    seedOne();
    const brokenLedger = { record: () => { throw new Error('ledger boom'); } } as unknown as CorrectionLedger;
    const distill = async () =>
      JSON.stringify({ learning: 'x', kind: 'user-preference', llm_confidence: 1, scrubbed_summary: 's' });
    const promise = drainBacklog(
      { backlog, ledger: brokenLedger, distill, llmAvailable: () => true },
      5,
    );
    await expect(promise).resolves.toBeDefined();
  });

  it('prunes expired entries before draining (TTL bound)', async () => {
    let clock = 100_000;
    ledger = new CorrectionLedger({ dbPath: ':memory:', machineId: 't' });
    backlog = new CorrectionCaptureBacklog({ dbPath: ':memory:', now: () => clock });
    backlog.enqueue({ topicId: 1, turns: [{ fromUser: true, text: 'stale', at: 0 }], deterministicWeight: 1, capturedAt: 1_000 });
    const distill = vi.fn(async () => '{}');
    const result = await drainBacklog(
      { backlog, ledger, distill, llmAvailable: () => true, ttlMs: 5_000 },
      5,
    );
    expect(result.pruned).toBe(1);
    expect(backlog.count()).toBe(0);
    expect(distill).not.toHaveBeenCalled(); // pruned away before claim
  });
});
