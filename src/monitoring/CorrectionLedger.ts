/**
 * CorrectionLedger — distilled, scrubbed correction/preference records (spec §3.4).
 *
 * The conversational twin of FailureLedger. Where that ledger stores dev-process
 * failures, this stores the LESSON distilled from a moment the user had to
 * correct the agent — privacy-safe: ONLY the post-scrubbed `learning` +
 * `scrubbed_summary` + metadata ever land here. Raw conversation never persists.
 *
 * Mirrors FailureLedger's discipline (spec §3.4):
 *  - dedupe-upsert keyed on `kind:normalizedLearningHash` so a recurring lesson
 *    collapses to ONE record (occurrenceCount increments) — message volume can
 *    never manufacture support.
 *  - `correction_occurrences` is a bounded forensic log (DEFAULT_MAX_OCCURRENCES_
 *    PER_KEY = 200, prune-in-transaction with the insert). The analyzer's
 *    distinct-day / distinct-topic counts are computed from this bounded table.
 *  - indexes idx_corr_dedupe + idx_corr_detected (explicitly required).
 *  - toApiView() strips everything but scrubbed_summary + metadata — the
 *    /corrections API never serves raw `learning` text.
 *  - countRecords() health metric so distinct-key growth (an unstable-hash LLM)
 *    is observable.
 *  - fail-open: a write error logs + drops; it never throws back into the
 *    capture/distill seam (which must keep its fire-and-forget contract).
 *
 * dayBucket is UTC, CODE-derived (never LLM-set). deterministicWeight is the
 * Layer-0 total weight, CODE-set — it is the provenance field the analyzer's
 * gate keys on (spec §3.5). llm_confidence is LLM-set + advisory only.
 */
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';

// ── Types ─────────────────────────────────────────────────────────────

/** The distilled kind. Validated against this allow-list — the LLM cannot widen it. */
export type CorrectionKind = 'infra-gap' | 'user-preference' | 'noise';

export type CorrectionStatus =
  | 'open'         // recorded, not yet crossed the recurrence gate
  | 'acted-on'     // routed (feedback proposal / recordPreference / attention) + verify window open
  | 'verified'     // dedupeKey did not recur within the verify window AND application persisted
  | 'inconclusive' // recurred past maxReopens, or silence-only (never marked effective)
  | 'reopened';    // recurred after acting; re-watching (bounded by maxReopens)

export interface CorrectionRecord {
  id: string;
  dedupeKey: string;
  kind: CorrectionKind;
  occurrenceCount: number;
  detectedAt: string;
  /** Post-scrubbed distilled lesson. INTERNAL-ONLY — never crosses HTTP. */
  learning: string;
  /** Post-scrubbed one-line summary. The ONLY text the API serves. */
  scrubbedSummary: string;
  /** UTC date bucket (YYYY-MM-DD), code-derived from detectedAt. */
  dayBucket: string;
  /** Layer-0 total weight at record time — the code-determined provenance. */
  deterministicWeight: number;
  /** LLM-assigned confidence [0,1] — ADVISORY, never alone admits a record. */
  llmConfidence: number;
  topicId: number | null;
  sessionId: string | null;
  /** Lifecycle */
  status: CorrectionStatus;
  routedVia?: string;          // 'feedback' | 'recordPreference' | 'attention'
  verifyWindowStart?: string;
  verifyWindowEnd?: string;
  reopenCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** The shape served over HTTP — `learning` stripped, only scrubbed_summary + metadata. */
export interface CorrectionRecordApiView {
  id: string;
  dedupeKey: string;
  kind: CorrectionKind;
  occurrenceCount: number;
  detectedAt: string;
  scrubbedSummary: string;
  dayBucket: string;
  deterministicWeight: number;
  llmConfidence: number;
  topicId: number | null;
  status: CorrectionStatus;
  routedVia?: string;
  verifyWindowStart?: string;
  verifyWindowEnd?: string;
  reopenCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface RecordCorrectionInput {
  kind: CorrectionKind;
  learning: string;
  scrubbedSummary: string;
  deterministicWeight: number;
  llmConfidence?: number;
  topicId?: number | null;
  sessionId?: string | null;
  detectedAt?: string;
}

export interface ListCorrectionFilter {
  kind?: CorrectionKind;
  status?: CorrectionStatus;
  sinceMs?: number;
  /** Upper-bound (exclusive): detected_at < beforeMs (keyset pagination). */
  beforeMs?: number;
  limit?: number;
}

export type CorrectionUpdateResult =
  | { ok: true; record: CorrectionRecord }
  | { ok: false; conflict: true; current?: CorrectionRecord }
  | { ok: false; conflict: false; reason: string };

export interface CorrectionLedgerOptions {
  dbPath: string;
  machineId?: string;
  onError?: (where: string, err: unknown) => void;
  /** Cap on forensic occurrence rows per dedupeKey (default 200). */
  maxOccurrencesPerKey?: number;
}

/** Default forensic-log retention per dedupeKey (mirrors FailureLedger §5). */
export const DEFAULT_MAX_OCCURRENCES_PER_KEY = 200;

/**
 * Stop-words stripped before hashing so semantically-identical learnings phrased
 * differently collapse to ONE dedupeKey. Conservative + deterministic — the hash
 * stability is a unit-tested invariant.
 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'for', 'with', 'and', 'or', 'but', 'i', 'you',
  'me', 'my', 'your', 'it', 'this', 'that', 'please', 'just', 'always',
  'when', 'do', "don't", 'dont', "i'd", 'id', 'would', 'should', 'so',
  'at', 'by', 'as', 'from', 'into', 'about', 'prefer', 'rather',
]);

// ── Schema ────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS correction_records (
     id                   TEXT PRIMARY KEY,
     dedupe_key           TEXT NOT NULL UNIQUE,
     kind                 TEXT NOT NULL,
     occurrence_count     INTEGER NOT NULL DEFAULT 1,
     detected_at          TEXT NOT NULL,
     learning             TEXT NOT NULL DEFAULT '',
     scrubbed_summary     TEXT NOT NULL DEFAULT '',
     day_bucket           TEXT NOT NULL,
     deterministic_weight INTEGER NOT NULL DEFAULT 0,
     llm_confidence       REAL NOT NULL DEFAULT 0,
     topic_id             INTEGER,
     session_id           TEXT,
     status               TEXT NOT NULL DEFAULT 'open',
     routed_via           TEXT,
     verify_window_start  TEXT,
     verify_window_end    TEXT,
     reopen_count         INTEGER NOT NULL DEFAULT 0,
     created_at           TEXT NOT NULL,
     updated_at           TEXT NOT NULL,
     version              INTEGER NOT NULL DEFAULT 1
   )`,
  // Detected-at index for the analyzer's windowed scan + keyset pagination.
  `CREATE INDEX IF NOT EXISTS idx_corr_detected ON correction_records(detected_at)`,
  // Bounded forensic log — feeds COUNT(DISTINCT day_bucket / topic_id) for the
  // analyzer's diversity prongs without growing an unbounded set on the record.
  `CREATE TABLE IF NOT EXISTS correction_occurrences (
     id            INTEGER PRIMARY KEY AUTOINCREMENT,
     dedupe_key    TEXT NOT NULL,
     day_bucket    TEXT NOT NULL,
     topic_id      INTEGER,
     deterministic_weight INTEGER NOT NULL DEFAULT 0,
     detected_at   TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_corr_dedupe ON correction_occurrences(dedupe_key)`,
  // Composite index backing the distinctCounts() COUNT(DISTINCT day_bucket)
  // query (spec §10 Slice-2 NEW-4). The analyzer's restart-proof distinct-day
  // prong runs `WHERE dedupe_key = ? AND deterministic_weight >= ?` then groups
  // by day_bucket; (dedupe_key, day_bucket) lets SQLite satisfy the distinct-day
  // count from the index without scanning the per-key occurrence rows.
  `CREATE INDEX IF NOT EXISTS idx_corr_dedupe_day ON correction_occurrences(dedupe_key, day_bucket)`,
  // Per-machine monotonic sequence for machine-scoped IDs.
  `CREATE TABLE IF NOT EXISTS correction_seq (
     machine_id TEXT PRIMARY KEY,
     next_seq   INTEGER NOT NULL DEFAULT 1
   )`,
];

// ── CorrectionLedger ──────────────────────────────────────────────────

export class CorrectionLedger {
  private db: BetterSqliteDatabase;
  private readonly machineId: string;
  private readonly onError: (where: string, err: unknown) => void;
  private readonly maxOccurrencesPerKey: number;

  constructor(opts: CorrectionLedgerOptions) {
    this.machineId = (opts.machineId || os.hostname() || 'local')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'local';
    this.maxOccurrencesPerKey =
      opts.maxOccurrencesPerKey && opts.maxOccurrencesPerKey > 0
        ? opts.maxOccurrencesPerKey
        : DEFAULT_MAX_OCCURRENCES_PER_KEY;
    this.onError =
      opts.onError ?? ((where, err) => console.error(`[CorrectionLedger] ${where}:`, err));

    if (opts.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    }
    this.db = NativeModuleHealer.openWithHealSync(
      'CorrectionLedger',
      () => new Database(opts.dbPath),
    );
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    for (const ddl of SCHEMA) this.db.exec(ddl);
    // Close-on-exit registry (SqliteRegistry.ts) — closed once at shutdown.
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
  }

  /**
   * Canonical normalization of a distilled learning before hashing: lowercase,
   * strip punctuation, collapse whitespace, drop stop-words, sort the remaining
   * tokens. Two semantically-identical learnings phrased differently collapse to
   * the SAME hash. Stability is a unit-tested invariant (spec §3.4).
   */
  static normalizeLearning(learning: string): string {
    const tokens = String(learning)
      .toLowerCase()
      .replace(/[^a-z0-9\s']/g, ' ')
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !STOP_WORDS.has(t));
    return tokens.sort().join(' ');
  }

  /** SHA-256 over the canonical normalized form. */
  static normalizedLearningHash(learning: string): string {
    return crypto.createHash('sha256').update(CorrectionLedger.normalizeLearning(learning)).digest('hex');
  }

  /** Deterministic dedupe key: `kind:normalizedLearningHash` (spec §3.4). */
  static dedupeKey(kind: CorrectionKind, learning: string): string {
    return `${kind}:${CorrectionLedger.normalizedLearningHash(learning)}`;
  }

  /** UTC day bucket (YYYY-MM-DD), code-derived from an ISO timestamp. */
  static dayBucketOf(isoOrMs: string | number): string {
    const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs);
    return d.toISOString().slice(0, 10);
  }

  private nextId(): string {
    const row = this.db
      .prepare(`SELECT next_seq FROM correction_seq WHERE machine_id = ?`)
      .get(this.machineId) as { next_seq: number } | undefined;
    const seq = row?.next_seq ?? 1;
    this.db
      .prepare(
        `INSERT INTO correction_seq (machine_id, next_seq) VALUES (?, ?)
         ON CONFLICT(machine_id) DO UPDATE SET next_seq = ?`,
      )
      .run(this.machineId, seq + 1, seq + 1);
    return `CORR-${this.machineId}-${String(seq).padStart(3, '0')}`;
  }

  /**
   * Record (or upsert) a distilled correction. A repeat on the same dedupeKey
   * increments occurrenceCount + logs a distinct occurrence (feeds the
   * distinct-day / distinct-topic gates) rather than duplicating. Fail-open:
   * returns null on any storage error.
   */
  record(input: RecordCorrectionInput): CorrectionRecord | null {
    try {
      const dedupeKey = CorrectionLedger.dedupeKey(input.kind, input.learning);
      const now = new Date().toISOString();
      const detectedAt = input.detectedAt ?? now;
      const dayBucket = CorrectionLedger.dayBucketOf(detectedAt);
      const llmConfidence = clamp01(input.llmConfidence);

      const txn = this.db.transaction(() => {
        // Always log the occurrence (feeds COUNT(DISTINCT) diversity prongs).
        this.db
          .prepare(
            `INSERT INTO correction_occurrences (dedupe_key, day_bucket, topic_id, deterministic_weight, detected_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(dedupeKey, dayBucket, input.topicId ?? null, input.deterministicWeight, detectedAt);

        // Bounded forensic log — prune occurrence rows for this key beyond the
        // most-recent N. Safe: the analyzer's distinct counts are also bounded
        // by N, so pruning cannot change a decision (worst case it UNDERcounts,
        // the safe direction — biases toward NOT firing).
        this.db
          .prepare(
            `DELETE FROM correction_occurrences
              WHERE dedupe_key = @dedupeKey
                AND id NOT IN (
                  SELECT id FROM correction_occurrences
                   WHERE dedupe_key = @dedupeKey
                   ORDER BY id DESC LIMIT @keep)`,
          )
          .run({ dedupeKey, keep: this.maxOccurrencesPerKey });

        const id = this.nextId();
        const row = this.db
          .prepare(
            `INSERT INTO correction_records
               (id, dedupe_key, kind, occurrence_count, detected_at, learning, scrubbed_summary,
                day_bucket, deterministic_weight, llm_confidence, topic_id, session_id,
                status, reopen_count, created_at, updated_at, version)
             VALUES
               (@id, @dedupeKey, @kind, 1, @detectedAt, @learning, @scrubbedSummary,
                @dayBucket, @deterministicWeight, @llmConfidence, @topicId, @sessionId,
                'open', 0, @createdAt, @updatedAt, 1)
             ON CONFLICT(dedupe_key) DO UPDATE SET
               occurrence_count = occurrence_count + 1,
               detected_at = excluded.detected_at,
               day_bucket = excluded.day_bucket,
               -- keep the strongest deterministic weight seen for this key
               deterministic_weight = MAX(deterministic_weight, excluded.deterministic_weight),
               -- advisory: take the max confidence seen
               llm_confidence = MAX(llm_confidence, excluded.llm_confidence),
               updated_at = excluded.updated_at,
               version = version + 1
             RETURNING id`,
          )
          .get({
            id,
            dedupeKey,
            kind: input.kind,
            detectedAt,
            learning: input.learning,
            scrubbedSummary: input.scrubbedSummary,
            dayBucket,
            deterministicWeight: input.deterministicWeight,
            llmConfidence,
            topicId: input.topicId ?? null,
            sessionId: input.sessionId ?? null,
            createdAt: now,
            updatedAt: now,
          }) as { id: string };
        return row.id;
      });

      const id = txn();
      return this.get(id);
    } catch (err) {
      this.onError('record', err);
      return null;
    }
  }

  get(id: string): CorrectionRecord | null {
    const row = this.db.prepare(`SELECT * FROM correction_records WHERE id = ?`).get(id);
    return row ? this.rowToRecord(row as Record<string, unknown>) : null;
  }

  getByDedupeKey(dedupeKey: string): CorrectionRecord | null {
    const row = this.db.prepare(`SELECT * FROM correction_records WHERE dedupe_key = ?`).get(dedupeKey);
    return row ? this.rowToRecord(row as Record<string, unknown>) : null;
  }

  list(filter: ListCorrectionFilter = {}): CorrectionRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.kind) { where.push('kind = @kind'); params.kind = filter.kind; }
    if (filter.status) { where.push('status = @status'); params.status = filter.status; }
    if (filter.sinceMs) { where.push('detected_at >= @since'); params.since = new Date(filter.sinceMs).toISOString(); }
    if (filter.beforeMs) { where.push('detected_at < @before'); params.before = new Date(filter.beforeMs).toISOString(); }
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 100;
    const sql =
      `SELECT * FROM correction_records` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY detected_at DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(params) as Record<string, unknown>[]).map((r) => this.rowToRecord(r));
  }

  /**
   * Mutate a record's lifecycle. `ifMatch` is mandatory (OCC) — a stale version
   * loses with {ok:false, conflict:true}.
   */
  update(
    id: string,
    patch: Partial<Pick<CorrectionRecord, 'status' | 'routedVia' | 'verifyWindowStart' | 'verifyWindowEnd' | 'reopenCount'>>,
    ifMatch: number,
  ): CorrectionUpdateResult {
    try {
      const current = this.get(id);
      if (!current) return { ok: false, conflict: false, reason: 'not-found' };
      if (current.version !== ifMatch) return { ok: false, conflict: true, current };
      const map: Record<string, string> = {
        status: 'status', routedVia: 'routed_via', verifyWindowStart: 'verify_window_start',
        verifyWindowEnd: 'verify_window_end', reopenCount: 'reopen_count',
      };
      const cols: string[] = [];
      const params: Record<string, unknown> = { id, ifMatch };
      for (const [k, v] of Object.entries(patch)) {
        const col = map[k]; if (!col) continue;
        cols.push(`${col} = @${k}`);
        params[k] = v ?? null;
      }
      if (cols.length === 0) return { ok: true, record: current };
      const now = new Date().toISOString();
      const res = this.db
        .prepare(`UPDATE correction_records SET ${cols.join(', ')}, updated_at = @now, version = version + 1 WHERE id = @id AND version = @ifMatch`)
        .run({ ...params, now });
      if (res.changes === 0) return { ok: false, conflict: true, current: this.get(id) ?? undefined };
      return { ok: true, record: this.get(id)! };
    } catch (err) {
      this.onError('update', err);
      return { ok: false, conflict: false, reason: 'storage-error' };
    }
  }

  /**
   * Distinct calendar days + distinct topics for the recurrence gate (spec §3.5).
   * Computed from the bounded occurrences table. Restart-proof (keys on UTC
   * day_bucket, NOT a session count instar's frequent restarts would inflate).
   * `qualifying` only counts occurrences whose deterministic_weight ≥ threshold
   * (the code-determined provenance filter — an LLM-only-confident occurrence
   * never alone admits a record to the gate).
   */
  distinctCounts(dedupeKey: string, weightThreshold = 0): {
    distinctDays: number;
    distinctTopics: number;
    qualifyingOccurrences: number;
  } {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT day_bucket) AS days,
                COUNT(DISTINCT topic_id)  AS topics,
                COUNT(*)                  AS occ
           FROM correction_occurrences
          WHERE dedupe_key = @dedupeKey AND deterministic_weight >= @threshold`,
      )
      .get({ dedupeKey, threshold: weightThreshold }) as { days: number; topics: number; occ: number } | undefined;
    return {
      distinctDays: row?.days ?? 0,
      distinctTopics: row?.topics ?? 0,
      qualifyingOccurrences: row?.occ ?? 0,
    };
  }

  /** Total deduped record count — health metric for distinct-key growth (spec §3.4). */
  countRecords(): number {
    const row = this.db.prepare(`SELECT COUNT(*) c FROM correction_records`).get() as { c: number } | undefined;
    return row?.c ?? 0;
  }

  /** Raw forensic-log row count (observability + retention-cap test hook). */
  countOccurrences(dedupeKey?: string): number {
    const row = dedupeKey
      ? this.db.prepare(`SELECT COUNT(*) c FROM correction_occurrences WHERE dedupe_key = ?`).get(dedupeKey)
      : this.db.prepare(`SELECT COUNT(*) c FROM correction_occurrences`).get();
    return ((row as { c: number } | undefined)?.c) ?? 0;
  }

  /**
   * Names of the indexes present on the occurrences table — observability + a
   * test hook pinning that the distinct-days composite index (spec §10 Slice-2
   * NEW-4) is actually created. Read-only.
   */
  listOccurrenceIndexes(): string[] {
    const rows = this.db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'correction_occurrences'`)
      .all() as { name: string }[];
    return rows.map((r) => r.name).filter((n) => !n.startsWith('sqlite_'));
  }

  /** Strip `learning` (raw distilled text) — the ONLY shape allowed over HTTP (spec §3.4). */
  static toApiView(record: CorrectionRecord): CorrectionRecordApiView {
    const { learning: _internalLearning, sessionId: _internalSession, ...rest } = record;
    void _internalLearning; void _internalSession;
    return { ...rest };
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  private rowToRecord(r: Record<string, unknown>): CorrectionRecord {
    return {
      id: r.id as string,
      dedupeKey: r.dedupe_key as string,
      kind: r.kind as CorrectionKind,
      occurrenceCount: r.occurrence_count as number,
      detectedAt: r.detected_at as string,
      learning: (r.learning as string) ?? '',
      scrubbedSummary: (r.scrubbed_summary as string) ?? '',
      dayBucket: r.day_bucket as string,
      deterministicWeight: r.deterministic_weight as number,
      llmConfidence: r.llm_confidence as number,
      topicId: (r.topic_id as number) ?? null,
      sessionId: (r.session_id as string) ?? null,
      status: r.status as CorrectionStatus,
      routedVia: (r.routed_via as string) ?? undefined,
      verifyWindowStart: (r.verify_window_start as string) ?? undefined,
      verifyWindowEnd: (r.verify_window_end as string) ?? undefined,
      reopenCount: r.reopen_count as number,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      version: r.version as number,
    };
  }
}

function clamp01(v: number | undefined): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 0;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}
