/**
 * OrgIntentDriftAnalyzer — Phase 4 of the ORG-INTENT runtime project.
 *
 * Samples recent Coherence Gate review history and emits a drift digest:
 * which reviewer dimensions are flagging most, whether the trend is rising
 * or falling between the two halves of the lookback window, which ORG-INTENT
 * constraints are most frequently being approached, and a single overall
 * trend label.
 *
 * SIGNAL only — never blocks anything. The Coherence Gate from Phase 1
 * remains the authority for any actual message-review decision. This module
 * exists to surface accumulated patterns that no single review verdict
 * could catch on its own — the Klarna failure mode early-warning surface.
 *
 * Deterministic pure logic. No LLM call. Given the same input it always
 * produces the same output.
 */

import type { ParsedOrgIntent } from './OrgIntentManager.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Minimal shape of a review history entry the analyzer needs. Subset of
 * CoherenceGate's AuditLogEntry — keeps the analyzer decoupled from the
 * gate's internal types so it can be reused for offline analysis.
 */
export interface DriftReviewEntry {
  /** ISO-8601 timestamp string. */
  timestamp: string;
  /** Outcome verdict — e.g. 'pass', 'block', 'hold', 'pass-warn'. */
  verdict: string;
  /** Per-reviewer violations from this entry. */
  violations: Array<{
    reviewer: string;
    severity: 'block' | 'warn';
    issue: string;
  }>;
}

export interface DriftAnalysisInput {
  /** Review history entries (already filtered to the analysis window by caller). */
  entries: DriftReviewEntry[];
  /** Parsed ORG-INTENT.md, or null if absent. */
  orgIntent: ParsedOrgIntent | null;
  /** Lookback window in days, used for output framing only. */
  lookbackDays?: number;
  /** Sensitivity controls. */
  thresholds?: {
    /** Block-rate threshold (fraction) for 'concerning' verdict. Default 0.15. */
    concerningBlockRate?: number;
    /** Block-rate threshold (fraction) for 'rising' verdict. Default 0.05. */
    risingBlockRate?: number;
    /** Minimum entries before reporting a trend. Below this, returns 'insufficient-data'. */
    minEntries?: number;
  };
}

export interface ReviewerStats {
  reviewer: string;
  total: number;
  blocks: number;
  warns: number;
  blockRate: number;
}

export interface DriftAnalysis {
  /** Overall trend label. */
  trend: 'stable' | 'rising' | 'concerning' | 'insufficient-data' | 'no-org-intent';
  /** Window stats. */
  windowDays: number;
  totalEntries: number;
  blockedEntries: number;
  overallBlockRate: number;
  /** Half-window comparison: first half vs second half block rates. */
  firstHalfBlockRate: number;
  secondHalfBlockRate: number;
  /** Per-reviewer breakdown. */
  perReviewer: ReviewerStats[];
  /** Reviewer dimensions flagged as drifting (top N by block count). */
  flaggedDimensions: string[];
  /** Mapped to ORG-INTENT bucket counts. */
  constraintMatches: number;
  goalMatches: number;
  valueMatches: number;
  /** Human-readable summary suitable for a Telegram digest. */
  summary: string;
  /** Suggested next actions for the user / agent. */
  suggestions: string[];
  /** True when caller should surface this digest (trend != 'stable' && != 'insufficient-data' && != 'no-org-intent'). */
  shouldSurface: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = {
  concerningBlockRate: 0.15,
  risingBlockRate: 0.05,
  minEntries: 5,
};

// ── Main analyzer ────────────────────────────────────────────────────

export function analyzeOrgIntentDrift(input: DriftAnalysisInput): DriftAnalysis {
  const { entries, orgIntent, lookbackDays = 7 } = input;
  const t = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };

  // No ORG-INTENT.md → analyzer has nothing to compare against.
  if (!orgIntent) {
    return {
      trend: 'no-org-intent',
      windowDays: lookbackDays,
      totalEntries: entries.length,
      blockedEntries: 0,
      overallBlockRate: 0,
      firstHalfBlockRate: 0,
      secondHalfBlockRate: 0,
      perReviewer: [],
      flaggedDimensions: [],
      constraintMatches: 0,
      goalMatches: 0,
      valueMatches: 0,
      summary: 'No ORG-INTENT.md found. Drift analysis requires an organizational intent file to compare behavior against.',
      suggestions: [
        'Scaffold a starter with: instar intent org-init "Your Org Name"',
        'Then re-run this audit to surface accumulated drift.',
      ],
      shouldSurface: false,
    };
  }

  // Insufficient data → can't reliably detect trends with too few samples.
  if (entries.length < t.minEntries) {
    return {
      trend: 'insufficient-data',
      windowDays: lookbackDays,
      totalEntries: entries.length,
      blockedEntries: 0,
      overallBlockRate: 0,
      firstHalfBlockRate: 0,
      secondHalfBlockRate: 0,
      perReviewer: [],
      flaggedDimensions: [],
      constraintMatches: 0,
      goalMatches: 0,
      valueMatches: 0,
      summary: `Only ${entries.length} review entries in the last ${lookbackDays} days — not enough data to surface a drift trend (need ≥${t.minEntries}).`,
      suggestions: [],
      shouldSurface: false,
    };
  }

  // Sort by timestamp ascending so first-half / second-half halves are chronological.
  const sorted = [...entries].sort((a, b) =>
    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
  );
  const mid = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, mid);
  const secondHalf = sorted.slice(mid);

  // Compute overall block rate
  const isBlock = (e: DriftReviewEntry) =>
    e.verdict.includes('block') || e.verdict.includes('hold');
  const blockedEntries = sorted.filter(isBlock).length;
  const overallBlockRate = sorted.length > 0 ? blockedEntries / sorted.length : 0;
  const firstHalfBlocked = firstHalf.filter(isBlock).length;
  const secondHalfBlocked = secondHalf.filter(isBlock).length;
  const firstHalfBlockRate = firstHalf.length > 0 ? firstHalfBlocked / firstHalf.length : 0;
  const secondHalfBlockRate = secondHalf.length > 0 ? secondHalfBlocked / secondHalf.length : 0;

  // Per-reviewer stats
  const reviewerMap = new Map<string, { total: number; blocks: number; warns: number }>();
  for (const e of sorted) {
    for (const v of e.violations) {
      const cur = reviewerMap.get(v.reviewer) ?? { total: 0, blocks: 0, warns: 0 };
      cur.total++;
      if (v.severity === 'block') cur.blocks++;
      else cur.warns++;
      reviewerMap.set(v.reviewer, cur);
    }
  }
  const perReviewer: ReviewerStats[] = [...reviewerMap.entries()]
    .map(([reviewer, c]) => ({
      reviewer,
      total: c.total,
      blocks: c.blocks,
      warns: c.warns,
      blockRate: c.total > 0 ? c.blocks / c.total : 0,
    }))
    .sort((a, b) => b.blocks - a.blocks);

  // Flag dimensions with notable block counts (top 3 by blocks, blocks > 0)
  const flaggedDimensions = perReviewer
    .filter(r => r.blocks > 0)
    .slice(0, 3)
    .map(r => r.reviewer);

  // Cross-reference with ORG-INTENT buckets — count how many violations mention
  // a constraint / goal / value substring. Heuristic but useful for narrative.
  let constraintMatches = 0;
  let goalMatches = 0;
  let valueMatches = 0;
  for (const e of sorted) {
    for (const v of e.violations) {
      const issueLower = (v.issue || '').toLowerCase();
      for (const c of orgIntent.constraints) {
        if (issueLower.includes(c.text.toLowerCase().slice(0, 20))) {
          constraintMatches++;
          break;
        }
      }
      for (const g of orgIntent.goals) {
        if (issueLower.includes(g.text.toLowerCase().slice(0, 20))) {
          goalMatches++;
          break;
        }
      }
      for (const val of orgIntent.values) {
        if (issueLower.includes(val.toLowerCase().slice(0, 20))) {
          valueMatches++;
          break;
        }
      }
    }
  }

  // Determine overall trend.
  let trend: DriftAnalysis['trend'] = 'stable';
  if (overallBlockRate >= t.concerningBlockRate) {
    trend = 'concerning';
  } else if (
    secondHalfBlockRate > firstHalfBlockRate + t.risingBlockRate
    && secondHalfBlockRate >= t.risingBlockRate
  ) {
    trend = 'rising';
  }

  // Compose summary + suggestions
  const summaryLines: string[] = [];
  if (trend === 'concerning') {
    summaryLines.push(`Block rate of ${(overallBlockRate * 100).toFixed(1)}% across ${sorted.length} reviews in the last ${lookbackDays} days is above the concerning threshold (${(t.concerningBlockRate * 100).toFixed(0)}%).`);
    summaryLines.push(`Most-flagged reviewers: ${flaggedDimensions.join(', ') || '(none)'}.`);
    if (constraintMatches > 0) {
      summaryLines.push(`${constraintMatches} flagged review(s) mentioned an ORG-INTENT constraint by name.`);
    }
  } else if (trend === 'rising') {
    summaryLines.push(`Block rate trending up: first half ${(firstHalfBlockRate * 100).toFixed(1)}% → second half ${(secondHalfBlockRate * 100).toFixed(1)}% over ${sorted.length} reviews in the last ${lookbackDays} days.`);
    summaryLines.push(`Most-flagged reviewers: ${flaggedDimensions.join(', ') || '(none)'}.`);
  } else {
    summaryLines.push(`Block rate stable at ${(overallBlockRate * 100).toFixed(1)}% across ${sorted.length} reviews in the last ${lookbackDays} days. No drift surfaced.`);
  }
  const summary = summaryLines.join(' ');

  const suggestions: string[] = [];
  if (trend === 'concerning' || trend === 'rising') {
    suggestions.push(`Review the most-flagged reviewer dimension (${flaggedDimensions[0] ?? 'value-alignment'}) for recent issues — recent blocks tend to cluster by category.`);
    if (orgIntent.constraints.length > 0) {
      suggestions.push('Re-read .instar/ORG-INTENT.md constraints; consider whether any need to be tightened, loosened, or scoped to specific channels.');
    }
    suggestions.push('Check the canonical state for any recent context changes that might explain a sudden drift (deployments, user-facing changes, autonomy profile shifts).');
  }

  return {
    trend,
    windowDays: lookbackDays,
    totalEntries: sorted.length,
    blockedEntries,
    overallBlockRate,
    firstHalfBlockRate,
    secondHalfBlockRate,
    perReviewer,
    flaggedDimensions,
    constraintMatches,
    goalMatches,
    valueMatches,
    summary,
    suggestions,
    shouldSurface: trend === 'concerning' || trend === 'rising',
  };
}
