/**
 * Unit tests — the web-verify pricing-page parsers + amortized subscription
 * display (routing-control-room-spend PR 4; operator decisions 2026-07-07).
 *
 * Scrape/Parser Fixture Realness: both page parsers are fed the REAL captured
 * bytes of the providers' official pricing pages (tests/fixtures/captured/
 * pricing-page-groq + pricing-page-google) — never a hand-authored clean
 * string. Conservative fail-closed behavior is pinned: a reshaped page yields
 * NO point (refuse, never guess), and the plausibility clamp refuses a price
 * >10x off the reviewed canonical one.
 */
import { describe, it, expect } from 'vitest';
import { loadCapturedFixture } from '../helpers/loadCapturedFixture.js';
import {
  parseGroqPricingHtml,
  parseGooglePricingHtml,
  plausibleVsCanonical,
} from '../../scripts/routing-price-refresh.mjs';
import { buildRoutingSpendSummary } from '../../src/core/routingSpendView.js';
import { RoutingPriceAuthority } from '../../src/core/routingPriceAuthority.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NOW = Date.parse('2026-07-08T18:00:00Z');

describe('web-verify pricing-page parsers (fixture realness)', () => {
  it('parses the REAL groq.com/pricing table bytes', () => {
    const html = loadCapturedFixture('pricing-page-groq', 'pricing-table');
    const pts = parseGroqPricingHtml(html, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({
      door: 'groq-api',
      modelId: 'openai/gpt-oss-120b',
      inPerMtok: 0.15,
      outPerMtok: 0.6,
      effectiveAt: '2026-07-08T00:00:00.000Z', // UTC-day-aligned (FD-18)
      corrects: null, // forward-only — the job can never write a correction
    });
  });

  it('parses the REAL ai.google.dev/pricing flash-lite card bytes (PAID text rate, never audio/free)', () => {
    const html = loadCapturedFixture('pricing-page-google', 'flash-lite-card');
    const pts = parseGooglePricingHtml(html, NOW);
    expect(pts).toHaveLength(1);
    expect(pts[0]).toMatchObject({
      door: 'gemini-api',
      modelId: 'gemini-3.1-flash-lite',
      inPerMtok: 0.25, // the "(text / image / video)" rate — NOT the $0.50 audio rate
      outPerMtok: 1.5, // "Output price (including thinking tokens)"
      corrects: null,
    });
  });

  it('a reshaped page REFUSES (no points) — never a guessed price', () => {
    expect(parseGroqPricingHtml('<html><body>redesigned marketing page</body></html>', NOW)).toHaveLength(0);
    expect(parseGooglePricingHtml('<html>totally new layout</html>', NOW)).toHaveLength(0);
    expect(parseGroqPricingHtml(undefined as never, NOW)).toHaveLength(0);
  });

  it('the plausibility clamp refuses a price >10x off the reviewed canonical point', () => {
    const manifest = { points: [{ door: 'groq-api', modelId: 'openai/gpt-oss-120b', inPerMtok: 0.15, outPerMtok: 0.6, effectiveAt: '2026-07-01T00:00:00.000Z' }] };
    const sane = { door: 'groq-api', modelId: 'openai/gpt-oss-120b', inPerMtok: 0.2, outPerMtok: 0.8 };
    const wild = { door: 'groq-api', modelId: 'openai/gpt-oss-120b', inPerMtok: 15, outPerMtok: 0.6 };
    expect(plausibleVsCanonical(sane, manifest)).toBe(true);
    expect(plausibleVsCanonical(wild, manifest)).toBe(false);
    expect(plausibleVsCanonical(wild, null)).toBe(true); // no baseline → clamp passes
    expect(plausibleVsCanonical(wild, { points: [] })).toBe(true);
  });
});

describe('amortized subscription display (operator decision #3 — "show the math")', () => {
  function summarize(subscriptions?: Record<string, { monthlyUsd: number; label?: string }>) {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amort-proj-'));
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amort-state-'));
    const prices = new RoutingPriceAuthority({ projectDir, stateDir, now: () => NOW });
    const day = (d: string) => Date.parse(`${d}T00:00:00.000Z`);
    return buildRoutingSpendSummary({
      buckets: [
        { bucketStartMs: day('2026-07-06'), door: 'claude-code', modelId: 'claude-opus-4-8', tokensIn: 1_000_000, tokensOut: 100_000, tokensCached: 0 },
        { bucketStartMs: day('2026-07-07'), door: 'claude-code', modelId: 'claude-opus-4-8', tokensIn: 2_000_000, tokensOut: 200_000, tokensCached: 0 },
        { bucketStartMs: day('2026-07-07'), door: 'codex-cli', modelId: 'gpt-5.5', tokensIn: 500_000, tokensOut: 50_000, tokensCached: 0 },
      ],
      prices,
      grain: 'day',
      now: NOW,
      rollupMaintained: true,
      lastReconcileAt: null,
      tokenRollupRetentionDays: 400,
      subscriptions,
    });
  }

  it('a declared door gets the amortized figure with the FULL visible derivation', () => {
    const s = summarize({ 'claude-code': { monthlyUsd: 200, label: 'Claude Max' } });
    const row = s.rows.find((r) => r.door === 'claude-code')!;
    // $200/mo ÷ 30.4375 = $6.5708/day × 2 active days = $13.1417
    expect(row.amortizedSubscriptionUsd).toBeCloseTo(13.1417, 3);
    expect(row.amortizationDerivation).toContain('$200.00/mo ÷ 30.4375 avg days/mo');
    expect(row.amortizationDerivation).toContain('× 2 active day(s)');
    expect(row.amortizationDerivation).toContain('calendar-time allocation');
    expect(row.amortizationDerivation).toContain('never cap-enforced');
    // Totals count the DOOR-level figure once.
    expect(s.totals.amortizedSubscriptionUsd).toBeCloseTo(13.1417, 3);
  });

  it('undeclared doors keep the honest null (the $0-subscription display)', () => {
    const s = summarize({ 'claude-code': { monthlyUsd: 200 } });
    const codex = s.rows.find((r) => r.door === 'codex-cli')!;
    expect(codex.amortizedSubscriptionUsd).toBeNull();
    expect(codex.amortizationDerivation).toBeNull();
  });

  it('no subscriptions configured → every row null and totals null', () => {
    const s = summarize(undefined);
    expect(s.rows.every((r) => r.amortizedSubscriptionUsd === null)).toBe(true);
    expect(s.totals.amortizedSubscriptionUsd).toBeNull();
  });
});
