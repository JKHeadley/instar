/**
 * FailureAnalyzer — the pattern layer (spec §4.4).
 *
 * Deterministic core: groups attributed failures by category, and emits an
 * InsightRecord only when a cluster crosses the support + SOURCE-DIVERSITY gate
 * (≥ minSupport records AND ≥ minDistinctSessions distinct filers AND
 * ≥ minDistinctCauseCommits distinct cause-commits). The diversity gate is what
 * stops a single misbehaving session — or a flaky/flapping source — from
 * manufacturing a "pattern" (§4.4 M4/M5). Diversity is computed conservatively
 * from the deduped records (one filer/cause per dedupeKey), so it UNDERcounts —
 * biasing toward NOT firing, which is the safe direction for a process-change
 * recommendation.
 *
 * Recommendations are TEMPLATE-KEYED on the detected category (spec §4.4 / BL-3):
 * never free-LLM prose piped into an auto-opened item. The §4.4 Tier-1 LLM
 * supervisor (declared on the analyzer job) sanity-checks the rendered finding
 * before any push surface; this module is the deterministic substrate it wraps.
 *
 * Signal-only: discovers + records insights; it never opens tracked items,
 * blocks, or grades. The closed-loop step is the FailureLoopDriver.
 */
import type { FailureLedger, FailureRecord, FailureCategory, InsightRecord } from './FailureLedger.js';

export interface AnalyzerGates {
  minSupport: number;
  minDistinctSessions: number;
  minDistinctCauseCommits: number;
  /** Only consider failures within this many days (0/undefined = all). */
  windowDays?: number;
}

export const DEFAULT_GATES: AnalyzerGates = {
  minSupport: 4,
  minDistinctSessions: 3,
  minDistinctCauseCommits: 3,
};

/** Template recommendations keyed on category — NOT free LLM text (§4.4 / BL-3). */
const RECOMMENDATION_BY_CATEGORY: Record<FailureCategory, string> = {
  concurrency: 'Recurring concurrency failures — give the adversarial review pass a concurrency/race checklist and require a concurrent-path test.',
  'config-parse': 'Recurring config-parse failures — add a config-schema validation gate to the build skill before merge.',
  wiring: 'Recurring wiring failures — require a wiring-integrity test (assert the component is constructed AND started) for every dependency-injected feature.',
  logic: 'Recurring logic failures — strengthen the both-sides-of-the-boundary test requirement in the spec review.',
  migration: 'Recurring migration failures — add a migration-parity check (existing-agent path) to the review checklist.',
  'test-gap': 'Recurring test-gap failures — require the 3-tier test set (incl. the production storage path) before merge.',
  unknown: 'Recurring uncategorized failures — improve the failure-categorization step so these become actionable.',
};

export interface AnalyzeResult {
  insightsDiscovered: InsightRecord[];
  clustersConsidered: number;
  clustersBelowThreshold: number;
}

export class FailureAnalyzer {
  constructor(private readonly ledger: FailureLedger, private readonly gates: AnalyzerGates = DEFAULT_GATES) {}

  /**
   * Scan attributed failures, detect category clusters that cross the gate, and
   * upsert an InsightRecord for each. Returns the insights touched. Re-running
   * is idempotent (upsert on a content-stable identityKey).
   */
  analyze(): AnalyzeResult {
    const sinceMs = this.gates.windowDays && this.gates.windowDays > 0
      ? Date.now() - this.gates.windowDays * 86400_000
      : undefined;
    // Only attributed records feed a process-change recommendation (§4.3): a
    // guess (`inferred`) is excluded until confirmed.
    const records = this.ledger
      .list({ sinceMs, limit: 1000 })
      .filter((r) => r.attribution === 'automatic' || r.attribution === 'one-tap');

    const byCategory = new Map<FailureCategory, FailureRecord[]>();
    for (const r of records) {
      const arr = byCategory.get(r.category) ?? [];
      arr.push(r);
      byCategory.set(r.category, arr);
    }

    const discovered: InsightRecord[] = [];
    let belowThreshold = 0;
    for (const [category, cluster] of byCategory) {
      if (category === 'unknown') continue; // unknown is a coverage signal, not a pattern
      const distinctSessions = new Set(cluster.map((r) => r.filedBy)).size;
      const distinctCauseCommits = new Set(cluster.map((r) => r.causeCommitOid ?? r.id)).size;
      const crosses =
        cluster.length >= this.gates.minSupport &&
        distinctSessions >= this.gates.minDistinctSessions &&
        distinctCauseCommits >= this.gates.minDistinctCauseCommits;
      if (!crosses) { belowThreshold++; continue; }

      const insight = this.ledger.upsertInsight({
        identityKey: `category:${category}`,
        summary: `${cluster.length} attributed ${category} failures across ${distinctSessions} sessions / ${distinctCauseCommits} cause-commits`,
        recommendation: RECOMMENDATION_BY_CATEGORY[category],
        supportingFailureIds: cluster.map((r) => r.id),
        distinctSessions,
        distinctCauseCommits,
        targetCategory: category,
        baselineRate: cluster.length,
      });
      if (insight) discovered.push(insight);
    }

    return {
      insightsDiscovered: discovered,
      clustersConsidered: byCategory.size,
      clustersBelowThreshold: belowThreshold,
    };
  }
}
