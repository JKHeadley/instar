/**
 * DecisionJournal — Records intent-relevant decisions for alignment analysis.
 *
 * The measurement foundation for intent engineering. Agents log decisions
 * when they face significant tradeoffs, and the journal enables reflection
 * on whether those decisions aligned with stated intent.
 *
 * Storage: JSONL file at {stateDir}/decision-journal.jsonl
 * Format: One JSON object per line, newest entries appended at the end.
 * Creation: Lazy — file is only created when the first entry is logged.
 *
 * WikiClaim Phase 3 (spec § Producers line 258, § Migration Plan line 339):
 * Every recorded decision REQUIRES at least one evidence entry. When a
 * SemanticMemory handle is wired via `setSemanticMemory()`, each `log()` call
 * also promotes the entry to a `decision` MemoryEntity via
 * `rememberWithEvidence(..., 'DecisionJournal')`, and the JSONL row carries
 * the resulting `entityId` as a back-reference for inverse-traceability.
 *
 * The kind allowlist for DecisionJournal (per spec line 227):
 *   `message` | `commit` | `ledger-entry` | `session`
 * Mismatches reject with `EvidencePolicyError` inside SemanticMemory.
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  DecisionJournalEntry,
  MemoryEvidence,
  PrivacyScopeType,
} from './types.js';
import type { SemanticMemory } from '../memory/SemanticMemory.js';
import { EvidencePolicyError } from '../memory/SemanticMemory.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { maybeRotateJsonl } from '../utils/jsonl-rotation.js';

export interface DecisionJournalStats {
  /** Total number of entries */
  count: number;
  /** ISO timestamp of earliest entry */
  earliest: string | null;
  /** ISO timestamp of latest entry */
  latest: string | null;
  /** Top principles referenced, sorted by frequency */
  topPrinciples: Array<{ principle: string; count: number }>;
  /** Number of entries flagged as conflicting */
  conflictCount: number;
}

export class DecisionJournal {
  private journalFile: string;
  /**
   * SemanticMemory handle for the WikiClaim Phase 3 producer bridge. When set,
   * `log()` promotes each entry to a `decision` MemoryEntity with the supplied
   * evidence. Unset (null) by default for backwards compatibility with
   * pre-Phase-3 wiring; callers must still pass evidence — the gate is
   * structural, not opt-in.
   *
   * See spec § Producers line 217 (integration note).
   */
  private semanticMemory: SemanticMemory | null = null;
  /**
   * Privacy scope to use when promoting decision entries to MemoryEntity.
   * Defaults to `shared-project` (matches `rememberWithEvidence` writer-scope
   * default). Operators may override via `setSemanticMemory(memory, scope)`.
   */
  private entityPrivacyScope: PrivacyScopeType = 'shared-project';

  constructor(stateDir: string) {
    this.journalFile = path.join(stateDir, 'decision-journal.jsonl');
  }

  /**
   * Wire a SemanticMemory handle for the Phase 3 producer bridge.
   *
   * After this call, each `log()` invocation calls
   * `memory.rememberWithEvidence(..., 'DecisionJournal')` inside the same
   * append flow and stamps `entityId` onto the JSONL row.
   *
   * Wiring is OPTIONAL — without it, evidence is still required at the API
   * level (compile-time + write-time gate), but no MemoryEntity is created.
   * This lets callers adopt the contract change before the server fully wires
   * SemanticMemory (Phase 4).
   *
   * @param memory SemanticMemory instance
   * @param entityPrivacyScope Privacy scope for the promoted `decision`
   *   entity. Defaults to `shared-project`. Per spec § Storage and Privacy,
   *   evidence narrowing-only is enforced relative to this scope.
   */
  setSemanticMemory(
    memory: SemanticMemory,
    entityPrivacyScope: PrivacyScopeType = 'shared-project',
  ): void {
    this.semanticMemory = memory;
    this.entityPrivacyScope = entityPrivacyScope;
  }

  /**
   * Log a decision to the journal.
   *
   * Spec § Producers line 258 + § Migration Plan line 339: every decision
   * REQUIRES at least one evidence entry. Passing an empty array (or omitting
   * the parameter) throws `EvidencePolicyError`. This is a breaking contract
   * change from pre-Phase-3 callers — every call site MUST cite at least one
   * source for the decision.
   *
   * When SemanticMemory is wired, the entry is also promoted to a `decision`
   * MemoryEntity in the same flow; the resulting `entityId` is back-referenced
   * onto the JSONL row.
   *
   * @param entry Decision payload (timestamp + entityId are filled in here)
   * @param evidence At least one `MemoryEvidence` row. Allowed kinds for
   *   DecisionJournal per spec line 227: `message` | `commit` | `ledger-entry`
   *   | `session`. Mismatches reject with `EvidencePolicyError`.
   * @returns The completed `DecisionJournalEntry` including timestamp and (if
   *   SemanticMemory is wired) `entityId`.
   * @throws EvidencePolicyError if `evidence` is empty.
   */
  log(
    entry: Omit<DecisionJournalEntry, 'timestamp' | 'evidence' | 'entityId'>,
    evidence: MemoryEvidence[],
  ): DecisionJournalEntry {
    // Structural required-evidence gate. Spec § Migration Plan line 340:
    // "DecisionJournal entries require at least one evidence entry."
    if (!Array.isArray(evidence) || evidence.length === 0) {
      throw new EvidencePolicyError(
        'DecisionJournal.log requires at least one evidence entry ' +
          '(spec § Producers line 258). Pass an array with at least one ' +
          'MemoryEvidence row citing the source that informed this decision.',
      );
    }

    const timestamp = new Date().toISOString();
    let entityId: string | undefined;

    // Bridge to SemanticMemory if wired. The producer-kind allowlist + privacy
    // narrowing + evidence cap are enforced inside `rememberWithEvidence`;
    // we don't re-implement them here.
    if (this.semanticMemory) {
      try {
        entityId = this.semanticMemory.rememberWithEvidence(
          {
            type: 'decision',
            name: entry.decision.slice(0, 200),
            content: entry.decision,
            source: entry.sessionId ? `session:${entry.sessionId}` : 'decision-journal',
            sourceSession: entry.sessionId,
            confidence: entry.confidence ?? 0.8,
            lastVerified: timestamp,
            domain: entry.jobSlug,
            tags: entry.tags ?? [],
            privacyScope: this.entityPrivacyScope,
          },
          evidence,
          'DecisionJournal',
        );
      } catch (err) {
        // EvidencePolicyError surfaces caller-facing policy violations
        // (kind not allowed, narrowing-only breach, cap exceeded). Surface
        // those as-is — the caller MUST fix the evidence shape.
        if (err instanceof EvidencePolicyError) throw err;
        // Other errors (DB issues): degrade-report and continue with
        // JSONL-only write so the journal stays functional. Spec § Threat
        // Model: producer crash mid-bridge must not corrupt the journal.
        DegradationReporter.getInstance().report({
          feature: 'DecisionJournal.log/semanticMemoryBridge',
          primary: 'Promote decision to MemoryEntity via rememberWithEvidence',
          fallback: 'Write JSONL row without entityId back-reference',
          reason: err instanceof Error ? err.message : String(err),
          impact: 'Decision logged but not inverse-queryable by evidence',
        });
      }
    }

    const full: DecisionJournalEntry = {
      ...entry,
      timestamp,
      evidence,
      ...(entityId ? { entityId } : {}),
    };

    // Ensure parent directory exists (lazy creation)
    const dir = path.dirname(this.journalFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    maybeRotateJsonl(this.journalFile);
    fs.appendFileSync(this.journalFile, JSON.stringify(full) + '\n');
    return full;
  }

  /**
   * Read journal entries with optional filtering.
   */
  read(options?: {
    /** Only entries from the last N days */
    days?: number;
    /** Only entries from this job */
    jobSlug?: string;
    /** Maximum entries to return (most recent first) */
    limit?: number;
  }): DecisionJournalEntry[] {
    const entries = this.readLines();

    const cutoff = options?.days
      ? new Date(Date.now() - options.days * 24 * 60 * 60 * 1000).toISOString()
      : undefined;

    let filtered = entries.filter(e => {
      if (cutoff && e.timestamp < cutoff) return false;
      if (options?.jobSlug && e.jobSlug !== options.jobSlug) return false;
      return true;
    });

    // Most recent first
    filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    if (options?.limit) {
      filtered = filtered.slice(0, options.limit);
    }

    return filtered;
  }

  /**
   * Return aggregate statistics about the journal.
   */
  stats(): DecisionJournalStats {
    const entries = this.readLines();

    if (entries.length === 0) {
      return {
        count: 0,
        earliest: null,
        latest: null,
        topPrinciples: [],
        conflictCount: 0,
      };
    }

    // Sort chronologically for earliest/latest
    entries.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    // Count principles
    const principleCounts: Record<string, number> = {};
    let conflictCount = 0;

    for (const entry of entries) {
      if (entry.principle) {
        principleCounts[entry.principle] = (principleCounts[entry.principle] || 0) + 1;
      }
      if (entry.conflict) {
        conflictCount++;
      }
    }

    const topPrinciples = Object.entries(principleCounts)
      .map(([principle, count]) => ({ principle, count }))
      .sort((a, b) => b.count - a.count);

    return {
      count: entries.length,
      earliest: entries[0].timestamp,
      latest: entries[entries.length - 1].timestamp,
      topPrinciples,
      conflictCount,
    };
  }

  /**
   * Read all lines from the JSONL file.
   */
  private readLines(): DecisionJournalEntry[] {
    if (!fs.existsSync(this.journalFile)) return [];

    try {
      const content = fs.readFileSync(this.journalFile, 'utf-8').trim();
      if (!content) return [];

      return content.split('\n').map(line => {
        try {
          return JSON.parse(line) as DecisionJournalEntry;
        } catch {
          // @silent-fallback-ok — JSONL line parse, skip corrupted
          return null;
        }
      }).filter(Boolean) as DecisionJournalEntry[];
    } catch (error) {
      console.error(`[DecisionJournal] Failed to read ${this.journalFile}:`, error);
      DegradationReporter.getInstance().report({
        feature: 'DecisionJournal.readLines',
        primary: 'Read decision journal from JSONL',
        fallback: 'Return empty array — no history',
        reason: `Failed to read journal: ${error instanceof Error ? error.message : String(error)}`,
        impact: 'Alignment analysis lacks decision data',
      });
      return [];
    }
  }
}
