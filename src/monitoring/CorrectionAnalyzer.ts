/**
 * CorrectionAnalyzer — the recurrence layer (spec §3.5).
 *
 * Deterministic core: groups similar open records of the SAME kind, then decides
 * whether each cluster crosses the THREE-PRONGED AND recurrence gate:
 *
 *   minSupport         AND
 *   minDistinctDays    AND   (restart-proof calendar-day durability)
 *   second orthogonal prong:
 *     - user-preference → minDistinctSessions ≥ 2
 *     - infra-gap       → cross-agent Rising Tide consensus (delegated to the
 *                         existing /feedback clustering — single-agent never
 *                         auto-propagates to the fleet; that is the second
 *                         consensus layer)
 *
 * Code-determined provenance filter (poison resistance, spec §3.5): a record
 * counts toward the gate ONLY when its qualifying occurrences (those with
 * deterministicWeight ≥ DETERMINISTIC_THRESHOLD) satisfy the prongs.
 * `llm_confidence` is ADVISORY and never alone admits a record — the gate keys
 * on a CODE-determined field an injected prompt cannot steer.
 *
 * Signal-only: this module decides gate-crossing + returns the verdicts. It does
 * NOT route, write preferences, POST feedback, or mutate authority — that is the
 * CorrectionLoopDriver's job (which is itself by-construction authority-bounded).
 */
import { CorrectionLedger, type CorrectionRecord } from './CorrectionLedger.js';
import { LEARNING_DETERMINISTIC_THRESHOLD } from './HumanAsDetectorLog.js';
import type { GroupingReport, JevCorrectionGrouper, SameMeaning } from '../core/JevCorrectionGrouping.js';

export interface CorrectionGates {
  minSupport: number;
  minDistinctDaysInfraGap: number;
  minDistinctDaysPreference: number;
  minDistinctSessionsPreference: number;
  /** Same-kind normalized-token Jaccard floor for analyzer-time grouping. */
  similarityThreshold?: number;
  /** Only consider records within this many days (0/undefined = all). */
  windowDays?: number;
  /** Layer-0 weight a record's occurrences must reach to COUNT toward the gate. */
  deterministicThreshold?: number;
}

export const DEFAULT_CORRECTION_GATES: CorrectionGates = {
  minSupport: 4,
  minDistinctDaysInfraGap: 3,
  minDistinctDaysPreference: 2,
  minDistinctSessionsPreference: 2,
  deterministicThreshold: LEARNING_DETERMINISTIC_THRESHOLD,
};

/**
 * Selected from the 2026-07-30 live 37-record corpus. Complete-link grouping
 * requires every pair in a cluster to meet this floor; unlike connected-
 * component/single-link grouping, a chain of partial overlaps cannot merge
 * distant learnings. The corpus calibration and excluded-edge measurements are
 * in docs/measurements/2026-07-30-correction-promotion-threshold.md.
 */
export const DEFAULT_CORRECTION_SIMILARITY_THRESHOLD = 0.65;

/** Per-cluster gate verdict — the analyzer's output. */
export interface GateVerdict {
  /** Stable representative: earliest record in the cluster. */
  record: CorrectionRecord;
  /** Every open record whose key contributed evidence to this verdict. */
  clusterRecords: CorrectionRecord[];
  clusterDedupeKeys: string[];
  crosses: boolean;
  /** Why it did/didn't cross — for audit + the Tier-1 supervisor. */
  reason: string;
  qualifyingOccurrences: number;
  distinctDays: number;
  distinctSessions: number;
  /** Retained as observability only; topic diversity no longer gates promotion. */
  distinctTopics: number;
}

export interface CorrectionAnalyzeResult {
  verdicts: GateVerdict[];
  crossed: GateVerdict[];
  considered: number;
  belowThreshold: number;
}

export function learningTokenSet(learning: string): Set<string> {
  const normalized = CorrectionLedger.normalizeLearning(learning);
  return new Set(normalized ? normalized.split(' ') : []);
}

/** Normalized-token Jaccard. Empty learnings carry no similarity evidence. */
export function correctionLearningSimilarity(a: string, b: string): number {
  const left = learningTokenSet(a);
  const right = learningTokenSet(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection++;
  }
  return intersection / (left.size + right.size - intersection);
}

/**
 * Deterministic complete-link clustering over analyzer-time records. Records
 * are considered in stable creation order and may join a cluster only when
 * they have an edge to EVERY existing member. An edge is word overlap at the
 * floor, OR (when supplied) a "same standing preference" meaning verdict from
 * the JevCorrectionGrouper. This bounded-diameter posture deliberately rejects
 * A~B~C bridges when A!~C, whichever source each edge came from. Stored record
 * identity is never rewritten; dedupeKey remains exact.
 */
export function clusterCorrectionRecords(
  records: readonly CorrectionRecord[],
  similarityThreshold = DEFAULT_CORRECTION_SIMILARITY_THRESHOLD,
  sameMeaning: SameMeaning | null = null,
): CorrectionRecord[][] {
  const threshold = Math.max(0, Math.min(1, similarityThreshold));
  const clusters: CorrectionRecord[][] = [];
  const ordered = [...records].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  for (const candidate of ordered) {
    const compatible = clusters.find((cluster) =>
      cluster[0].kind === candidate.kind
      && cluster.every((member) =>
        correctionLearningSimilarity(member.learning, candidate.learning) >= threshold
        || (sameMeaning !== null && sameMeaning(member, candidate))));
    if (compatible) {
      compatible.push(candidate);
    } else {
      clusters.push([candidate]);
    }
  }

  return clusters;
}

export class CorrectionAnalyzer {
  /** Meaning edges from the last refreshMeaningGrouping(); null = word overlap only. */
  private sameMeaning: SameMeaning | null = null;

  constructor(
    private readonly ledger: CorrectionLedger,
    private readonly gates: CorrectionGates = DEFAULT_CORRECTION_GATES,
    private readonly grouper: JevCorrectionGrouper | null = null,
  ) {}

  private openRecords(): CorrectionRecord[] {
    const sinceMs = this.gates.windowDays && this.gates.windowDays > 0
      ? Date.now() - this.gates.windowDays * 86400_000
      : undefined;
    return this.ledger
      .list({ sinceMs, status: 'open', limit: 1000 })
      .filter((r) => r.kind !== 'noise');
  }

  /**
   * Ask the grouper about every candidate pair of the current open records
   * (cached verdicts are reused) and use its "same preference" edges in the
   * next analyze(). Without a grouper, or when it is off/unavailable, analyze()
   * keeps the word-overlap rule alone. Never throws.
   */
  async refreshMeaningGrouping(): Promise<GroupingReport | null> {
    if (!this.grouper) return null;
    const prepared = await this.grouper.prepare(this.openRecords(), learningTokenSet);
    this.sameMeaning = prepared.sameMeaning;
    return prepared.report;
  }

  /** Use only already-cached meaning verdicts (no calls). For read surfaces. */
  useCachedMeaningGrouping(): void {
    this.sameMeaning = this.grouper ? this.grouper.cachedLookup() : null;
  }

  /** The current same-kind groups of open records, largest first. Pure read. */
  groups(): CorrectionRecord[][] {
    return clusterCorrectionRecords(
      this.openRecords(),
      this.gates.similarityThreshold ?? DEFAULT_CORRECTION_SIMILARITY_THRESHOLD,
      this.sameMeaning,
    ).sort((a, b) => b.length - a.length);
  }

  /**
   * Evaluate the recurrence gate against same-kind clusters of `open` records.
   * Returns one verdict per cluster so one family can route at most once per
   * tick. Pure read — never mutates the ledger (the driver acts on these).
   * `noise`-kind records are never gate-considered.
   */
  analyze(): CorrectionAnalyzeResult {
    const threshold = this.gates.deterministicThreshold ?? LEARNING_DETERMINISTIC_THRESHOLD;

    const records = this.openRecords();
    const clusters = clusterCorrectionRecords(
      records,
      this.gates.similarityThreshold ?? DEFAULT_CORRECTION_SIMILARITY_THRESHOLD,
      this.sameMeaning,
    );

    const verdicts: GateVerdict[] = [];
    let below = 0;
    for (const clusterRecords of clusters) {
      const rec = clusterRecords[0];
      const clusterDedupeKeys = clusterRecords.map((record) => record.dedupeKey);
      // Code-determined provenance filter: only occurrences whose Layer-0 weight
      // crossed the threshold count toward the gate.
      const counts = this.ledger.distinctCounts(clusterDedupeKeys, threshold);
      const supportOk = counts.qualifyingOccurrences >= this.gates.minSupport;

      let crosses = false;
      let reason: string;
      if (rec.kind === 'user-preference') {
        const daysOk = counts.distinctDays >= this.gates.minDistinctDaysPreference;
        const sessionsOk = counts.distinctSessions >= this.gates.minDistinctSessionsPreference;
        crosses = supportOk && daysOk && sessionsOk;
        reason = crosses
          ? `preference gate crossed: ${counts.qualifyingOccurrences} support / ${counts.distinctDays} days / ${counts.distinctSessions} sessions / ${clusterRecords.length} keys`
          : `below preference gate (support ${counts.qualifyingOccurrences}/${this.gates.minSupport}, days ${counts.distinctDays}/${this.gates.minDistinctDaysPreference}, sessions ${counts.distinctSessions}/${this.gates.minDistinctSessionsPreference}, keys ${clusterRecords.length})`;
      } else {
        // infra-gap: minSupport AND minDistinctDays. The SECOND orthogonal prong
        // (cross-agent Rising Tide consensus) is delegated to the /feedback
        // clustering — single-agent gate-crossing routes a PROPOSAL, never an
        // auto-fleet-propagation. The driver's autoFeedback gate is where that
        // second layer applies; the single-agent gate here is days+support.
        const daysOk = counts.distinctDays >= this.gates.minDistinctDaysInfraGap;
        crosses = supportOk && daysOk;
        reason = crosses
          ? `infra-gap gate crossed: ${counts.qualifyingOccurrences} support / ${counts.distinctDays} days (cross-agent consensus applies downstream)`
          : `below infra-gap gate (support ${counts.qualifyingOccurrences}/${this.gates.minSupport}, days ${counts.distinctDays}/${this.gates.minDistinctDaysInfraGap})`;
      }

      const verdict: GateVerdict = {
        record: rec,
        clusterRecords,
        clusterDedupeKeys,
        crosses,
        reason,
        qualifyingOccurrences: counts.qualifyingOccurrences,
        distinctDays: counts.distinctDays,
        distinctSessions: counts.distinctSessions,
        distinctTopics: counts.distinctTopics,
      };
      verdicts.push(verdict);
      if (!crosses) below++;
    }

    return {
      verdicts,
      crossed: verdicts.filter((v) => v.crosses),
      considered: records.length,
      belowThreshold: below,
    };
  }
}
