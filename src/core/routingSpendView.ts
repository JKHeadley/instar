/**
 * routingSpendView.ts — Surface 1 (read-only spend/caps VIEW) of the Routing Control
 * Room (docs/specs/routing-control-room-spend-alerts.md, Increment A).
 *
 * A pure composition (mirroring `natureRoutingMap.ts`): it turns the IMMUTABLE token
 * rollup (FeatureMetricsLedger Layer 2) into a priced REPORTING view by joining the
 * price authority (Layer 1) ON READ, and lists every metered key with its caps and
 * honest not-live-yet / $0 state. It performs ZERO writes, gates NO money, and books
 * NOTHING — the authoritative money ledger + O(1) gate are Increment B (NOT built
 * here). Corrections flow DOWN the reporting side (a price fix recomputes the view);
 * nothing flows up into token truth.
 *
 * Honesty rules this composer enforces (spec):
 *  - Subscription/CLI doors: `$0 (subscription — not per-token billed)` — never misread
 *    as "barely spending" (FD-7).
 *  - A metered (door,model) we cannot price: LOUD `unpricedTokens`, never a fabricated $0.
 *  - Before go-live: metered doors are skipped, metered spend is $0, stated plainly.
 */

import {
  NATURE_ROUTING_DEFAULT_CHAINS,
  METERED_ROUTING_DOORS,
} from '../data/llmBenchCoverage.js';
import type { RoutingPriceAuthority, PriceBasis, DoorClass } from './routingPriceAuthority.js';
import type { SpendTokenBucket } from '../monitoring/FeatureMetricsLedger.js';

export type SpendGrain = 'hour' | 'day' | 'month' | 'total';

/**
 * How a row's dollar figure was derived (Layer 1c read contract). In Increment A there
 * is no metered dispatch, so no provider-reported cost is captured yet — every costed
 * row is `internal-derived` (token×as-of-price), subscription rows are `subscription-zero`,
 * and an unpriceable metered row is `unpriced`. `provider-reported` /
 * `internal-derived-provider-tokens` only appear once the metered capture seam feeds the
 * (empty-in-A) provider-cost store.
 */
export type CostBasis =
  | 'provider-reported'
  | 'internal-derived'
  | 'internal-derived-provider-tokens'
  | 'subscription-zero'
  | 'unpriced';

/** One priced reporting row (per door×model over the window). */
export interface SpendSummaryRow {
  door: string;
  modelId: string;
  doorClass: DoorClass;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  /** Recomputed at the AS-OF price for each bucket, summed (net of subsidy per row). */
  grossUsd: number;
  subsidyUsd: number;
  /** Credits are a per-key lump sum applied at the TOTALS level, never per-model — always 0 here. */
  creditUsd: number;
  netUsd: number;
  /** The cap-enforced (committed-at-time-of-use) figure — 0 until Increment B's money ledger exists. */
  committedUsd: number;
  priceBasis: PriceBasis;
  /** How the dollar figure was derived (Layer 1c). Always internal-derived / subscription / unpriced in Increment A. */
  costBasis: CostBasis;
  /** Provider-reported cost when captured; null until the metered capture seam has data (Increment A: always null). */
  providerReportedUsd: number | null;
  /** Signed internal-vs-provider drift %, once the reconciliation sweep has run; null in Increment A. */
  providerDriftPct: number | null;
  priceStale: boolean;
  /** A metered door that does not route yet in Increment A. */
  notLiveYet: boolean;
  unpricedTokensIn: number;
  unpricedTokensOut: number;
}

export interface SpendSummaryTotals {
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  grossUsd: number;
  subsidyUsd: number;
  creditUsd: number;
  netUsd: number;
  committedUsd: number;
  unpricedTokensIn: number;
  unpricedTokensOut: number;
}

export interface SpendSummary {
  grain: SpendGrain;
  rows: SpendSummaryRow[];
  totals: SpendSummaryTotals;
  /** Which machine's operator overlay/credits produced the adjustments (pool-merge label). */
  adjustmentsSource: string | null;
  horizonNote: string;
  /** No paid door is live yet in Increment A. */
  meteredLiveYet: boolean;
  /**
   * The analytical view is best-effort observability — it never masquerades as the
   * authoritative money number (the caps surface's committed figure is what a cap
   * enforces). Two spend numbers, both labelled (A-M10/X-C2).
   */
  reportingBasis: {
    source: string;
    lastReconcileAt: string | null;
    rollupMaintained: boolean;
    note: string;
  };
  /** Layer 1c honesty: whether any provider-reported cost has been captured yet (false in Increment A). */
  providerGroundingNote: string;
  note: string;
}

/** One metered key's caps + live/committed state (all committed $0 in Increment A). */
export interface SpendCapRow {
  keyRef: string;
  provider: string;
  door: string;
  lifetimeCapUsd: number;
  dailyCapUsd: number;
  frozen: boolean;
  committedLifetimeUsd: number;
  committedDayUsd: number;
  pctLifetime: number;
  pctDaily: number;
  /** Increment A: every metered door is not-live. */
  goLiveState: 'not-live' | 'live' | 'disarmed';
  meteredLeaseHolder: string | null;
  /** Reporting-vs-ledger reconciliation — trivially ok before there is a ledger. */
  coverageOk: boolean;
}

export interface SpendCapsView {
  keys: SpendCapRow[];
  /** No paid door is live yet in Increment A. */
  meteredLiveYet: boolean;
  /** Paid routing is single-machine until Increment D (availability honesty, C3-2). */
  singleMachineNote: string;
  note: string;
}

/**
 * Default published caps per metered vault key (DISPLAY-ONLY, Increment A). The
 * PIN-only authoritative caps store (`state/routing-spend-caps.json`) is Increment B;
 * until it exists these seed the read-only caps view. Key NAMES only — never a secret.
 */
export const DEFAULT_METERED_CAPS: Readonly<Record<string, { provider: string; lifetimeCapUsd: number; dailyCapUsd: number }>> = {
  metered_gemini_bench: { provider: 'google', lifetimeCapUsd: 40, dailyCapUsd: 15 },
  metered_openrouter_bench: { provider: 'openrouter', lifetimeCapUsd: 60, dailyCapUsd: 25 },
  metered_groq_bench: { provider: 'groq', lifetimeCapUsd: 30, dailyCapUsd: 10 },
};

/** The metered (keyRef → door) pairs actually named by the shipped routing chains. */
export function meteredKeysFromChains(): Array<{ keyRef: string; door: string }> {
  const seen = new Map<string, string>();
  for (const positions of Object.values(NATURE_ROUTING_DEFAULT_CHAINS)) {
    for (const pos of positions) {
      if (pos.keyRef && METERED_ROUTING_DOORS.has(pos.door)) {
        if (!seen.has(pos.keyRef)) seen.set(pos.keyRef, pos.door);
      }
    }
  }
  return Array.from(seen, ([keyRef, door]) => ({ keyRef, door }));
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

/**
 * Map a price basis to a Layer-1c cost basis. Increment A never has provider-reported
 * cost (no metered dispatch → the provider-cost store is empty), so a priced metered row
 * is `internal-derived`, a subscription/CLI row `subscription-zero`, and an unpriceable
 * metered row `unpriced`.
 */
function costBasisFor(priceBasis: PriceBasis): CostBasis {
  if (priceBasis === 'subscription-zero') return 'subscription-zero';
  if (priceBasis === 'no-matching-point') return 'unpriced';
  return 'internal-derived';
}

/** Re-bucket daily buckets into month buckets ('YYYY-MM'); total collapses to one. */
function regrain(buckets: SpendTokenBucket[], grain: SpendGrain): SpendTokenBucket[] {
  if (grain === 'day' || grain === 'hour') return buckets;
  const acc = new Map<string, SpendTokenBucket>();
  for (const b of buckets) {
    const bucket = grain === 'month' ? b.bucket.slice(0, 7) : 'total';
    const key = `${bucket}|${b.door}|${b.modelId}`;
    const cur = acc.get(key);
    if (cur) {
      cur.tokensIn += b.tokensIn;
      cur.tokensOut += b.tokensOut;
      cur.tokensCached += b.tokensCached;
    } else {
      acc.set(key, { ...b, bucket });
    }
  }
  return Array.from(acc.values());
}

export interface BuildSpendSummaryOptions {
  buckets: SpendTokenBucket[];
  prices: RoutingPriceAuthority;
  grain: SpendGrain;
  now: number;
  /** For pricing the token buckets AS-OF each bucket's start time. */
  rollupMaintained: boolean;
  lastReconcileAt: number | null;
  tokenRollupRetentionDays: number;
  /** Machine whose overlay/credits produced the adjustments (pool-merge label). */
  adjustmentsSource?: string | null;
  /**
   * Layer 1c: superseded-resolved daily provider-cost aggregates. Where a
   * (door, modelId) row has provider-reported dollars, the row PREFERS them
   * (`costBasis: 'provider-reported'`, `providerReportedUsd` set) — the
   * read-time expression of "ground on the provider". Absent/empty ⇒ every
   * row stays internal-derived (a labeled, first-class basis).
   */
  providerDaily?: Array<{ day: string; door: string; modelId: string; providerCostUsd: number; reportedCalls: number }>;
  /** Layer 1c: latest signed reconciliation driftPct per door (display-only). */
  driftByDoor?: Record<string, number>;
}

/**
 * Compose the priced spend summary. Buckets are priced AS-OF each bucket's start
 * (so a price change reflows exactly under day-alignment), then aggregated to
 * per-door×model rows. Pure — reads the price authority, writes nothing.
 */
export function buildRoutingSpendSummary(opts: BuildSpendSummaryOptions): SpendSummary {
  const graded = regrain(opts.buckets, opts.grain);
  const rowAcc = new Map<string, SpendSummaryRow>();

  for (const b of graded) {
    // For total-grain the as-of is "now" (a single collapsed bucket has no meaningful
    // per-day price regime); every other grain prices at its own bucket start.
    const asOfMs = opts.grain === 'total' ? opts.now : b.bucketStartMs;
    const res = opts.prices.resolve(b.door, b.modelId, asOfMs);
    const cost = opts.prices.reportingCost(res, b.tokensIn, b.tokensOut, b.tokensCached);
    const key = `${b.door}|${b.modelId}`;
    const row =
      rowAcc.get(key) ??
      ({
        door: b.door,
        modelId: b.modelId,
        doorClass: res.doorClass,
        tokensIn: 0,
        tokensOut: 0,
        tokensCached: 0,
        grossUsd: 0,
        subsidyUsd: 0,
        creditUsd: 0,
        netUsd: 0,
        committedUsd: 0,
        priceBasis: res.priceBasis,
        costBasis: costBasisFor(res.priceBasis),
        providerReportedUsd: null,
        providerDriftPct: null,
        priceStale: res.priceStale,
        notLiveYet: METERED_ROUTING_DOORS.has(b.door as never),
        unpricedTokensIn: 0,
        unpricedTokensOut: 0,
      } as SpendSummaryRow);
    row.tokensIn += b.tokensIn;
    row.tokensOut += b.tokensOut;
    row.tokensCached += b.tokensCached;
    row.grossUsd += cost.grossUsd;
    row.subsidyUsd += cost.subsidyUsd;
    row.unpricedTokensIn += cost.unpricedTokensIn;
    row.unpricedTokensOut += cost.unpricedTokensOut;
    // The row's basis reflects its latest bucket (buckets arrive day-ASC).
    row.priceBasis = res.priceBasis;
    row.costBasis = costBasisFor(res.priceBasis);
    row.priceStale = res.priceStale;
    rowAcc.set(key, row);
  }

  // Layer 1c provider-preferred basis: sum the daily provider aggregates per
  // (door, modelId) and prefer them where present (spec §Layer 2 read contract).
  if (opts.providerDaily && opts.providerDaily.length > 0) {
    const provByRow = new Map<string, number>();
    for (const p of opts.providerDaily) {
      const k = `${p.door}|${p.modelId}`;
      provByRow.set(k, (provByRow.get(k) ?? 0) + p.providerCostUsd);
    }
    for (const [k, usd] of provByRow) {
      const row = rowAcc.get(k);
      if (!row) continue;
      row.providerReportedUsd = Math.round(usd * 1e6) / 1e6;
      row.costBasis = 'provider-reported';
    }
  }
  if (opts.driftByDoor) {
    for (const row of rowAcc.values()) {
      const d = opts.driftByDoor[row.door];
      if (typeof d === 'number' && Number.isFinite(d)) row.providerDriftPct = d;
    }
  }

  const rows = Array.from(rowAcc.values()).map((r) => {
    r.grossUsd = round6(r.grossUsd);
    r.subsidyUsd = round6(r.subsidyUsd);
    r.netUsd = round6(Math.max(0, r.grossUsd - r.subsidyUsd));
    return r;
  });
  rows.sort((a, b) => b.grossUsd - a.grossUsd || b.tokensIn + b.tokensOut - (a.tokensIn + a.tokensOut));

  // Credits are lump-sum per keyRef — applied at the TOTALS level (never per-model).
  let creditTotal = 0;
  for (const { keyRef } of meteredKeysFromChains()) {
    creditTotal += opts.prices.activeCreditUsd(keyRef, opts.now);
  }

  const totals: SpendSummaryTotals = rows.reduce(
    (acc, r) => {
      acc.tokensIn += r.tokensIn;
      acc.tokensOut += r.tokensOut;
      acc.tokensCached += r.tokensCached;
      acc.grossUsd += r.grossUsd;
      acc.subsidyUsd += r.subsidyUsd;
      acc.unpricedTokensIn += r.unpricedTokensIn;
      acc.unpricedTokensOut += r.unpricedTokensOut;
      return acc;
    },
    { tokensIn: 0, tokensOut: 0, tokensCached: 0, grossUsd: 0, subsidyUsd: 0, creditUsd: 0, netUsd: 0, committedUsd: 0, unpricedTokensIn: 0, unpricedTokensOut: 0 },
  );
  totals.grossUsd = round6(totals.grossUsd);
  totals.subsidyUsd = round6(totals.subsidyUsd);
  totals.creditUsd = round6(creditTotal);
  totals.netUsd = round6(Math.max(0, totals.grossUsd - totals.subsidyUsd - totals.creditUsd));

  const horizonNote =
    opts.grain === 'hour'
      ? 'Hourly detail is computed on read from raw rows within the short raw-retention window; hourly beyond that horizon is not offered.'
      : `Total is within the ${opts.tokenRollupRetentionDays}-day rollup horizon (daily/monthly/total survive; hourly does not).`;

  return {
    grain: opts.grain,
    rows,
    totals,
    adjustmentsSource: opts.adjustmentsSource ?? null,
    horizonNote,
    meteredLiveYet: false,
    reportingBasis: {
      source: 'feature_metrics (best-effort token observability)',
      lastReconcileAt: opts.lastReconcileAt ? new Date(opts.lastReconcileAt).toISOString() : null,
      rollupMaintained: opts.rollupMaintained,
      note:
        'REPORTING net (recomputed at current price, net of credits) — best-effort and recomputable. ' +
        'The caps surface’s committed figure is the number a cap enforces (Increment B).',
    },
    providerGroundingNote:
      'No provider-reported cost captured yet (Layer 1c): metered dispatch is not wired, so every dollar figure ' +
      'is internal-derived from token counts × the reviewed price. Provider-grounded cost (costBasis: provider-reported) ' +
      'begins once the metered capture seam has data.',
    note:
      'Read-only spend VIEW (Increment A): immutable token rollup priced on read. No paid door is live yet — ' +
      'metered spend is $0. Subscription/CLI doors are $0 (not per-token billed). Money caps + gate are Increment B.',
  };
}

export interface BuildSpendCapsOptions {
  /** Optional PIN-store caps override (Increment B). Absent in A → published defaults. */
  capsOverride?: Record<string, { provider?: string; lifetimeCapUsd?: number; dailyCapUsd?: number; frozen?: boolean; goLiveState?: SpendCapRow['goLiveState']; meteredLeaseHolder?: string | null }>;
  /** Committed totals from the MeteredSpendLedger (Increment B). Absent → $0 (pre-B honest state). */
  committed?: Record<string, { committedLifetimeUsd: number; committedDayUsd: number }>;
  /** True once the money layer is enabled (Increment B) — flips the caps-view notes. */
  moneyLive?: boolean;
}

/**
 * Compose the caps view: every metered key named by the routing chains, its caps, and
 * honest committed state. Pre-B (no money ledger) committed is $0 and every door is
 * not-live; with the Increment-B money layer live the committed figures come from the
 * authoritative ledger fold. Pure.
 */
export function buildRoutingSpendCaps(opts: BuildSpendCapsOptions = {}): SpendCapsView {
  const keys: SpendCapRow[] = meteredKeysFromChains().map(({ keyRef, door }) => {
    const def = DEFAULT_METERED_CAPS[keyRef];
    const ov = opts.capsOverride?.[keyRef];
    const lifetimeCapUsd = ov?.lifetimeCapUsd ?? def?.lifetimeCapUsd ?? 0;
    const dailyCapUsd = ov?.dailyCapUsd ?? def?.dailyCapUsd ?? 0;
    const committed = opts.committed?.[keyRef];
    const committedLifetimeUsd = committed?.committedLifetimeUsd ?? 0;
    const committedDayUsd = committed?.committedDayUsd ?? 0;
    return {
      keyRef,
      provider: ov?.provider ?? def?.provider ?? 'unknown',
      door,
      lifetimeCapUsd,
      dailyCapUsd,
      frozen: ov?.frozen ?? false,
      committedLifetimeUsd,
      committedDayUsd,
      pctLifetime: lifetimeCapUsd > 0 ? Math.round((committedLifetimeUsd / lifetimeCapUsd) * 1000) / 10 : 0,
      pctDaily: dailyCapUsd > 0 ? Math.round((committedDayUsd / dailyCapUsd) * 1000) / 10 : 0,
      goLiveState: ov?.goLiveState ?? 'not-live',
      meteredLeaseHolder: ov?.meteredLeaseHolder ?? null,
      coverageOk: true,
    };
  });
  const anyLive = keys.some((k) => k.goLiveState === 'live');
  return {
    keys,
    meteredLiveYet: anyLive,
    singleMachineNote:
      'Paid routing is single-machine until Increment D — the money gate is single-writer; ' +
      'a single PIN-designated metered-lease machine holds the cap.',
    note: opts.moneyLive
      ? 'Caps view (Increment B): committed figures are the GATE-enforced booked-at-time-of-use totals from the ' +
        'authoritative money ledger. Adjust/arm via the PIN-gated plan flow; freeze is Bearer (instant).'
      : 'Read-only caps VIEW (Increment A): every metered key with its published caps. No paid door is live yet, ' +
        'so committed spend is $0 everywhere. Cap ADJUST + go-live (PIN-gated) are Increment B.',
  };
}
