/**
 * Unit tests for the pure spend/caps composer (src/core/routingSpendView.ts), Surface 1
 * of routing-control-room-spend Increment A. Covers: NULL-door token volume rendered as
 * UNCOSTED (never a fabricated $0), metered doors labelled not-live, subscription/CLI
 * doors $0, totals aggregation, the caps view ($0 committed / not-live everywhere), and
 * the metered-keys-from-chains derivation. Uses a real RoutingPriceAuthority over a
 * temp manifest — no mocks of the price layer.
 */
// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { RoutingPriceAuthority } from '../../src/core/routingPriceAuthority.js';
import {
  buildRoutingSpendSummary,
  buildRoutingSpendCaps,
  meteredKeysFromChains,
  DEFAULT_METERED_CAPS,
} from '../../src/core/routingSpendView.js';
import type { SpendTokenBucket } from '../../src/monitoring/FeatureMetricsLedger.js';

let projectDir: string;
let stateDir: string;

function priceAuthority(): RoutingPriceAuthority {
  fs.mkdirSync(path.join(projectDir, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'scripts', 'routing-prices.manifest.json'),
    JSON.stringify({
      schemaVersion: 1,
      version: 1,
      doors: {},
      points: [
        { door: 'openrouter-api', modelId: 'openai/gpt-5.5', inPerMtok: 5, outPerMtok: 30, effectiveAt: '2026-07-01T00:00:00.000Z' },
      ],
    }),
  );
  return new RoutingPriceAuthority({ projectDir, stateDir, now: () => Date.parse('2026-07-05T00:00:00Z') });
}

function bucket(partial: Partial<SpendTokenBucket>): SpendTokenBucket {
  return {
    bucket: '2026-07-03',
    bucketStartMs: Date.parse('2026-07-03T00:00:00Z'),
    door: 'unknown',
    modelId: 'unknown',
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    ...partial,
  };
}

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-proj-'));
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsv-state-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/routing-spend-view.test.ts' });
  SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/unit/routing-spend-view.test.ts' });
});

const opts = (buckets: SpendTokenBucket[]) => ({
  buckets,
  prices: priceAuthority(),
  grain: 'day' as const,
  now: Date.parse('2026-07-05T00:00:00Z'),
  rollupMaintained: true,
  lastReconcileAt: Date.parse('2026-07-05T00:00:00Z'),
  tokenRollupRetentionDays: 400,
});

describe('buildRoutingSpendSummary', () => {
  it('renders NULL-door token volume as UNCOSTED (unknown door → subscription-zero, $0, tokens surfaced)', () => {
    const s = buildRoutingSpendSummary(opts([bucket({ door: 'unknown', modelId: 'unknown', tokensIn: 5_000_000, tokensOut: 1_000_000 })]));
    const row = s.rows.find((r) => r.door === 'unknown')!;
    expect(row.grossUsd).toBe(0);
    // unknown door is not metered → not "unpriced"; it is uncosted, tokens preserved.
    expect(row.tokensIn).toBe(5_000_000);
    expect(s.totals.tokensIn).toBe(5_000_000);
    expect(s.meteredLiveYet).toBe(false);
  });

  it('prices a metered door row and flags it not-live-yet', () => {
    const s = buildRoutingSpendSummary(opts([bucket({ door: 'openrouter-api', modelId: 'openai/gpt-5.5', tokensIn: 1_000_000, tokensOut: 1_000_000 })]));
    const row = s.rows.find((r) => r.door === 'openrouter-api')!;
    expect(row.doorClass).toBe('metered');
    expect(row.notLiveYet).toBe(true);
    expect(row.priceBasis).toBe('canonical');
    expect(row.grossUsd).toBeCloseTo(35, 6); // 5 in + 30 out
    expect(row.committedUsd).toBe(0); // no money ledger in Increment A
    // Layer 1c read contract: internal-derived (no provider cost captured in A), nulls for provider fields.
    expect(row.costBasis).toBe('internal-derived');
    expect(row.providerReportedUsd).toBeNull();
    expect(row.providerDriftPct).toBeNull();
    expect(s.providerGroundingNote).toContain('No provider-reported cost captured yet');
  });

  it('surfaces UNPRICED tokens for a metered door with no matching price (loud, never $0)', () => {
    const s = buildRoutingSpendSummary(opts([bucket({ door: 'groq-api', modelId: 'openai/gpt-oss-120b', tokensIn: 2_000_000, tokensOut: 0 })]));
    const row = s.rows.find((r) => r.door === 'groq-api')!;
    expect(row.priceBasis).toBe('no-matching-point');
    expect(row.grossUsd).toBe(0);
    expect(row.unpricedTokensIn).toBe(2_000_000);
    expect(s.totals.unpricedTokensIn).toBe(2_000_000);
  });

  it('aggregates totals across rows', () => {
    const s = buildRoutingSpendSummary(opts([
      bucket({ door: 'openrouter-api', modelId: 'openai/gpt-5.5', tokensIn: 1_000_000, tokensOut: 1_000_000 }),
      bucket({ door: 'claude-code', modelId: 'claude-sonnet-4-6', tokensIn: 3_000_000, tokensOut: 3_000_000 }),
    ]));
    expect(s.totals.tokensIn).toBe(4_000_000);
    expect(s.totals.grossUsd).toBeCloseTo(35, 6); // only the metered row costs; claude-code is $0
  });
});

describe('buildRoutingSpendCaps', () => {
  it('lists every metered key from the routing chains, $0 committed + not-live', () => {
    const caps = buildRoutingSpendCaps();
    const keys = caps.keys.map((k) => k.keyRef).sort();
    expect(keys).toEqual(['metered_gemini_bench', 'metered_groq_bench', 'metered_openrouter_bench']);
    for (const k of caps.keys) {
      expect(k.committedLifetimeUsd).toBe(0);
      expect(k.committedDayUsd).toBe(0);
      expect(k.goLiveState).toBe('not-live');
      expect(k.lifetimeCapUsd).toBe(DEFAULT_METERED_CAPS[k.keyRef].lifetimeCapUsd);
    }
    expect(caps.meteredLiveYet).toBe(false);
  });

  it('derives the metered (keyRef → door) pairs from the shipped chains', () => {
    const pairs = meteredKeysFromChains();
    expect(pairs).toEqual(expect.arrayContaining([
      { keyRef: 'metered_gemini_bench', door: 'gemini-api' },
      { keyRef: 'metered_openrouter_bench', door: 'openrouter-api' },
      { keyRef: 'metered_groq_bench', door: 'groq-api' },
    ]));
  });
});
