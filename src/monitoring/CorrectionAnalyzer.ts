/**
 * CorrectionAnalyzer — the recurrence layer (spec §3.5).
 *
 * Deterministic core: for each open correction record, decides whether it
 * crosses the THREE-PRONGED AND recurrence gate:
 *
 *   minSupport         AND
 *   minDistinctDays    AND   (restart-proof — calendar days, NOT sessions)
 *   second orthogonal prong:
 *     - user-preference → minDistinctTopics ≥ 2
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
import type { CorrectionLedger, CorrectionRecord } from './CorrectionLedger.js';
import { LEARNING_DETERMINISTIC_THRESHOLD } from './HumanAsDetectorLog.js';

export interface CorrectionGates {
  minSupport: number;
  minDistinctDaysInfraGap: number;
  minDistinctDaysPreference: number;
  minDistinctTopicsPreference: number;
  /** Only consider records within this many days (0/undefined = all). */
  windowDays?: number;
  /** Layer-0 weight a record's occurrences must reach to COUNT toward the gate. */
  deterministicThreshold?: number;
}

export const DEFAULT_CORRECTION_GATES: CorrectionGates = {
  minSupport: 4,
  minDistinctDaysInfraGap: 3,
  minDistinctDaysPreference: 2,
  minDistinctTopicsPreference: 2,
  deterministicThreshold: LEARNING_DETERMINISTIC_THRESHOLD,
};

/** Per-record gate verdict — the analyzer's output. */
export interface GateVerdict {
  record: CorrectionRecord;
  crosses: boolean;
  /** Why it did/didn't cross — for audit + the Tier-1 supervisor. */
  reason: string;
  qualifyingOccurrences: number;
  distinctDays: number;
  distinctTopics: number;
}

export interface CorrectionAnalyzeResult {
  verdicts: GateVerdict[];
  crossed: GateVerdict[];
  considered: number;
  belowThreshold: number;
}

export class CorrectionAnalyzer {
  constructor(
    private readonly ledger: CorrectionLedger,
    private readonly gates: CorrectionGates = DEFAULT_CORRECTION_GATES,
  ) {}

  /**
   * Evaluate the recurrence gate against every `open` record. Returns a verdict
   * per record. Pure read — never mutates the ledger (the driver acts on these).
   * `noise`-kind records are never gate-considered.
   */
  analyze(): CorrectionAnalyzeResult {
    const sinceMs = this.gates.windowDays && this.gates.windowDays > 0
      ? Date.now() - this.gates.windowDays * 86400_000
      : undefined;
    const threshold = this.gates.deterministicThreshold ?? LEARNING_DETERMINISTIC_THRESHOLD;

    const records = this.ledger
      .list({ sinceMs, status: 'open', limit: 1000 })
      .filter((r) => r.kind !== 'noise');

    const verdicts: GateVerdict[] = [];
    let below = 0;
    for (const rec of records) {
      // Code-determined provenance filter: only occurrences whose Layer-0 weight
      // crossed the threshold count toward the gate.
      const counts = this.ledger.distinctCounts(rec.dedupeKey, threshold);
      const supportOk = counts.qualifyingOccurrences >= this.gates.minSupport;

      let crosses = false;
      let reason: string;
      if (rec.kind === 'user-preference') {
        const daysOk = counts.distinctDays >= this.gates.minDistinctDaysPreference;
        const topicsOk = counts.distinctTopics >= this.gates.minDistinctTopicsPreference;
        crosses = supportOk && daysOk && topicsOk;
        reason = crosses
          ? `preference gate crossed: ${counts.qualifyingOccurrences} support / ${counts.distinctDays} days / ${counts.distinctTopics} topics`
          : `below preference gate (support ${counts.qualifyingOccurrences}/${this.gates.minSupport}, days ${counts.distinctDays}/${this.gates.minDistinctDaysPreference}, topics ${counts.distinctTopics}/${this.gates.minDistinctTopicsPreference})`;
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
        crosses,
        reason,
        qualifyingOccurrences: counts.qualifyingOccurrences,
        distinctDays: counts.distinctDays,
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
