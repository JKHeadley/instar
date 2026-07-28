/**
 * Unit tests for FeatureMetricsLedger — per-feature LLM observability.
 * Spec: docs/specs/llm-feature-metrics-spec.md (Phase 1a).
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let ledger: FeatureMetricsLedger | null = null;
function newLedger(now?: () => number): FeatureMetricsLedger {
  ledger = new FeatureMetricsLedger({ dbPath: ':memory:', now });
  return ledger;
}

afterEach(() => {
  ledger?.close();
  ledger = null;
});

describe('FeatureMetricsLedger', () => {
  it('rolls up cost + hit-rate per feature', () => {
    const l = newLedger();
    l.record({ feature: 'MessagingToneGate', outcome: 'noop', tokensIn: 100, tokensOut: 20, latencyMs: 500, model: 'fast' });
    l.record({ feature: 'MessagingToneGate', outcome: 'fired', tokensIn: 120, tokensOut: 30, latencyMs: 700, model: 'fast' });
    l.record({ feature: 'CoherenceReviewer', outcome: 'noop', tokensIn: 800, tokensOut: 60, latencyMs: 1500, model: 'balanced' });

    const byFeature = l.byFeature();
    const tone = byFeature.find(f => f.feature === 'MessagingToneGate')!;
    const coh = byFeature.find(f => f.feature === 'CoherenceReviewer')!;

    expect(tone.calls).toBe(2);
    expect(tone.llmCalls).toBe(2);
    expect(tone.tokensIn).toBe(220);
    expect(tone.tokensOut).toBe(50);
    expect(tone.fired).toBe(1);
    expect(tone.noop).toBe(1);
    expect(tone.fireRate).toBeCloseTo(0.5, 5);
    expect(tone.maxLatencyMs).toBe(700);
    expect(tone.avgLatencyMs).toBe(600);

    expect(coh.calls).toBe(1);
    expect(coh.tokensIn).toBe(800);
    expect(coh.fireRate).toBe(0); // never fired
  });

  it('records provider/model + framework and surfaces distinct sets per feature (Observable Intelligence)', () => {
    const l = newLedger();
    l.record({ feature: 'MessageSentinel', outcome: 'noop', model: 'gpt-5.4-mini', framework: 'codex-cli' });
    l.record({ feature: 'MessageSentinel', outcome: 'fired', model: 'gpt-5.4-mini', framework: 'codex-cli' });
    l.record({ feature: 'MessageSentinel', outcome: 'noop', model: 'claude-haiku-4-5', framework: 'claude-code' });
    const m = l.byFeature().find(f => f.feature === 'MessageSentinel')!;
    expect(m.frameworks.sort()).toEqual(['claude-code', 'codex-cli']);
    expect(m.models.sort()).toEqual(['claude-haiku-4-5', 'gpt-5.4-mini']);
    expect(m.fired).toBe(1);
    expect(m.fireRate).toBeCloseTo(1 / 3, 5);
  });

  it('frameworks/models are empty arrays when never recorded', () => {
    const l = newLedger();
    l.record({ feature: 'Bare', outcome: 'noop' });
    const b = l.byFeature().find(f => f.feature === 'Bare')!;
    expect(b.frameworks).toEqual([]);
    expect(b.models).toEqual([]);
  });

  it('pruneOlderThan deletes rows older than the cutoff (bounded retention)', () => {
    let t = 1_000_000;
    const l = newLedger(() => t);
    t = 1000; l.record({ feature: 'X', outcome: 'noop' });   // old
    t = 5000; l.record({ feature: 'X', outcome: 'fired' });  // recent
    const deleted = l.pruneOlderThan(3000);
    expect(deleted).toBe(1);
    const x = l.byFeature().find(f => f.feature === 'X')!;
    expect(x.calls).toBe(1);
    expect(x.fired).toBe(1);
  });

  it('computes p50/p95 latency percentiles', () => {
    const l = newLedger();
    for (const ms of [100, 200, 300, 400, 1000]) {
      l.record({ feature: 'X', outcome: 'noop', latencyMs: ms });
    }
    const x = l.byFeature().find(f => f.feature === 'X')!;
    // nearest-rank: p50 -> ceil(0.5*5)=3rd -> 300; p95 -> ceil(0.95*5)=5th -> 1000
    expect(x.p50LatencyMs).toBe(300);
    expect(x.p95LatencyMs).toBe(1000);
  });

  it('buckets calls with no feature label under "unlabeled"', () => {
    const l = newLedger();
    l.record({ feature: '', outcome: 'noop' });
    l.record({ feature: '   ', outcome: 'fired' });
    const rows = l.byFeature();
    const un = rows.find(f => f.feature === 'unlabeled')!;
    expect(un).toBeTruthy();
    expect(un.calls).toBe(2);
    expect(rows.every(f => f.feature !== '' && f.feature.trim() !== '')).toBe(true);
  });

  it('recordEvent tracks programmatic guards (kind=event, no tokens)', () => {
    const l = newLedger();
    l.recordEvent('dangerous-command-guard', 'noop');
    l.recordEvent('dangerous-command-guard', 'fired');
    const g = l.byFeature().find(f => f.feature === 'dangerous-command-guard')!;
    expect(g.events).toBe(2);
    expect(g.llmCalls).toBe(0);
    expect(g.tokensIn).toBe(0);
    expect(g.fired).toBe(1);
    expect(g.fireRate).toBeCloseTo(0.5, 5);
  });

  it('tracks post-#638 wait-events (rate-limit bounded wait)', () => {
    const l = newLedger();
    l.record({ feature: 'CoherenceGate', outcome: 'noop', latencyMs: 200, waited: false });
    l.record({ feature: 'CoherenceGate', outcome: 'fired', latencyMs: 900, waited: true, waitMs: 600 });
    const g = l.byFeature().find(f => f.feature === 'CoherenceGate')!;
    expect(g.waitedCalls).toBe(1);
    expect(g.avgWaitMs).toBe(600);
  });

  it('honors the sinceHours lookback window', () => {
    let t = 1_000_000_000_000;
    const l = newLedger(() => t);
    l.record({ feature: 'Old', outcome: 'noop' });          // at t
    t += 3 * 3_600_000;                                      // +3h
    l.record({ feature: 'Recent', outcome: 'noop' });        // at t+3h
    t += 1; // tiny nudge so "now" is just past the recent write
    const recent = l.byFeature({ sinceHours: 1 });
    expect(recent.find(f => f.feature === 'Recent')).toBeTruthy();
    expect(recent.find(f => f.feature === 'Old')).toBeUndefined();
    const all = l.byFeature();
    expect(all.length).toBe(2);
  });

  it('summary returns totals + per-feature rollup', () => {
    const l = newLedger();
    l.record({ feature: 'A', outcome: 'fired', tokensIn: 10, tokensOut: 5 });
    l.record({ feature: 'B', outcome: 'noop', tokensIn: 20, tokensOut: 0 });
    l.recordEvent('C', 'noop');
    const s = l.summary();
    expect(s.totals.calls).toBe(3);
    expect(s.totals.llmCalls).toBe(2);
    expect(s.totals.events).toBe(1);
    expect(s.totals.tokensIn).toBe(30);
    expect(s.totals.fired).toBe(1);
    expect(s.features.length).toBe(3);
  });

  it('record after close is a no-op and never throws', () => {
    const l = newLedger();
    l.close();
    expect(() => l.record({ feature: 'X', outcome: 'noop' })).not.toThrow();
  });

  it('idempotently adds the framework column to a pre-existing old-schema DB', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feat-metrics-'));
    const dbPath = path.join(dir, 'old.db');
    // Create the table on the ORIGINAL schema (no framework column), as an
    // earlier instar would have left it on disk.
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE feature_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, feature TEXT NOT NULL,
      kind TEXT NOT NULL, outcome TEXT NOT NULL, tokens_in INTEGER, tokens_out INTEGER,
      latency_ms INTEGER, model TEXT, waited INTEGER NOT NULL DEFAULT 0, wait_ms INTEGER, verdict_id TEXT)`);
    seed.prepare(`INSERT INTO feature_metrics (ts, feature, kind, outcome) VALUES (1, 'Legacy', 'llm', 'noop')`).run();
    seed.close();

    // Opening the ledger must add the column without losing the legacy row.
    const l = new FeatureMetricsLedger({ dbPath });
    try {
      l.record({ feature: 'New', outcome: 'fired', model: 'gpt-5.4-mini', framework: 'codex-cli' });
      const rows = l.byFeature();
      expect(rows.find(f => f.feature === 'Legacy')!.calls).toBe(1);
      expect(rows.find(f => f.feature === 'New')!.frameworks).toEqual(['codex-cli']);
    } finally {
      l.close();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/FeatureMetricsLedger.test.ts:cleanup' });
    }
  });
});
