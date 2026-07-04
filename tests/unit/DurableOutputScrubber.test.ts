/**
 * DurableOutputScrubber — the config-gated Layer-B service
 * (src/monitoring/DurableOutputScrubber.ts, Durable-Output Hygiene Standard §2).
 *
 * Covers both sides of every decision boundary:
 *   - disabled  → strict no-op (input returned, no metrics, applied:false);
 *   - dryRun    → COMPUTES + records would-redact metrics but returns ORIGINAL
 *                 text (the canary — no durable mutation);
 *   - enforcing → returns the scrubbed text + the MANDATORY provenance marker;
 *   - poisoning → a burst of redactions on one store fires the alarm ONCE/window;
 *   - metrics   → fired / noop / error outcomes recorded under the feature key.
 *
 * Placeholder credential built to match SHAPE only (spec §4).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  DurableOutputScrubber,
  DURABLE_SCRUB_FEATURE_KEY,
  type DurableScrubMetricsSink,
  type PoisoningSignal,
} from '../../src/monitoring/DurableOutputScrubber.js';

const SECRET = 'ghp_EXAMPLE' + 'A'.repeat(24);
const CLEAN = 'building the scheduler, all tests pass';

function metricsSpy(): { sink: DurableScrubMetricsSink; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    sink: { recordEvent: (feature, outcome) => calls.push([feature, outcome]) },
  };
}

describe('DurableOutputScrubber — config gating', () => {
  it('disabled → strict no-op (input unchanged, no metrics, not applied)', () => {
    const m = metricsSpy();
    const s = new DurableOutputScrubber({ enabled: false, dryRun: false, metrics: m.sink });
    const out = s.scrub(`x ${SECRET} y`, { store: 'test' });
    expect(out.text).toBe(`x ${SECRET} y`);
    expect(out.applied).toBe(false);
    expect(out.redactions).toEqual([]);
    expect(m.calls).toEqual([]);
    expect(s.isEngaged()).toBe(false);
    expect(s.isEnforcing()).toBe(false);
  });

  it('dryRun (the canary) → computes + records metrics but returns ORIGINAL text', () => {
    const m = metricsSpy();
    const s = new DurableOutputScrubber({ enabled: true, dryRun: true, metrics: m.sink });
    const out = s.scrub(`x ${SECRET} y`, { store: 'test' });
    // Original text persists — NO durable mutation while dryRun holds.
    expect(out.text).toBe(`x ${SECRET} y`);
    expect(out.applied).toBe(false);
    // But the would-redact metadata + metrics ARE recorded.
    expect(out.redactions.length).toBe(1);
    expect(out.provenance).toContain('1 span redacted');
    expect(m.calls).toEqual([[DURABLE_SCRUB_FEATURE_KEY, 'fired']]);
    expect(s.isEngaged()).toBe(true);
    expect(s.isEnforcing()).toBe(false);
  });

  it('dryRun defaults TRUE when the flag is omitted (fail-safe — never silently enforce)', () => {
    const s = new DurableOutputScrubber({ enabled: true });
    expect(s.isEnforcing()).toBe(false);
    const out = s.scrub(`x ${SECRET} y`, { store: 'test' });
    expect(out.text).toBe(`x ${SECRET} y`); // unchanged — dryRun default
    expect(out.applied).toBe(false);
  });

  it('enforcing → returns scrubbed text + the mandatory provenance marker', () => {
    const m = metricsSpy();
    const s = new DurableOutputScrubber({ enabled: true, dryRun: false, metrics: m.sink });
    const out = s.scrub(`x ${SECRET} y`, { store: 'test' });
    expect(out.text).toContain('[REDACTED:github-token]');
    expect(out.text).not.toContain(SECRET);
    expect(out.applied).toBe(true);
    expect(out.provenance).toContain('span redacted by durable-output scrub');
    expect(m.calls).toEqual([[DURABLE_SCRUB_FEATURE_KEY, 'fired']]);
    expect(s.isEnforcing()).toBe(true);
  });

  it('enforcing on clean text → noop metric, no provenance, text unchanged', () => {
    const m = metricsSpy();
    const s = new DurableOutputScrubber({ enabled: true, dryRun: false, metrics: m.sink });
    const out = s.scrub(CLEAN, { store: 'test' });
    expect(out.text).toBe(CLEAN);
    expect(out.applied).toBe(false);
    expect(out.provenance).toBeUndefined();
    expect(m.calls).toEqual([[DURABLE_SCRUB_FEATURE_KEY, 'noop']]);
  });
});

describe('DurableOutputScrubber — structured records', () => {
  it('enforcing scrubs named fields + sets provenance', () => {
    const s = new DurableOutputScrubber({ enabled: true, dryRun: false });
    const rec = { task: `deploy ${SECRET}`, phase: 'building', files: ['a.ts'] };
    const out = s.scrubRecord(rec, ['task', 'files'], { store: 'session-summary' });
    expect(out.record.task).toContain('[REDACTED:github-token]');
    expect(out.record.phase).toBe('building');
    expect(out.applied).toBe(true);
    expect(out.provenance).toContain('redacted');
  });

  it('dryRun leaves the record unmutated but records the would-redact', () => {
    const m = metricsSpy();
    const s = new DurableOutputScrubber({ enabled: true, dryRun: true, metrics: m.sink });
    const rec = { task: `deploy ${SECRET}` };
    const out = s.scrubRecord(rec, ['task'], { store: 'session-summary' });
    expect(out.record.task).toBe(`deploy ${SECRET}`); // unchanged
    expect(out.applied).toBe(false);
    expect(m.calls).toEqual([[DURABLE_SCRUB_FEATURE_KEY, 'fired']]);
  });
});

describe('DurableOutputScrubber — poisoning alarm', () => {
  it('fires ONCE per window when redactions on one store cross the threshold', () => {
    const signals: PoisoningSignal[] = [];
    let clock = 1_000_000;
    const s = new DurableOutputScrubber({
      enabled: true,
      dryRun: true, // computes redactions; alarm keys on redaction COUNT not mutation
      poisoningThreshold: 3,
      poisoningWindowMs: 60_000,
      onPoisoningSuspected: (sig) => signals.push(sig),
      now: () => clock,
    });
    for (let i = 0; i < 5; i++) {
      s.scrub(`plant ${SECRET}`, { store: 'memory' });
      clock += 1_000;
    }
    expect(signals.length).toBe(1);
    expect(signals[0].store).toBe('memory');
    expect(signals[0].count).toBeGreaterThanOrEqual(3);
    expect(signals[0].kinds).toContain('github-token');
  });

  it('does not alarm on clean writes (no redactions → no count)', () => {
    const signals: PoisoningSignal[] = [];
    const s = new DurableOutputScrubber({
      enabled: true,
      dryRun: false,
      poisoningThreshold: 2,
      onPoisoningSuspected: (sig) => signals.push(sig),
    });
    for (let i = 0; i < 5; i++) s.scrub(CLEAN, { store: 'memory' });
    expect(signals).toEqual([]);
  });

  it('a metrics-sink throw never breaks the scrub (observability is best-effort)', () => {
    const throwingSink: DurableScrubMetricsSink = {
      recordEvent: () => { throw new Error('sink down'); },
    };
    const s = new DurableOutputScrubber({ enabled: true, dryRun: false, metrics: throwingSink });
    expect(() => s.scrub(`x ${SECRET} y`, { store: 'test' })).not.toThrow();
    const out = s.scrub(`x ${SECRET} y`, { store: 'test' });
    expect(out.text).toContain('[REDACTED:github-token]'); // scrub still applied
  });
});
