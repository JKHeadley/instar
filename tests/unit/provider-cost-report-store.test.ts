// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Unit tests — ProviderCostReportStore + extractProviderReport +
 * ProviderReconciliationSweep + the FD-21 structural gate-exclusion + the
 * feature_metrics callId wiring (routing-control-room-spend §Layer 1c).
 *
 * Pins: receive clamps (invalid rows preserved-for-audit, aggregate-excluded);
 * supersession by (meteredCallId, greatest capturedAt) — a late /generation
 * cost never double-counts; per-door extraction incl. the Gemini thinking-token
 * and OpenRouter cached-token details; signed drift math + threshold firing +
 * zero-internal guard; the sweep never throws; the money gate/ledger import
 * NOTHING from the provider store (the FD-9/FD-12 twin); and the I-4 column
 * discipline for callId (type + writer + INSERT + column — end to end).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { ProviderCostReportStore, extractProviderReport } from '../../src/monitoring/ProviderCostReportStore.js';
import { ProviderReconciliationSweep } from '../../src/monitoring/ProviderReconciliationSweep.js';
import { FeatureMetricsLedger } from '../../src/monitoring/FeatureMetricsLedger.js';

let dir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcr-'));
  clock = Date.parse('2026-07-08T12:00:00Z');
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/provider-cost-report-store.test.ts' });
});

const mkStore = (retentionDays?: number) =>
  new ProviderCostReportStore({ dbPath: path.join(dir, 'pcr.db'), retentionDays, now });

const REPORT = (over: Record<string, unknown> = {}) => ({
  meteredCallId: 'call-1',
  keyRef: 'metered_openrouter_bench',
  door: 'openrouter-api',
  modelId: 'openai/gpt-5.5',
  source: 'openrouter-usage' as const,
  providerCostUsd: 0.02,
  providerTokensIn: 1000,
  providerTokensOut: 200,
  ...over,
});

describe('ProviderCostReportStore', () => {
  it('appends and reads back the superseded-resolved latest row per call', () => {
    const s = mkStore();
    s.append(REPORT({ providerCostUsd: 0.02, source: 'openrouter-usage' }));
    clock += 5000; // the /generation cost arrives seconds later — supersedes
    s.append(REPORT({ providerCostUsd: 0.019, source: 'openrouter-generation' }));
    const latest = s.latestForCall('call-1');
    expect(latest?.source).toBe('openrouter-generation');
    expect(latest?.providerCostUsd).toBeCloseTo(0.019, 6);
  });

  it('supersession means window totals count each call ONCE (never double-counts)', () => {
    const s = mkStore();
    s.append(REPORT({ providerCostUsd: 0.02 }));
    clock += 1000;
    s.append(REPORT({ providerCostUsd: 0.019, source: 'openrouter-generation' }));
    s.append(REPORT({ meteredCallId: 'call-2', providerCostUsd: 0.01 }));
    const totals = s.windowTotals(Date.parse('2026-07-08T00:00:00Z'), clock + 1000);
    expect(totals).toHaveLength(1);
    expect(totals[0].providerCostUsd).toBeCloseTo(0.029, 6); // 0.019 (superseded) + 0.01
    expect(totals[0].reportedCalls).toBe(2);
  });

  it('receive clamp: a NaN/negative numeric marks the row invalid (audit-preserved, aggregate-excluded)', () => {
    const s = mkStore();
    s.append(REPORT({ providerCostUsd: Number.NaN }));
    s.append(REPORT({ meteredCallId: 'call-neg', providerTokensOut: -5 }));
    expect(s.latestForCall('call-1')).toBeUndefined(); // invalid rows never resolve
    const totals = s.windowTotals(0, clock + 1000);
    expect(totals).toHaveLength(0); // excluded from every aggregate
  });

  it('absent/null numerics are NORMAL (providers differ) — not invalid', () => {
    const s = mkStore();
    s.append(REPORT({ meteredCallId: 'groq-1', door: 'groq-api', source: 'groq-usage', providerCostUsd: undefined, providerTokensIn: 500, providerTokensOut: 100 }));
    const latest = s.latestForCall('groq-1');
    expect(latest?.providerCostUsd).toBeNull();
    expect(latest?.providerTokensOut).toBe(100);
  });

  it('dailyCostAggregates groups superseded-resolved costs by (day, door, model)', () => {
    const s = mkStore();
    s.append(REPORT({ providerCostUsd: 0.02 }));
    s.append(REPORT({ meteredCallId: 'call-2', providerCostUsd: 0.03 }));
    const daily = s.dailyCostAggregates(2);
    expect(daily).toHaveLength(1);
    expect(daily[0].day).toBe('2026-07-08');
    expect(daily[0].providerCostUsd).toBeCloseTo(0.05, 6);
    expect(daily[0].reportedCalls).toBe(2);
  });

  it('recon records append and read back newest-first', () => {
    const s = mkStore();
    s.appendRecon({ keyRef: 'k', door: 'd', windowStartMs: 1, windowEndMs: 2, internalUsd: 1.0, providerUsd: 1.2, committedUsd: null, driftPct: 20 });
    s.appendRecon({ keyRef: 'k', door: 'd', windowStartMs: 2, windowEndMs: 3, internalUsd: 1.0, providerUsd: 0.9, committedUsd: 5, driftPct: -10 });
    const recent = s.recentRecon(10);
    expect(recent).toHaveLength(2);
    expect(recent[0].driftPct).toBe(-10); // newest first
    expect(recent[0].committedUsd).toBe(5);
  });

  it('the batched retention prune removes only rows past the horizon (both tables)', () => {
    const s = mkStore(400);
    s.append(REPORT());
    s.appendRecon({ keyRef: 'k', door: 'd', windowStartMs: 1, windowEndMs: 2, internalUsd: 1, providerUsd: null, committedUsd: null, driftPct: null });
    clock += 401 * 86_400_000;
    s.append(REPORT({ meteredCallId: 'fresh' }));
    const removed = s.prune();
    expect(removed).toBe(2); // the old report + the old recon record
    expect(s.latestForCall('fresh')).toBeTruthy();
    expect(s.latestForCall('call-1')).toBeUndefined();
  });
});

describe('extractProviderReport — per-door field mapping', () => {
  it('OpenRouter: usage.cost + tokens + cached detail + generation id', () => {
    const r = extractProviderReport('openrouter-api', {
      id: 'gen-123',
      usage: { cost: 0.021, prompt_tokens: 900, completion_tokens: 150, prompt_tokens_details: { cached_tokens: 400 } },
    });
    expect(r).toEqual({
      source: 'openrouter-usage',
      providerCostUsd: 0.021,
      providerTokensIn: 900,
      providerTokensOut: 150,
      providerTokensCached: 400,
      generationId: 'gen-123',
    });
  });

  it('Groq: tokens only (no per-call USD exists)', () => {
    const r = extractProviderReport('groq-api', { usage: { prompt_tokens: 500, completion_tokens: 80 } });
    expect(r?.source).toBe('groq-usage');
    expect(r?.providerCostUsd).toBeUndefined();
    expect(r?.providerTokensOut).toBe(80);
  });

  it('Gemini native: candidates + thoughts (the thinking-token trap) + cached content', () => {
    const r = extractProviderReport('gemini-api', {
      usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 120, thoughtsTokenCount: 60, cachedContentTokenCount: 100 },
    });
    expect(r?.providerTokensOut).toBe(180); // candidates + thoughts — errs HIGH
    expect(r?.providerTokensCached).toBe(100);
  });

  it('Gemini OpenAI-compat shape degrades to completion_tokens', () => {
    const r = extractProviderReport('gemini-api', { usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(r?.providerTokensOut).toBe(5);
  });

  it('an absent/reshaped body degrades to null — a first-class NORMAL state', () => {
    expect(extractProviderReport('openrouter-api', undefined)).toBeNull();
    expect(extractProviderReport('openrouter-api', {})).toBeNull();
    expect(extractProviderReport('unknown-door', { usage: { cost: 1 } })).toBeNull();
  });
});

describe('ProviderReconciliationSweep', () => {
  function mkSweep(opts: { internal: Array<{ keyRef: string; door: string; internalUsd: number }>; store: ProviderCostReportStore; driftAlertPct?: number }) {
    const drifts: Array<{ keyRef: string; door: string; driftPct: number }> = [];
    const sweep = new ProviderReconciliationSweep({
      store: opts.store,
      internalDerivedUsd: () => opts.internal,
      committedUsd: (keyRef) => (keyRef === 'metered_openrouter_bench' ? 3.5 : null),
      onDrift: (keyRef, door, driftPct) => drifts.push({ keyRef, door, driftPct }),
      driftAlertPct: opts.driftAlertPct ?? 10,
      now,
    });
    return { sweep, drifts };
  }

  it('computes signed drift and fires the signal only at/above the threshold', () => {
    const store = mkStore();
    store.append(REPORT({ providerCostUsd: 1.2 })); // provider says $1.20
    const { sweep, drifts } = mkSweep({ store, internal: [{ keyRef: 'metered_openrouter_bench', door: 'openrouter-api', internalUsd: 1.0 }] });
    const r = sweep.run();
    expect(r.compared).toBe(1);
    expect(r.drifted).toBe(1);
    expect(drifts[0].driftPct).toBeCloseTo(20, 1); // provider HIGHER → positive
    const rec = store.recentRecon(1)[0];
    expect(rec.committedUsd).toBe(3.5); // holder enrichment
  });

  it('below-threshold drift is recorded SILENTLY (Near-Silent)', () => {
    const store = mkStore();
    store.append(REPORT({ providerCostUsd: 1.05 }));
    const { sweep, drifts } = mkSweep({ store, internal: [{ keyRef: 'metered_openrouter_bench', door: 'openrouter-api', internalUsd: 1.0 }] });
    sweep.run();
    expect(drifts).toHaveLength(0);
    expect(store.recentRecon(1)[0].driftPct).toBeCloseTo(5, 1); // recorded, not alerted
  });

  it('a ~zero internal base yields null drift (no infinite-drift alarm)', () => {
    const store = mkStore();
    store.append(REPORT({ providerCostUsd: 0.5 }));
    const { sweep, drifts } = mkSweep({ store, internal: [] });
    sweep.run();
    expect(drifts).toHaveLength(0);
    expect(store.recentRecon(1)[0].driftPct).toBeNull();
  });

  it('a throwing drift consumer never breaks the sweep; a broken store read returns zeros', () => {
    const store = mkStore();
    store.append(REPORT({ providerCostUsd: 2 }));
    const sweep = new ProviderReconciliationSweep({
      store,
      internalDerivedUsd: () => [{ keyRef: 'metered_openrouter_bench', door: 'openrouter-api', internalUsd: 1 }],
      onDrift: () => {
        throw new Error('consumer down');
      },
      now,
    });
    expect(() => sweep.run()).not.toThrow();
    const broken = new ProviderReconciliationSweep({
      store,
      internalDerivedUsd: () => {
        throw new Error('ledger unreadable');
      },
      now,
    });
    expect(broken.run()).toEqual({ compared: 0, drifted: 0 });
  });
});

describe('FD-21 structural exclusion — the gate/ledger import NOTHING from the provider store', () => {
  it('src/core/MeteredSpendGate.ts + MeteredSpendLedger.ts have no ProviderCostReportStore dependency', () => {
    for (const f of ['src/core/MeteredSpendGate.ts', 'src/core/MeteredSpendLedger.ts']) {
      const src = fs.readFileSync(path.join(process.cwd(), f), 'utf-8');
      expect(src.includes('ProviderCostReportStore'), `${f} must not reference the provider store`).toBe(false);
      expect(src.includes('provider-cost-reports'), `${f} must not reference the provider store db`).toBe(false);
      expect(src.includes('recon_record'), `${f} must not reference reconciliation records`).toBe(false);
    }
  });
});

describe('feature_metrics callId — the I-4 column discipline end to end', () => {
  it('record({callId}) lands in the call_id column; absent stays NULL', () => {
    const ledger = new FeatureMetricsLedger({ dbPath: path.join(dir, 'fm.db'), maintainSpendRollup: false, now });
    ledger.record({ feature: 'metered-call', outcome: 'fired', tokensIn: 10, tokensOut: 5, door: 'openrouter-api', model: 'openai/gpt-5.5', callId: 'rsv-abc123' });
    ledger.record({ feature: 'internal-call', outcome: 'noop', tokensIn: 1, tokensOut: 1 });
    const raw = (ledger as unknown as { db: import('better-sqlite3').Database }).db
      .prepare('SELECT feature, call_id FROM feature_metrics ORDER BY id')
      .all() as Array<{ feature: string; call_id: string | null }>;
    expect(raw[0].call_id).toBe('rsv-abc123');
    expect(raw[1].call_id).toBeNull();
  });
});
