/**
 * Unit tests — Burn-detection Phase 3 (BurnDetector).
 *
 * Covers the Phase 3 deliverables from docs/specs/token-burn-detection-and-self-heal.md:
 *   - absolute-share trigger fires above threshold
 *   - baseline-divergence trigger fires only after cold-start window
 *   - cold-start absolute-share still fires (the 2026-05-15 case)
 *   - per-key alert cooldown
 *   - burn-throttle-runbook::* prefix is exempt (defence-in-depth)
 *   - disabled config = no signals
 *   - empty ledger = no signals / no throw
 *   - rate floor honored (tiny absolute spend doesn't trigger baseline-divergence)
 *   - DegradationReporter receives feature='token-burn-detection' emit
 *   - byAttributionKey query on TokenLedger
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BurnDetector, DEFAULT_BURN_DETECTION_CONFIG } from '../../src/monitoring/BurnDetector.js';
import type { AttributionKeyRow } from '../../src/monitoring/TokenLedger.js';
import { TokenLedger } from '../../src/monitoring/TokenLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Stub ledger so the unit tests don't need SQLite for every case.
 * Returns the same array for every query. Tests that care about the
 * sliding-window differences pass an explicit per-call function via
 * `stubLedgerFn(fn)`.
 */
function stubLedger(byKey: AttributionKeyRow[]) {
  return {
    byAttributionKey(): AttributionKeyRow[] {
      return byKey;
    },
    summary: () => ({ totalTokens: 0 } as any),
  };
}

function stubLedgerFn(fn: (sinceMs: number) => AttributionKeyRow[]) {
  return {
    byAttributionKey({ sinceMs = 0 }: { sinceMs?: number } = {}): AttributionKeyRow[] {
      return fn(sinceMs);
    },
    summary: () => ({ totalTokens: 0 } as any),
  };
}

function stubReporter() {
  const reports: any[] = [];
  return {
    reports,
    report(ev: any) { reports.push(ev); },
  };
}

describe('BurnDetector — absolute-share trigger', () => {
  it('fires when a single key crosses 25% threshold (the 2026-05-15 case)', () => {
    const ledger = stubLedger([
      { attributionKey: 'InputDetector::abcd1234', totalTokens: 3_000_000_000, eventCount: 100_000, firstTs: 0, lastTs: 0 },
      { attributionKey: 'unknown::pre-attribution', totalTokens: 1_000_000_000, eventCount: 5_000, firstTs: 0, lastTs: 0 },
    ]);
    const reporter = stubReporter();
    // Disable baseline-divergence by setting an effectively-infinite cold-start
    // so this test isolates absolute-share behavior.
    const detector = new BurnDetector({
      ledger, reporter,
      config: { coldStartMs: Number.MAX_SAFE_INTEGER },
      now: () => 1_000_000_000_000,
    });
    const signals = detector.tick();
    expect(signals).toHaveLength(1);
    expect(signals[0].attributionKey).toBe('InputDetector::abcd1234');
    expect(signals[0].trigger).toBe('absolute-share');
    expect(signals[0].observed.share24h).toBeCloseTo(0.75, 2);
    expect(reporter.reports).toHaveLength(1);
    expect(reporter.reports[0].feature).toBe('token-burn-detection');
  });

  it('does NOT fire when share is under threshold', () => {
    const ledger = stubLedger([
      { attributionKey: 'a', totalTokens: 100, eventCount: 1, firstTs: 0, lastTs: 0 },
      { attributionKey: 'b', totalTokens: 100, eventCount: 1, firstTs: 0, lastTs: 0 },
      { attributionKey: 'c', totalTokens: 100, eventCount: 1, firstTs: 0, lastTs: 0 },
      { attributionKey: 'd', totalTokens: 100, eventCount: 1, firstTs: 0, lastTs: 0 },
      { attributionKey: 'e', totalTokens: 100, eventCount: 1, firstTs: 0, lastTs: 0 },
    ]);
    const reporter = stubReporter();
    const detector = new BurnDetector({ ledger, reporter, now: () => 1_000_000_000_000 });
    expect(detector.tick()).toHaveLength(0);
    expect(reporter.reports).toHaveLength(0);
  });

  it('caches per-key alert cooldown', () => {
    const ledger = stubLedger([
      { attributionKey: 'InputDetector::xx', totalTokens: 1_000_000_000, eventCount: 1000, firstTs: 0, lastTs: 0 },
    ]);
    const reporter = stubReporter();
    let now = 1_000_000_000_000;
    const detector = new BurnDetector({ ledger, reporter, now: () => now });
    expect(detector.tick()).toHaveLength(1);
    // Second tick within cooldown — no new signal.
    now += 10_000;
    expect(detector.tick()).toHaveLength(0);
    // Past cooldown.
    now += DEFAULT_BURN_DETECTION_CONFIG.perKeyAlertCooldownMs;
    expect(detector.tick()).toHaveLength(1);
  });
});

describe('BurnDetector — baseline-divergence + cold-start', () => {
  it('does NOT fire baseline-divergence within cold-start window even with sustained burn', () => {
    const NOW = 10 * 24 * 60 * 60 * 1000; // 10 days into clock
    // firstTs of the key is only 6 days ago — within cold-start.
    const firstTs = NOW - 6 * 24 * 60 * 60 * 1000;
    const ledger = stubLedgerFn((sinceMs) => {
      if (sinceMs >= NOW - 60 * 60 * 1000) {
        return [
          { attributionKey: 'NewComponent::yy', totalTokens: 100_000_000, eventCount: 1000, firstTs, lastTs: NOW },
          { attributionKey: 'BigOther::zz', totalTokens: 100_000, eventCount: 5, firstTs: 0, lastTs: NOW },
        ];
      }
      // 24h window — every key under 0.25 share so absolute-share does not
      // mask the baseline-cold-start behavior under test.
      // 6 equal "Other" keys at 800M each = 4.8B; NewComponent = 100M;
      // total 4.9B. Per-key shares: ~0.16 (Other), ~0.02 (NewComponent).
      return [
        { attributionKey: 'NewComponent::yy', totalTokens: 100_000_000, eventCount: 1000, firstTs, lastTs: NOW },
        { attributionKey: 'OtherA::aa', totalTokens: 800_000_000, eventCount: 5000, firstTs: 0, lastTs: NOW },
        { attributionKey: 'OtherB::bb', totalTokens: 800_000_000, eventCount: 5000, firstTs: 0, lastTs: NOW },
        { attributionKey: 'OtherC::cc', totalTokens: 800_000_000, eventCount: 5000, firstTs: 0, lastTs: NOW },
        { attributionKey: 'OtherD::dd', totalTokens: 800_000_000, eventCount: 5000, firstTs: 0, lastTs: NOW },
        { attributionKey: 'OtherE::ee', totalTokens: 800_000_000, eventCount: 5000, firstTs: 0, lastTs: NOW },
        { attributionKey: 'OtherF::ff', totalTokens: 800_000_000, eventCount: 5000, firstTs: 0, lastTs: NOW },
      ];
    });
    const reporter = stubReporter();
    const detector = new BurnDetector({ ledger, reporter, now: () => NOW });
    expect(detector.tick()).toHaveLength(0);
  });

  it('fires baseline-divergence when 1h rate exceeds 2x trailing-7d median AND rate floor', () => {
    const NOW = 30 * 24 * 60 * 60 * 1000;
    const firstTs = NOW - 14 * 24 * 60 * 60 * 1000; // 14 days ago (past cold-start)
    // 24h total must keep Surge share < 0.25, AND no OTHER key can cross
    // 0.25 itself (we want exactly one signal). Use 5 other equal-sized keys.
    const ledger = stubLedgerFn((sinceMs) => {
      if (sinceMs >= NOW - 60 * 60 * 1000 - 1) {
        // 1h: only Surge active at high rate.
        return [{ attributionKey: 'Surge::aa', totalTokens: 50_000_000, eventCount: 1000, firstTs, lastTs: NOW }];
      }
      if (sinceMs >= NOW - 24 * 60 * 60 * 1000 - 1) {
        return [
          { attributionKey: 'Surge::aa', totalTokens: 200_000_000, eventCount: 5000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherA::bb', totalTokens: 1_000_000_000, eventCount: 50_000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherB::cc', totalTokens: 1_000_000_000, eventCount: 50_000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherC::dd', totalTokens: 1_000_000_000, eventCount: 50_000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherD::ee', totalTokens: 1_000_000_000, eventCount: 50_000, firstTs, lastTs: NOW },
        ];
      }
      return [
        { attributionKey: 'Surge::aa', totalTokens: 840_000_000, eventCount: 10000, firstTs, lastTs: NOW },
      ];
    });
    const reporter = stubReporter();
    const detector = new BurnDetector({ ledger, reporter, now: () => NOW });
    const signals = detector.tick();
    expect(signals).toHaveLength(1);
    expect(signals[0].trigger).toBe('baseline-divergence');
    expect(signals[0].baselineMedian7d).toBeCloseTo(5_000_000, -3);
  });

  it('cold-start absolute-share STILL fires (2026-05-15 case — new agent, no baseline)', () => {
    const NOW = 60 * 60 * 1000; // 1h into agent's lifetime
    const ledger = stubLedger([
      { attributionKey: 'InputDetector::cc', totalTokens: 100_000_000_000, eventCount: 50_000, firstTs: 0, lastTs: NOW },
      { attributionKey: 'other::dd', totalTokens: 1_000_000_000, eventCount: 100, firstTs: 0, lastTs: NOW },
    ]);
    const reporter = stubReporter();
    const detector = new BurnDetector({ ledger, reporter, now: () => NOW });
    const signals = detector.tick();
    expect(signals).toHaveLength(1);
    expect(signals[0].trigger).toBe('absolute-share');
  });

  it('honours rollingBaselineFloor: tiny absolute spend does NOT trigger baseline-divergence', () => {
    const NOW = 30 * 24 * 60 * 60 * 1000;
    const firstTs = NOW - 14 * 24 * 60 * 60 * 1000;
    const ledger = stubLedgerFn((sinceMs) => {
      if (sinceMs >= NOW - 60 * 60 * 1000 - 1) {
        // 1h rate = 50K tokens/h, well below 10M floor.
        return [{ attributionKey: 'Tiny::ee', totalTokens: 50_000, eventCount: 50, firstTs, lastTs: NOW }];
      }
      if (sinceMs >= NOW - 24 * 60 * 60 * 1000 - 1) {
        // 24h: Tiny has tiny share. Multiple equal-sized "Other" keys keep
        // each below the absolute-share threshold.
        return [
          { attributionKey: 'Tiny::ee', totalTokens: 100_000, eventCount: 100, firstTs, lastTs: NOW },
          { attributionKey: 'OtherA::ff', totalTokens: 1_000_000_000, eventCount: 5000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherB::gg', totalTokens: 1_000_000_000, eventCount: 5000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherC::hh', totalTokens: 1_000_000_000, eventCount: 5000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherD::ii', totalTokens: 1_000_000_000, eventCount: 5000, firstTs, lastTs: NOW },
        ];
      }
      return [
        { attributionKey: 'Tiny::ee', totalTokens: 2_500_000, eventCount: 1000, firstTs, lastTs: NOW },
      ];
    });
    const reporter = stubReporter();
    const detector = new BurnDetector({ ledger, reporter, now: () => NOW });
    expect(detector.tick()).toHaveLength(0);
  });
});

describe('BurnDetector — guardrails', () => {
  it('disabled config emits nothing', () => {
    const ledger = stubLedger([
      { attributionKey: 'big::aa', totalTokens: 999_000_000_000, eventCount: 1, firstTs: 0, lastTs: 0 },
    ]);
    const reporter = stubReporter();
    const detector = new BurnDetector({ ledger, reporter, config: { enabled: false }, now: () => 1 });
    expect(detector.tick()).toHaveLength(0);
    expect(reporter.reports).toHaveLength(0);
  });

  it('empty ledger emits nothing (no division-by-zero)', () => {
    const ledger = stubLedger([]);
    const reporter = stubReporter();
    const detector = new BurnDetector({ ledger, reporter, now: () => 1 });
    expect(detector.tick()).toHaveLength(0);
  });

  it('burn-throttle-runbook::* prefix is exempt (defence in depth)', () => {
    const ledger = stubLedger([
      { attributionKey: 'burn-throttle-runbook::compose-alert', totalTokens: 999_000_000_000, eventCount: 1, firstTs: 0, lastTs: 0 },
      { attributionKey: 'tiny::other', totalTokens: 1, eventCount: 1, firstTs: 0, lastTs: 0 },
    ]);
    const reporter = stubReporter();
    const detector = new BurnDetector({ ledger, reporter, now: () => 1 });
    expect(detector.tick()).toHaveLength(0);
  });

  it('start/stop manage the interval without throwing', () => {
    const ledger = stubLedger([]);
    const reporter = stubReporter();
    const detector = new BurnDetector({ ledger, reporter, now: () => 1 });
    expect(() => detector.start()).not.toThrow();
    expect(() => detector.start()).not.toThrow(); // idempotent
    expect(() => detector.stop()).not.toThrow();
    expect(() => detector.stop()).not.toThrow(); // idempotent
  });
});

describe('BurnDetector — emitted signal shape', () => {
  it('absolute-share signal has correct observed-rates structure', () => {
    const ledger = stubLedger([
      { attributionKey: 'X::y', totalTokens: 1_000_000_000, eventCount: 100, firstTs: 0, lastTs: 0 },
    ]);
    const reporter = stubReporter();
    const detector = new BurnDetector({
      ledger, reporter,
      config: { coldStartMs: Number.MAX_SAFE_INTEGER },
      now: () => 1_000_000_000_000,
    });
    const [sig] = detector.tick();
    expect(sig.observed).toEqual({
      tokens24h: 1_000_000_000,
      share24h: 1,
      tokensLast1h: 1_000_000_000,
      projectedDaily: 24_000_000_000,
    });
    expect(sig.baselineMedian7d).toBeUndefined();
  });

  it('baseline-divergence signal carries baselineMedian7d', () => {
    const NOW = 30 * 24 * 60 * 60 * 1000;
    const firstTs = NOW - 14 * 24 * 60 * 60 * 1000;
    const ledger = stubLedgerFn((sinceMs) => {
      if (sinceMs >= NOW - 60 * 60 * 1000 - 1) {
        return [{ attributionKey: 'Surge::aa', totalTokens: 50_000_000, eventCount: 1000, firstTs, lastTs: NOW }];
      }
      if (sinceMs >= NOW - 24 * 60 * 60 * 1000 - 1) {
        return [
          { attributionKey: 'Surge::aa', totalTokens: 200_000_000, eventCount: 5000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherA::bb', totalTokens: 1_000_000_000, eventCount: 50_000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherB::cc', totalTokens: 1_000_000_000, eventCount: 50_000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherC::dd', totalTokens: 1_000_000_000, eventCount: 50_000, firstTs, lastTs: NOW },
          { attributionKey: 'OtherD::ee', totalTokens: 1_000_000_000, eventCount: 50_000, firstTs, lastTs: NOW },
        ];
      }
      return [
        { attributionKey: 'Surge::aa', totalTokens: 840_000_000, eventCount: 10000, firstTs, lastTs: NOW },
      ];
    });
    const reporter = stubReporter();
    const detector = new BurnDetector({ ledger, reporter, now: () => NOW });
    const [sig] = detector.tick();
    expect(sig.trigger).toBe('baseline-divergence');
    expect(sig.baselineMedian7d).toBeGreaterThan(0);
  });

  it('reporter receives feature="token-burn-detection" with reason naming the key', () => {
    const ledger = stubLedger([
      { attributionKey: 'NamedComponent::xyz', totalTokens: 1_000_000_000, eventCount: 100, firstTs: 0, lastTs: 0 },
    ]);
    const reporter = stubReporter();
    const detector = new BurnDetector({
      ledger, reporter,
      config: { coldStartMs: Number.MAX_SAFE_INTEGER },
      now: () => 1_000_000_000_000,
    });
    detector.tick();
    expect(reporter.reports[0].feature).toBe('token-burn-detection');
    expect(reporter.reports[0].reason).toContain('NamedComponent::xyz');
  });
});

describe('TokenLedger.byAttributionKey query (Phase 3 wiring)', () => {
  let tmp: string;
  let dbPath: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-p3-'));
    dbPath = path.join(tmp, 'ledger.db');
  });

  it('aggregates events by attribution_key', () => {
    const ledger = new TokenLedger({ dbPath, claudeProjectsDir: tmp });
    ledger.recordEvent({
      requestId: 'r1', sessionId: 's', ts: 1000,
      inputTokens: 100, outputTokens: 50,
      attributionKey: 'InputDetector::aaa',
    });
    ledger.recordEvent({
      requestId: 'r2', sessionId: 's', ts: 2000,
      inputTokens: 50, outputTokens: 25,
      attributionKey: 'InputDetector::aaa',
    });
    ledger.recordEvent({
      requestId: 'r3', sessionId: 's', ts: 1500,
      inputTokens: 10, outputTokens: 5,
      attributionKey: 'Other::bbb',
    });
    const rows = ledger.byAttributionKey({ sinceMs: 0 });
    expect(rows).toHaveLength(2);
    const top = rows.find((r) => r.attributionKey === 'InputDetector::aaa')!;
    expect(top.totalTokens).toBe(225);
    expect(top.eventCount).toBe(2);
    expect(top.firstTs).toBe(1000);
    expect(top.lastTs).toBe(2000);
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/burn-detection-phase-3.test.ts' });
  });

  it('respects sinceMs cutoff', () => {
    const ledger = new TokenLedger({ dbPath, claudeProjectsDir: tmp });
    ledger.recordEvent({
      requestId: 'r1', sessionId: 's', ts: 1000,
      inputTokens: 100, outputTokens: 50,
      attributionKey: 'a',
    });
    ledger.recordEvent({
      requestId: 'r2', sessionId: 's', ts: 2000,
      inputTokens: 10, outputTokens: 5,
      attributionKey: 'a',
    });
    const rows = ledger.byAttributionKey({ sinceMs: 1500 });
    expect(rows).toHaveLength(1);
    expect(rows[0].totalTokens).toBe(15);
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/burn-detection-phase-3.test.ts' });
  });
});
