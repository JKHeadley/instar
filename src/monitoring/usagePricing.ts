/**
 * usagePricing — equivalent API cost for unified-usage-ledger figures, priced ON READ
 * as of each bucket's UTC day (docs/specs/unified-usage-ledger.md, Slice 3).
 *
 *   equiv_usd = input·p_in + cache_read·p_cache_read + cache_write·p_cache_write + output·p_out
 *
 * The five token columns are disjoint (input is fresh input only), so this is new code:
 * `reportingCost` assumes cached ⊂ input and is deliberately not reused.
 *
 * Only CANONICAL manifest points are used (never the machine-local overlay or the
 * observed cache), so the same usage is valued identically on every machine. A bucket
 * with tokens in any column whose rate is missing is UNPRICED (reported with its token
 * count), never partially priced.
 */

import type { RoutingPricePoint } from '../core/routingPriceAuthority.js';

/** The slice of the price authority pricing needs (structural, so tests can stub it). */
export interface ListPriceSource {
  listEquivalentFor(reportedModel: string | null | undefined): { door: string; modelId: string } | null;
  canonicalPointAt(door: string, modelId: string, ms: number): RoutingPricePoint | null;
}

export interface PricedTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export type PriceOutcome =
  | { priced: true; usd: number; door: string; pricedModel: string; effectiveAt: string }
  | { priced: false; reason: 'no-model' | 'no-family' | 'no-point' | 'missing-rate'; tokens: number };

const MTOK = 1_000_000;
const DAY_MS = 86_400_000;

export function totalTokens(t: PricedTokens): number {
  return t.input + t.cacheRead + t.cacheWrite + t.output;
}

/** Value one bucket's tokens for one reported model at the price in force on the bucket's UTC day. */
export function priceBucket(src: ListPriceSource | null, model: string | null, bucketMs: number, t: PricedTokens): PriceOutcome {
  const tokens = totalTokens(t);
  if (tokens === 0) return { priced: true, usd: 0, door: '', pricedModel: model ?? '', effectiveAt: '' };
  if (!src) return { priced: false, reason: 'no-point', tokens };
  if (!model) return { priced: false, reason: 'no-model', tokens };
  const fam = src.listEquivalentFor(model);
  if (!fam) return { priced: false, reason: 'no-family', tokens };
  // Day-aligned: the point in force at the END of the bucket's UTC day matches the
  // authority's day-aligned accounting (a point effective that day applies all day).
  const dayEnd = Math.floor(bucketMs / DAY_MS) * DAY_MS + DAY_MS - 1;
  const p = src.canonicalPointAt(fam.door, fam.modelId, dayEnd);
  if (!p) return { priced: false, reason: 'no-point', tokens };
  const rates = { input: p.inPerMtok, cacheRead: p.cachedInPerMtok, cacheWrite: p.cacheWritePerMtok, output: p.outPerMtok };
  for (const k of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
    if (t[k] > 0 && (rates[k] == null || !Number.isFinite(rates[k]!))) return { priced: false, reason: 'missing-rate', tokens };
  }
  const usd = (t.input * rates.input + t.cacheRead * (rates.cacheRead ?? 0) + t.cacheWrite * (rates.cacheWrite ?? 0) + t.output * rates.output) / MTOK;
  return { priced: true, usd, door: fam.door, pricedModel: fam.modelId, effectiveAt: p.effectiveAt };
}

/** Accumulates priced and unpriced shares over many buckets. */
export class CostAccumulator {
  usd = 0;
  pricedTokens = 0;
  unpricedTokens = 0;
  readonly unpricedModels = new Map<string, number>();

  add(src: ListPriceSource | null, model: string | null, bucketMs: number, t: PricedTokens): number {
    const r = priceBucket(src, model, bucketMs, t);
    if (r.priced) {
      this.usd += r.usd;
      this.pricedTokens += totalTokens(t);
      return r.usd;
    }
    this.unpricedTokens += r.tokens;
    const k = model ?? '(none)';
    this.unpricedModels.set(k, (this.unpricedModels.get(k) ?? 0) + r.tokens);
    return 0;
  }

  /** Share of tokens with no price, 0..1. */
  get unpricedShare(): number {
    const all = this.pricedTokens + this.unpricedTokens;
    return all === 0 ? 0 : this.unpricedTokens / all;
  }
}
