/**
 * Unified usage ledger — Slice 3 (docs/specs/unified-usage-ledger.md): list-equivalent
 * prices, priced on read as of the bucket's UTC day, unpriced never partial.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { priceBucket, CostAccumulator, type ListPriceSource } from '../../src/monitoring/usagePricing.js';
import { RoutingPriceAuthority, isValidPricePoint, isListEquivalentDoor } from '../../src/core/routingPriceAuthority.js';
import type { RoutingPricePoint } from '../../src/core/routingPriceAuthority.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const DAY = 86_400_000;
const D1 = Date.UTC(2026, 9, 1);
const D2 = Date.UTC(2026, 10, 1);

function stub(points: RoutingPricePoint[], families: Record<string, { door: string; modelId: string }>): ListPriceSource {
  return {
    listEquivalentFor: (m) => (m ? Object.entries(families).sort((a, b) => b[0].length - a[0].length).find(([p]) => m.startsWith(p))?.[1] ?? null : null),
    canonicalPointAt: (door, modelId, ms) => {
      let best: RoutingPricePoint | null = null;
      for (const p of points) if (p.door === door && p.modelId === modelId && Date.parse(p.effectiveAt) <= ms) best = p;
      return best;
    },
  };
}

const base: RoutingPricePoint = {
  door: 'anthropic-list', modelId: 'claude-opus-5-5', inPerMtok: 4, outPerMtok: 20, cachedInPerMtok: 0.2, cacheWritePerMtok: 5,
  effectiveAt: new Date(D1).toISOString(),
};
const fam = { 'claude-opus-5-5': { door: 'anthropic-list', modelId: 'claude-opus-5-5' } };

describe('usagePricing — Slice 3', () => {
  it('applies the disjoint four-part formula', () => {
    const r = priceBucket(stub([base], fam), 'claude-opus-5-5', D1 + 3600_000, { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 });
    expect(r.priced).toBe(true);
    if (r.priced) expect(r.usd).toBeCloseTo(4 + 0.2 + 5 + 20);
  });

  it('values each bucket at the point in force on its UTC day, so a later point never rewrites earlier days', () => {
    const later: RoutingPricePoint = { ...base, inPerMtok: 2, effectiveAt: new Date(D2).toISOString() };
    const src = stub([base, later], fam);
    const t = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 };
    const before = priceBucket(src, 'claude-opus-5-5', D2 - 1, t);
    const onDay = priceBucket(src, 'claude-opus-5-5', D2 + 5, t);
    expect(before.priced && before.usd).toBeCloseTo(4);
    expect(onDay.priced && onDay.usd).toBeCloseTo(2);
  });

  it('a point effective later in the same UTC day applies to the whole day (day-aligned accounting)', () => {
    const r = priceBucket(stub([{ ...base, effectiveAt: new Date(D2).toISOString() }], fam), 'claude-opus-5-5', D2, { input: 10, cacheRead: 0, cacheWrite: 0, output: 0 });
    expect(r.priced).toBe(true);
  });

  it('a backdated point added later prices history with no rewrite (pricing happens on read)', () => {
    const t = { input: 500_000, cacheRead: 0, cacheWrite: 0, output: 0 };
    expect(priceBucket(stub([], fam), 'claude-opus-5-5', D1, t).priced).toBe(false);
    expect(priceBucket(stub([base], fam), 'claude-opus-5-5', D1, t).priced).toBe(true);
  });

  it('a missing rate for a column with tokens makes the bucket unpriced, never partially priced', () => {
    const noWrite = { ...base, cacheWritePerMtok: undefined };
    const r = priceBucket(stub([noWrite], fam), 'claude-opus-5-5', D1, { input: 100, cacheRead: 0, cacheWrite: 50, output: 10 });
    expect(r).toEqual({ priced: false, reason: 'missing-rate', tokens: 160 });
    // ...but a missing rate for a column with zero tokens is fine (Codex reports no cache writes).
    expect(priceBucket(stub([noWrite], fam), 'claude-opus-5-5', D1, { input: 100, cacheRead: 0, cacheWrite: 0, output: 10 }).priced).toBe(true);
  });

  it('an unknown model, or one with no point yet, is unpriced with its token count', () => {
    expect(priceBucket(stub([base], fam), 'mystery-1', D1, { input: 7, cacheRead: 0, cacheWrite: 0, output: 3 })).toEqual({ priced: false, reason: 'no-family', tokens: 10 });
    expect(priceBucket(stub([base], fam), null, D1, { input: 7, cacheRead: 0, cacheWrite: 0, output: 3 })).toEqual({ priced: false, reason: 'no-model', tokens: 10 });
    expect(priceBucket(stub([base], fam), 'claude-opus-5-5', D1 - DAY, { input: 7, cacheRead: 0, cacheWrite: 0, output: 0 })).toEqual({ priced: false, reason: 'no-point', tokens: 7 });
  });

  it('accumulates priced and unpriced shares', () => {
    const acc = new CostAccumulator();
    acc.add(stub([base], fam), 'claude-opus-5-5', D1, { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 });
    acc.add(stub([base], fam), 'mystery-1', D1, { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 });
    expect(acc.usd).toBeCloseTo(4);
    expect(acc.unpricedShare).toBeCloseTo(0.5);
    expect(acc.unpricedModels.get('mystery-1')).toBe(1_000_000);
  });

  it('validates cacheWritePerMtok and recognises list-equivalent doors', () => {
    expect(isValidPricePoint({ ...base })).toBe(true);
    expect(isValidPricePoint({ ...base, cacheWritePerMtok: -1 })).toBe(false);
    expect(isListEquivalentDoor('anthropic-list')).toBe(true);
    expect(isListEquivalentDoor('openrouter-api')).toBe(false);
  });

  it('the shipped manifest prices every model this agent actually uses, with a source on each point', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-pricing-'));
    try {
      const auth = new RoutingPriceAuthority({ projectDir: path.resolve('.'), stateDir: tmp });
      const t = { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 1_000_000, output: 1_000_000 };
      const day = Date.UTC(2026, 10, 10);
      for (const model of ['claude-fable-5-2', 'claude-fable-5-1', 'claude-fable-5', 'claude-opus-5-5', 'claude-sonnet-5-5',
        'claude-haiku-5-5', 'claude-haiku-4-5-20251001', 'claude-opus-4-8']) {
        const r = priceBucket(auth, model, day, t);
        expect(r.priced, model).toBe(true);
      }
      for (const model of ['gpt-6-luna', 'gpt-6-astra', 'gpt-6-sol', 'gpt-6.1-sol']) {
        const r = priceBucket(auth, model, day, { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 });
        expect(r.priced, model).toBe(true);
      }
      // Longest prefix wins: Opus 5.5 is not priced as Opus 5.
      const opus55 = priceBucket(auth, 'claude-opus-5-5', day, { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 });
      expect(opus55.priced && opus55.usd).toBeCloseTo(4);
      // The synthetic placeholder model is unpriced, not $0.
      expect(priceBucket(auth, '<synthetic>', day, { input: 5, cacheRead: 0, cacheWrite: 0, output: 0 }).priced).toBe(false);
      const manifest = JSON.parse(fs.readFileSync('scripts/routing-prices.manifest.json', 'utf-8'));
      for (const p of manifest.points.filter((x: RoutingPricePoint) => isListEquivalentDoor(x.door))) {
        expect(p.sourceUrl, p.modelId).toMatch(/^https:\/\//);
        expect(p.retrievedAt, p.modelId).toBeTruthy();
        expect(isValidPricePoint(p), p.modelId).toBe(true);
      }
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/usagePricing.test.ts:cleanup' });
    }
  });
});
