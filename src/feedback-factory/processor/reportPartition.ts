/**
 * reportPartition.ts — TS port of scar (d): lifecycle partitioning + re-report
 * (cycling) prevention for the operator digest.
 *
 * Ports the pure partition decision from the report-generation function (:2747) of
 * the reference `the-portal/.claude/scripts/feedback-processor.py` — the half of
 * scar (d) that complements the cluster-level cycling detection already ported in
 * transitions.ts. Given the current clusters + what was surfaced in the LAST
 * operator report, it decides what is actionable now: newly-open vs already-known
 * issues, the same for investigating, and items FIXED since the last report that
 * haven't been announced before (the re-report/cycling guard — a fix is announced
 * once, never again). It also decides whether the whole report should be skipped
 * (nothing new ⇒ no noise).
 *
 * Pure: the clusters, the previous-report state, and `now` are injected (the real
 * reporter does the DB query + state load + Telegram render around this). `now` is
 * an ISO string. Equivalence is by faithful transcription + both-sides-of-boundary
 * unit tests (the decision is embedded in a Telegram-rendering function in the
 * reference, so there is no clean isolated function for a cross-runtime harness).
 */

import type { Cluster } from './types.js';

export interface PreviousReportState {
  lastReportAt?: string;
  reportedOpenIds?: string[];
  reportedInvestigatingIds?: string[];
  reportedFixedIds?: string[];
}

export interface ReportPartition {
  newIssues: Cluster[];
  continuingOpen: Cluster[];
  newInvestigating: Cluster[];
  continuingInvestigating: Cluster[];
  fixedNew: Cluster[];
  /** True when there is nothing new to report (report should be skipped to avoid noise). */
  shouldSkip: boolean;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

function bySeverity(a: Cluster, b: Cluster): number {
  const sa = SEVERITY_ORDER[(a.severity as string) ?? ''] ?? 9;
  const sb = SEVERITY_ORDER[(b.severity as string) ?? ''] ?? 9;
  return sa - sb;
}

/**
 * Partition clusters for an operator report. `now` (ISO) is used only for the
 * first-run window (no prior report → items fixed in the last 4h).
 */
export function partitionClustersForReport(
  clusters: Cluster[],
  prev: PreviousReportState,
  now: string,
): ReportPartition {
  const prevOpen = new Set(prev.reportedOpenIds ?? []);
  const prevInvestigating = new Set(prev.reportedInvestigatingIds ?? []);
  const prevFixed = new Set(prev.reportedFixedIds ?? []);
  const lastReportTime = prev.lastReportAt ?? '';

  const allOpen = clusters.filter((c) => c.status === 'open');
  const allInvestigating = clusters.filter((c) => c.status === 'investigating');

  const newIssues = allOpen.filter((c) => !prevOpen.has(c.clusterId)).sort(bySeverity);
  const continuingOpen = allOpen.filter((c) => prevOpen.has(c.clusterId));
  const newInvestigating = allInvestigating.filter((c) => !prevInvestigating.has(c.clusterId)).sort(bySeverity);
  const continuingInvestigating = allInvestigating.filter((c) => prevInvestigating.has(c.clusterId));

  // Fixed since the last report AND not announced before — the re-report guard.
  let cutoff: string;
  if (lastReportTime) {
    cutoff = lastReportTime;
  } else {
    // First run ever — only items fixed in the last 4 hours.
    cutoff = new Date(new Date(now).getTime() - 4 * 60 * 60 * 1000).toISOString();
  }
  const fixedNew = clusters.filter(
    (c) => c.status === 'fixed' && String(c.updatedAt ?? '') > cutoff && !prevFixed.has(c.clusterId),
  );

  const shouldSkip = newIssues.length === 0 && newInvestigating.length === 0 && fixedNew.length === 0;

  return { newIssues, continuingOpen, newInvestigating, continuingInvestigating, fixedNew, shouldSkip };
}
