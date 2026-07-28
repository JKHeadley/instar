/**
 * dashboardInsightCollectors — the built-in page collectors for the
 * DashboardInsightEngine (docs/specs/dashboard-live-insights.md §1/§5.1).
 *
 * Each collector reads an EXISTING in-process source and returns the engine's
 * bounded, normalized PageDataSnapshot. Collectors are the ONLY place the engine
 * touches a subsystem — the engine itself is decoupled + testable over the
 * snapshot shape.
 *
 * FIRST SHIP wires the LLM Activity collector: it is the spec's motivating
 * example — the raw "~732 errors" headline (which conflates mesh-probe noise with
 * one real routing issue) becomes a meaningful, actionable insight ("routing is
 * healthy; one check is failing X% and is worth a look"). Additional page
 * collectors (Spend, Machines, Sessions, Attention) are a tracked follow-up — the
 * engine + route + UI are page-generic, so each is a small additive collector.
 */

import type { FeatureMetricsLedger } from './FeatureMetricsLedger.js';
import type { InsightPage, PageDataSnapshot, InsightAnomaly, InsightMetric } from './DashboardInsightEngine.js';

/** Error-rate at which a feature is worth flagging (of its REAL round-trips). */
const ERROR_RATE_WATCH = 0.15;
const ERROR_RATE_ALERT = 0.4;
/** Minimum real calls before an error-rate is statistically meaningful. */
const MIN_REAL_CALLS = 5;

/**
 * The LLM Activity page collector — reads the per-feature metrics ledger and
 * distills genuine LLM-routing health (separating real routing errors from noise
 * by requiring a meaningful call volume before flagging, spec §5.1).
 */
export function buildLlmActivityCollector(ledger: FeatureMetricsLedger): () => PageDataSnapshot {
  return () => {
    const summary = ledger.summary({ sinceHours: 24 });
    const features = summary.features ?? [];
    let totalReal = 0;
    let totalErrors = 0;
    let busiest: { feature: string; realCalls: number } | null = null;
    const anomalies: InsightAnomaly[] = [];

    for (const f of features) {
      totalReal += f.realCalls;
      totalErrors += f.errors;
      if (!busiest || f.realCalls > busiest.realCalls) busiest = { feature: f.feature, realCalls: f.realCalls };
      if (f.realCalls >= MIN_REAL_CALLS && f.errors > 0) {
        const rate = f.errors / f.realCalls;
        if (rate >= ERROR_RATE_WATCH) {
          anomalies.push({
            text: `${f.feature} is failing ${Math.round(rate * 100)}% of the time (${f.errors} of ${f.realCalls} calls).`,
            severity: rate >= ERROR_RATE_ALERT ? 'alert' : 'watch',
          });
        }
      }
    }
    anomalies.sort((a, b) => (b.severity === 'alert' ? 1 : 0) - (a.severity === 'alert' ? 1 : 0));

    // MIN_REAL_CALLS is declared at the top of this file as "minimum real calls
    // before an error-rate is statistically meaningful" and the per-feature loop
    // above honours it. The AGGREGATE did not: with zero calls it rendered
    // `Error rate: 0%` and asserted "Routing is healthy — 0 checks ran", so an
    // empty 24 hours was indistinguishable from a clean one. Same file, same
    // constant, same reasoning — just applied to the aggregate too.
    const overallErrorRate = totalReal > 0 ? totalErrors / totalReal : null;
    const metrics: InsightMetric[] = [
      { label: 'LLM calls (24h)', value: String(totalReal) },
      { label: 'Errors (24h)', value: String(totalErrors) },
      {
        label: 'Error rate',
        // A rate over zero calls is not a rate. Show why it is absent, not a "0%"
        // a reader cannot tell from a measured zero.
        value: overallErrorRate === null ? 'no calls yet' : `${Math.round(overallErrorRate * 100)}%`,
      },
      { label: 'Checks active', value: String(features.length) },
    ];
    const facts: string[] = [];
    // Order matters, and BAD NEWS COMES FIRST unconditionally. Today an anomaly
    // cannot occur below the floor (a feature needs >= MIN_REAL_CALLS to flag, so
    // totalReal < MIN_REAL_CALLS implies none), but that is an arithmetic
    // coincidence rather than a guarantee — if the constants ever diverge, a
    // low-volume window must still surface a real failure. The floor gates only
    // the reassuring conclusion, never a warning.
    if (anomalies.length > 0) {
      facts.push(`${anomalies.length} check${anomalies.length === 1 ? '' : 's'} ${anomalies.length === 1 ? 'is' : 'are'} failing more than usual and worth a look.`);
    } else if (totalReal === 0) {
      // Nothing ran. Say so, rather than claiming health from an empty window.
      facts.push(
        features.length === 0
          ? 'No checks have reported in the last 24 hours, so there is nothing to judge yet.'
          : `${features.length} check${features.length === 1 ? '' : 's'} are configured but none made a call in the last 24 hours, so there is nothing to judge yet.`,
      );
    } else if (totalReal < MIN_REAL_CALLS) {
      // The rate above is real data, but the volume is too low to call it healthy —
      // the same asymmetry the per-feature loop already applies.
      facts.push(
        `Only ${totalReal} call${totalReal === 1 ? '' : 's'} in the last 24 hours — too few to say whether routing is healthy.`,
      );
    } else {
      facts.push(`Routing is healthy — ${features.length} checks ran with no check failing a meaningful share of its calls.`);
    }
    if (busiest && busiest.realCalls > 0) facts.push(`The busiest check is ${busiest.feature} (${busiest.realCalls} calls in 24h).`);

    return { facts, metrics, anomalies, updatedAt: Date.now() };
  };
}

/**
 * Assemble the built-in page registry from whatever sources are wired. A page is
 * registered ONLY when its source exists — so a null ledger simply omits the LLM
 * Activity page (honest; the engine renders an empty index rather than a fake
 * page). Returns [] when no source is available.
 */
export function buildBuiltinInsightPages(deps: {
  featureMetricsLedger?: FeatureMetricsLedger | null;
}): InsightPage[] {
  const pages: InsightPage[] = [];
  if (deps.featureMetricsLedger) {
    pages.push({
      id: 'llm-activity',
      title: 'LLM Activity',
      tab: 'llm-activity',
      collect: buildLlmActivityCollector(deps.featureMetricsLedger),
    });
  }
  return pages;
}
