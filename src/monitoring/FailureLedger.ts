/**
 * FailureLedger — dev-process failure forensics for instar self-hosting.
 *
 * Records failures that trace back to something we built, attributes each to
 * the spec / initiative / project AND the dev toolchain that produced it, and
 * exposes the data to the analyzer + dashboard. Part of the Failure-Learning
 * Loop (docs/specs/FAILURE-LEARNING-LOOP-SPEC.md, converged + approved
 * 2026-05-26).
 *
 * Storage (spec §4.2, round-3 decision): a DEDICATED SQLite table with
 * first-class indexed columns (build_skill, category, initiative_id,
 * detected_at, attribution, provenance) — explicitly NOT the TaskFlow `flows`
 * blob, so the analyzer's group-by queries are indexed rather than a
 * cache-rebuild + JS filter. Append/upsert-only, no flow lifecycle.
 *
 * Key invariants:
 *  - dedupeKey upsert (spec §4.2 M5): a repeat of the same
 *    (source, causeCommitOid, category) increments occurrenceCount instead of
 *    duplicating, so a flapping/flaky source can never manufacture support.
 *  - mandatory ifMatch OCC (spec §4.2 M4): every mutation supplies the prior
 *    version; a stale write loses (conflict) — no last-writer-win.
 *  - COUNT(DISTINCT) diversity (spec §4.4): distinct sessions / cause-commits
 *    for the source-diversity gate are computed over a bounded occurrences
 *    table, never an unbounded set stored on the record.
 *  - redaction (spec §4.8 C7): detail.full is internal-only — toApiView() and
 *    every route serve detail.redacted ONLY. full never leaves over HTTP.
 *  - fail-open (spec §4.2 m9): a write error logs and drops; it never throws
 *    back into the commit / reconciler / route that observed the failure.
 */
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';

// ── Types ─────────────────────────────────────────────────────────────

export type FailureSource =
  | 'bugfix-commit'
  | 'agent-diagnosed'
  | 'ci'
  | 'revert'
  | 'regression'
  | 'degradation';

export type FailureSeverity = 'low' | 'medium' | 'high';

export type FailureCategory =
  | 'concurrency'
  | 'config-parse'
  | 'wiring'
  | 'logic'
  | 'migration'
  | 'test-gap'
  // Ingestion-sources spec §7: added for the automatic feeds (ci/revert/regression).
  // Without these, coerceCategory clamped them to 'unknown', defeating byCategory
  // analytics and flattening the dedupeKey.
  | 'build-failure'
  | 'test-failure'
  | 'regression'
  | 'unknown';

export type AttributionMode = 'automatic' | 'one-tap' | 'inferred';

export type FailureStatus =
  | 'open'
  | 'attributed'
  | 'analyzed'
  | 'resolved'
  | 'reopened';

/** Internal-only severity-split detail (spec §4.8). `full` never leaves via HTTP. */
export interface FailureDetail {
  redacted: string;
  full: string;
}

export interface FailureRecord {
  id: string;
  dedupeKey: string;
  occurrenceCount: number;
  detectedAt: string;
  filedBy: string;
  source: FailureSource;
  severity: FailureSeverity;
  summary: string;
  detail: FailureDetail;
  category: FailureCategory;
  /**
   * Judgment Within Floors (ownership-gated-spawn spec §3.6): the failure traces
   * to a STATIC HEURISTIC at a competing-signals decision point — a candidate
   * for a judgment point within a deterministic floor. Set by the filer;
   * clustered by the analyzer into the judgment-candidate recommendation.
   */
  judgmentCandidate?: boolean;
  // attribution
  initiativeId?: string;
  projectId?: string;
  specPath?: string;
  causeCommitOid?: string;
  fixCommitOid?: string;
  prNumber?: number;
  toolchainRef?: string;
  buildSkill?: string;       // denormalized from the toolchain join for indexed group-by
  provenance?: 'verified' | 'claimed' | 'unknown';
  attribution: AttributionMode;
  attributionConfidence: number;
  // lifecycle
  status: FailureStatus;
  learningId?: string;
  createdAt: string;
  updatedAt: string;
  version: number;
}

/** The shape returned over HTTP / to the dashboard — detail.full stripped. */
export interface FailureRecordApiView extends Omit<FailureRecord, 'detail'> {
  detail: { redacted: string };
}

export type InsightStatus =
  | 'discovered'
  | 'acted-on'
  | 'verified-effective'
  | 'verified-ineffective'
  | 'inconclusive'
  | 'dismissed';

export type VerifiedOutcome = 'pending' | 'effective' | 'ineffective' | 'insufficient-exposure' | 'n/a';

/** A discovered process-gap insight (spec §4.4 / §4.6.1). */
export interface InsightRecord {
  id: string;
  /** Content-stable across analyzer runs (so the same pattern updates, never re-announces). */
  identityKey: string;
  discoveredAt: string;
  summary: string;
  recommendation: string;
  supportingFailureIds: string[];
  distinctSessions: number;
  distinctCauseCommits: number;
  status: InsightStatus;
  actedOnVia?: string;
  verifyWindowStart?: string;
  verifyWindowEnd?: string;
  targetCategory?: string;
  baselineRate?: number;
  reopenCount: number;
  verifiedOutcome: VerifiedOutcome;
  /** True once this insight has been pushed to the system topic (push exactly once). */
  announced: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface UpsertInsightInput {
  identityKey: string;
  summary: string;
  recommendation: string;
  supportingFailureIds: string[];
  distinctSessions: number;
  distinctCauseCommits: number;
  targetCategory?: string;
  baselineRate?: number;
}

export interface OpenFailureInput {
  detectedAt?: string;
  filedBy: string;
  source: FailureSource;
  severity: FailureSeverity;
  summary: string;
  detail: FailureDetail;
  category?: FailureCategory;
  /** See {@link FailureRecord.judgmentCandidate}. */
  judgmentCandidate?: boolean;
  initiativeId?: string;
  projectId?: string;
  specPath?: string;
  causeCommitOid?: string;
  prNumber?: number;
  toolchainRef?: string;
  buildSkill?: string;
  provenance?: 'verified' | 'claimed' | 'unknown';
  attribution: AttributionMode;
  attributionConfidence?: number;
}

export interface ListFilter {
  source?: FailureSource;
  category?: FailureCategory;
  initiativeId?: string;
  attribution?: AttributionMode;
  status?: FailureStatus;
  sinceMs?: number;
  /** Upper-bound (exclusive): detected_at < beforeMs. Drives keyset pagination (Process Health tab §3). */
  beforeMs?: number;
  limit?: number;
}

/** Filter for {@link FailureLedger.listInsights} — mirrors {@link ListFilter}'s before/limit shape. */
export interface InsightListFilter {
  status?: InsightStatus;
  /** Upper-bound (exclusive): discovered_at < beforeMs. */
  beforeMs?: number;
  /** Clamped 50 default / 1000 max (insight-specific default; narrower than list()'s 200). */
  limit?: number;
}

export type UpdateResult =
  | { ok: true; record: FailureRecord }
  | { ok: false; conflict: true; current?: FailureRecord }
  | { ok: false; conflict: false; reason: string };

export type InsightUpdateResult =
  | { ok: true; record: InsightRecord }
  | { ok: false; conflict: true; current?: InsightRecord }
  | { ok: false; conflict: false; reason: string };

export interface DistinctCounts {
  sessions: number;
  causeCommits: number;
}

export interface FailureLedgerOptions {
  dbPath: string;
  /** Stable machine identifier for machine-scoped IDs (spec §4.2 M2). */
  machineId?: string;
  /** Sink for fail-open write errors (defaults to console.error). */
  onError?: (where: string, err: unknown) => void;
  /**
   * Ingestion-sources spec §5: cap on `failure_occurrences` rows kept per
   * dedupeKey. The occurrence table is a bounded FORENSIC log — the analyzer
   * computes diversity from deduped `failure_records`, never from this table —
   * so pruning old rows cannot affect any analysis decision. Default 200.
   */
  maxOccurrencesPerKey?: number;
}

/** Default forensic-log retention per dedupeKey (spec §5). */
const DEFAULT_MAX_OCCURRENCES_PER_KEY = 200;

// ── Schema ────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS failure_records (
     id                     TEXT PRIMARY KEY,
     dedupe_key             TEXT NOT NULL UNIQUE,
     occurrence_count       INTEGER NOT NULL DEFAULT 1,
     detected_at            TEXT NOT NULL,
     filed_by               TEXT NOT NULL,
     source                 TEXT NOT NULL,
     severity               TEXT NOT NULL,
     summary                TEXT NOT NULL,
     detail_redacted        TEXT NOT NULL DEFAULT '',
     detail_full            TEXT NOT NULL DEFAULT '',
     category               TEXT NOT NULL DEFAULT 'unknown',
     initiative_id          TEXT,
     project_id             TEXT,
     spec_path              TEXT,
     cause_commit_oid       TEXT,
     fix_commit_oid         TEXT,
     pr_number              INTEGER,
     toolchain_ref          TEXT,
     build_skill            TEXT,
     provenance             TEXT NOT NULL DEFAULT 'unknown',
     attribution            TEXT NOT NULL DEFAULT 'inferred',
     attribution_confidence REAL NOT NULL DEFAULT 0,
     status                 TEXT NOT NULL DEFAULT 'open',
     learning_id            TEXT,
     created_at             TEXT NOT NULL,
     updated_at             TEXT NOT NULL,
     version                INTEGER NOT NULL DEFAULT 1
   )`,
  // First-class indexes for the analyzer's group-by query path (spec §4.4):
  `CREATE INDEX IF NOT EXISTS idx_failure_detected ON failure_records(detected_at)`,
  `CREATE INDEX IF NOT EXISTS idx_failure_category ON failure_records(category)`,
  `CREATE INDEX IF NOT EXISTS idx_failure_initiative ON failure_records(initiative_id)`,
  `CREATE INDEX IF NOT EXISTS idx_failure_buildskill ON failure_records(build_skill)`,
  `CREATE INDEX IF NOT EXISTS idx_failure_attribution ON failure_records(attribution, provenance)`,
  // Bounded occurrence log — feeds COUNT(DISTINCT) for the diversity gate
  // (spec §4.4) without growing an unbounded set on the deduped record.
  `CREATE TABLE IF NOT EXISTS failure_occurrences (
     id           INTEGER PRIMARY KEY AUTOINCREMENT,
     dedupe_key   TEXT NOT NULL,
     filed_by     TEXT NOT NULL,
     cause_commit TEXT,
     detected_at  TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_occ_dedupe ON failure_occurrences(dedupe_key)`,
  // Per-machine monotonic sequence for machine-scoped IDs.
  `CREATE TABLE IF NOT EXISTS failure_seq (
     machine_id TEXT PRIMARY KEY,
     next_seq   INTEGER NOT NULL DEFAULT 1
   )`,
  // Discovered process-gap insights (spec §4.4/§4.6.1). identity_key is
  // content-stable across analyzer runs so the same pattern is updated, never
  // re-announced (the tunnel-spam stable-key lesson).
  `CREATE TABLE IF NOT EXISTS failure_insights (
     id                     TEXT PRIMARY KEY,
     identity_key           TEXT NOT NULL UNIQUE,
     discovered_at          TEXT NOT NULL,
     summary                TEXT NOT NULL,
     recommendation         TEXT NOT NULL DEFAULT '',
     supporting_failure_ids TEXT NOT NULL DEFAULT '[]',
     distinct_sessions      INTEGER NOT NULL DEFAULT 0,
     distinct_cause_commits INTEGER NOT NULL DEFAULT 0,
     status                 TEXT NOT NULL DEFAULT 'discovered',
     acted_on_via           TEXT,
     verify_window_start    TEXT,
     verify_window_end      TEXT,
     target_category        TEXT,
     baseline_rate          REAL,
     reopen_count           INTEGER NOT NULL DEFAULT 0,
     verified_outcome       TEXT NOT NULL DEFAULT 'pending',
     announced              INTEGER NOT NULL DEFAULT 0,
     created_at             TEXT NOT NULL,
     updated_at             TEXT NOT NULL,
     version                INTEGER NOT NULL DEFAULT 1
   )`,
  // Insight pagination index (Process Health tab §3): keyset on discovered_at DESC.
  `CREATE INDEX IF NOT EXISTS idx_insights_discovered ON failure_insights(discovered_at)`,
  // Judgment Within Floors (§3.6): filer-set flag marking a failure as tracing
  // to a static heuristic at a competing-signals decision point. ALTER TABLE is
  // idempotent via the duplicate-column swallow in the constructor's exec loop.
  `ALTER TABLE failure_records ADD COLUMN judgment_candidate INTEGER NOT NULL DEFAULT 0`,
];

// ── FailureLedger ─────────────────────────────────────────────────────

export class FailureLedger {
  private db: BetterSqliteDatabase;
  private readonly machineId: string;
  private readonly onError: (where: string, err: unknown) => void;
  private readonly maxOccurrencesPerKey: number;

  constructor(opts: FailureLedgerOptions) {
    this.machineId = (opts.machineId || os.hostname() || 'local')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'local';
    this.maxOccurrencesPerKey =
      opts.maxOccurrencesPerKey && opts.maxOccurrencesPerKey > 0
        ? opts.maxOccurrencesPerKey
        : DEFAULT_MAX_OCCURRENCES_PER_KEY;
    this.onError =
      opts.onError ?? ((where, err) => console.error(`[FailureLedger] ${where}:`, err));

    if (opts.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    }
    this.db = NativeModuleHealer.openWithHealSync(
      'FailureLedger',
      () => new Database(opts.dbPath),
    );
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    for (const ddl of SCHEMA) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        // ALTER TABLE … ADD COLUMN is idempotent at the column level but SQLite
        // throws if the column already exists. Swallow that one case; rethrow
        // anything else (the TokenLedger precedent).
        const msg = (err as Error).message || '';
        if (!/duplicate column name/i.test(msg)) throw err;
      }
    }
    // Close-on-exit registry (SqliteRegistry.ts) — closed once at shutdown.
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
  }

  /** Deterministic dedupe key (spec §4.2 M5). */
  static dedupeKey(source: FailureSource, causeCommitOid: string | undefined, category: FailureCategory): string {
    return `${source}:${causeCommitOid || 'null'}:${category}`;
  }

  private nextId(): string {
    const row = this.db
      .prepare(`SELECT next_seq FROM failure_seq WHERE machine_id = ?`)
      .get(this.machineId) as { next_seq: number } | undefined;
    const seq = row?.next_seq ?? 1;
    this.db
      .prepare(
        `INSERT INTO failure_seq (machine_id, next_seq) VALUES (?, ?)
         ON CONFLICT(machine_id) DO UPDATE SET next_seq = ?`,
      )
      .run(this.machineId, seq + 1, seq + 1);
    return `FAIL-${this.machineId}-${String(seq).padStart(3, '0')}`;
  }

  /**
   * Open (or upsert) a failure record. A repeat on the same dedupeKey
   * increments occurrenceCount and logs a distinct occurrence rather than
   * duplicating. Fail-open: returns null on any storage error.
   */
  open(input: OpenFailureInput): FailureRecord | null {
    try {
      const category = input.category ?? 'unknown';
      const dedupeKey = FailureLedger.dedupeKey(input.source, input.causeCommitOid, category);
      const now = new Date().toISOString();
      const detectedAt = input.detectedAt ?? now;

      const txn = this.db.transaction(() => {
        // Always log the occurrence (feeds COUNT(DISTINCT) diversity gate).
        this.db
          .prepare(
            `INSERT INTO failure_occurrences (dedupe_key, filed_by, cause_commit, detected_at)
             VALUES (?, ?, ?, ?)`,
          )
          .run(dedupeKey, input.filedBy, input.causeCommitOid ?? null, detectedAt);

        // Ingestion-sources spec §5: bounded forensic log — prune occurrence rows
        // for this dedupeKey beyond the most-recent N. Safe because the analyzer
        // computes diversity from deduped `failure_records`, never this table.
        this.db
          .prepare(
            `DELETE FROM failure_occurrences
              WHERE dedupe_key = @dedupeKey
                AND id NOT IN (
                  SELECT id FROM failure_occurrences
                   WHERE dedupe_key = @dedupeKey
                   ORDER BY id DESC LIMIT @keep)`,
          )
          .run({ dedupeKey, keep: this.maxOccurrencesPerKey });

        const existing = this.db
          .prepare(`SELECT id FROM failure_records WHERE dedupe_key = ?`)
          .get(dedupeKey) as { id: string } | undefined;

        if (existing) {
          this.db
            .prepare(
              `UPDATE failure_records
                 SET occurrence_count = occurrence_count + 1, updated_at = ?, version = version + 1
               WHERE id = ?`,
            )
            .run(now, existing.id);
          return existing.id;
        }

        const id = this.nextId();
        // Ingestion-sources spec §5: ON CONFLICT upsert so a cross-process race
        // (another instance inserting the same dedupeKey between our SELECT and
        // INSERT) increments instead of dropping the record (the prior plain
        // INSERT hit the UNIQUE constraint → fail-open catch → lost occurrence).
        // RETURNING id yields the SURVIVING row's id (new on insert, existing on
        // conflict), so we never return a phantom id.
        const row = this.db
          .prepare(
            `INSERT INTO failure_records
               (id, dedupe_key, occurrence_count, detected_at, filed_by, source, severity,
                summary, detail_redacted, detail_full, category, judgment_candidate, initiative_id, project_id,
                spec_path, cause_commit_oid, pr_number, toolchain_ref, build_skill, provenance,
                attribution, attribution_confidence, status, created_at, updated_at, version)
             VALUES
               (@id, @dedupeKey, 1, @detectedAt, @filedBy, @source, @severity,
                @summary, @detailRedacted, @detailFull, @category, @judgmentCandidate, @initiativeId, @projectId,
                @specPath, @causeCommitOid, @prNumber, @toolchainRef, @buildSkill, @provenance,
                @attribution, @attributionConfidence, 'open', @createdAt, @updatedAt, 1)
             ON CONFLICT(dedupe_key) DO UPDATE SET
               occurrence_count = occurrence_count + 1,
               updated_at = excluded.updated_at,
               version = version + 1
             RETURNING id`,
          )
          .get({
            id,
            dedupeKey,
            detectedAt,
            filedBy: input.filedBy,
            source: input.source,
            severity: input.severity,
            summary: input.summary,
            detailRedacted: input.detail.redacted,
            detailFull: input.detail.full,
            category,
            judgmentCandidate: input.judgmentCandidate ? 1 : 0,
            initiativeId: input.initiativeId ?? null,
            projectId: input.projectId ?? null,
            specPath: input.specPath ?? null,
            causeCommitOid: input.causeCommitOid ?? null,
            prNumber: input.prNumber ?? null,
            toolchainRef: input.toolchainRef ?? null,
            buildSkill: input.buildSkill ?? null,
            provenance: input.provenance ?? 'unknown',
            attribution: input.attribution,
            attributionConfidence: input.attributionConfidence ?? 0,
            createdAt: now,
            updatedAt: now,
          }) as { id: string };
        return row.id;
      });

      const id = txn();
      return this.get(id);
    } catch (err) {
      this.onError('open', err);
      return null;
    }
  }

  get(id: string): FailureRecord | null {
    const row = this.db.prepare(`SELECT * FROM failure_records WHERE id = ?`).get(id);
    return row ? this.rowToRecord(row as Record<string, unknown>) : null;
  }

  getByDedupeKey(dedupeKey: string): FailureRecord | null {
    const row = this.db
      .prepare(`SELECT * FROM failure_records WHERE dedupe_key = ?`)
      .get(dedupeKey);
    return row ? this.rowToRecord(row as Record<string, unknown>) : null;
  }

  list(filter: ListFilter = {}): FailureRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.source) { where.push('source = @source'); params.source = filter.source; }
    if (filter.category) { where.push('category = @category'); params.category = filter.category; }
    if (filter.initiativeId) { where.push('initiative_id = @initiativeId'); params.initiativeId = filter.initiativeId; }
    if (filter.attribution) { where.push('attribution = @attribution'); params.attribution = filter.attribution; }
    if (filter.status) { where.push('status = @status'); params.status = filter.status; }
    if (filter.sinceMs) { where.push('detected_at >= @since'); params.since = new Date(filter.sinceMs).toISOString(); }
    if (filter.beforeMs) { where.push('detected_at < @before'); params.before = new Date(filter.beforeMs).toISOString(); }
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 200;
    const sql =
      `SELECT * FROM failure_records` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY detected_at DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(params) as Record<string, unknown>[]).map((r) =>
      this.rowToRecord(r),
    );
  }

  /**
   * Mutate a record. `ifMatch` is MANDATORY (spec §4.2 M4) — a stale version
   * loses with {ok:false, conflict:true}. Caller retries (bounded).
   */
  update(
    id: string,
    patch: Partial<Pick<FailureRecord, 'status' | 'category' | 'fixCommitOid' | 'learningId' | 'attribution' | 'attributionConfidence' | 'provenance' | 'buildSkill' | 'initiativeId' | 'projectId' | 'specPath' | 'toolchainRef'>>,
    ifMatch: number,
  ): UpdateResult {
    try {
      const current = this.get(id);
      if (!current) return { ok: false, conflict: false, reason: 'not-found' };
      if (current.version !== ifMatch) return { ok: false, conflict: true, current };

      const cols: string[] = [];
      const params: Record<string, unknown> = { id, ifMatch };
      const map: Record<string, string> = {
        status: 'status', category: 'category', fixCommitOid: 'fix_commit_oid',
        learningId: 'learning_id', attribution: 'attribution',
        attributionConfidence: 'attribution_confidence', provenance: 'provenance',
        buildSkill: 'build_skill', initiativeId: 'initiative_id',
        projectId: 'project_id', specPath: 'spec_path', toolchainRef: 'toolchain_ref',
      };
      for (const [k, v] of Object.entries(patch)) {
        const col = map[k];
        if (!col) continue;
        cols.push(`${col} = @${k}`);
        params[k] = v ?? null;
      }
      if (cols.length === 0) return { ok: true, record: current };
      const now = new Date().toISOString();
      const res = this.db
        .prepare(
          `UPDATE failure_records SET ${cols.join(', ')}, updated_at = @now, version = version + 1
           WHERE id = @id AND version = @ifMatch`,
        )
        .run({ ...params, now });
      if (res.changes === 0) return { ok: false, conflict: true, current: this.get(id) ?? undefined };
      return { ok: true, record: this.get(id)! };
    } catch (err) {
      this.onError('update', err);
      return { ok: false, conflict: false, reason: 'storage-error' };
    }
  }

  /** Distinct sessions + cause-commits for the diversity gate (spec §4.4). */
  distinctCounts(dedupeKey: string): DistinctCounts {
    const row = this.db
      .prepare(
        `SELECT COUNT(DISTINCT filed_by) AS sessions,
                COUNT(DISTINCT cause_commit) AS commits
           FROM failure_occurrences WHERE dedupe_key = ?`,
      )
      .get(dedupeKey) as { sessions: number; commits: number } | undefined;
    return { sessions: row?.sessions ?? 0, causeCommits: row?.commits ?? 0 };
  }

  /**
   * Raw forensic-log row count (Ingestion-sources spec §5). Observability +
   * test hook for the retention cap — total rows, or rows for one dedupeKey.
   */
  countOccurrences(dedupeKey?: string): number {
    const row = dedupeKey
      ? this.db.prepare(`SELECT COUNT(*) c FROM failure_occurrences WHERE dedupe_key = ?`).get(dedupeKey)
      : this.db.prepare(`SELECT COUNT(*) c FROM failure_occurrences`).get();
    return ((row as { c: number } | undefined)?.c) ?? 0;
  }

  /**
   * Analyzer query path (spec §4.4): indexed group-bys directly in SQL, never a
   * full cache-rebuild + JS filter. Toolchain-blame counts are restricted to
   * `verified`-provenance, `automatic`-attribution records (claimed / one-tap /
   * inferred are excluded from blame aggregates). Also reports coverage so a
   * low-attribution rate reads as low-confidence, not as the rate.
   */
  analyze(opts: { sinceMs?: number } = {}): {
    total: number;
    attributed: number;
    byCategory: Record<string, number>;
    byBuildSkill: Record<string, number>;
    unknownToolchainByAuthor: Record<string, number>;
    noFeatureLink: number;
  } {
    const sinceClause = opts.sinceMs ? ` AND detected_at >= @since` : '';
    const params: Record<string, unknown> = opts.sinceMs ? { since: new Date(opts.sinceMs).toISOString() } : {};
    const total = (this.db.prepare(`SELECT COUNT(*) c FROM failure_records WHERE 1=1${sinceClause}`).get(params) as { c: number }).c;
    const attributed = (this.db.prepare(`SELECT COUNT(*) c FROM failure_records WHERE attribution = 'automatic'${sinceClause}`).get(params) as { c: number }).c;

    const byCategory: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT category, COUNT(*) c FROM failure_records WHERE 1=1${sinceClause} GROUP BY category`).all(params) as { category: string; c: number }[]) {
      byCategory[r.category] = r.c;
    }
    // Toolchain-blame: verified provenance + automatic attribution only.
    const byBuildSkill: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT build_skill bs, COUNT(*) c FROM failure_records WHERE provenance = 'verified' AND attribution = 'automatic' AND build_skill IS NOT NULL${sinceClause} GROUP BY build_skill`).all(params) as { bs: string; c: number }[]) {
      byBuildSkill[r.bs] = r.c;
    }
    // Coverage-integrity (spec §4.4, round-3 R2-sec-omit): unknown-toolchain by author.
    const unknownToolchainByAuthor: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT filed_by fb, COUNT(*) c FROM failure_records WHERE provenance = 'unknown'${sinceClause} GROUP BY filed_by`).all(params) as { fb: string; c: number }[]) {
      unknownToolchainByAuthor[r.fb] = r.c;
    }
    const noFeatureLink = (this.db.prepare(`SELECT COUNT(*) c FROM failure_records WHERE initiative_id IS NULL${sinceClause}`).get(params) as { c: number }).c;

    return { total, attributed, byCategory, byBuildSkill, unknownToolchainByAuthor, noFeatureLink };
  }

  // ── Insights (spec §4.4 / §4.6.1) ────────────────────────────────────

  /**
   * Upsert an insight keyed on its content-stable identityKey. A re-discovery
   * UPDATES the existing record (refreshes evidence + counts) but PRESERVES its
   * lifecycle (status/actedOnVia/verify window/announced) — so a pattern is
   * never re-announced and an in-flight loop is never reset (spec §4.5 stable-key).
   * Returns the resulting insight (fail-open: null on storage error).
   */
  upsertInsight(input: UpsertInsightInput): InsightRecord | null {
    try {
      const now = new Date().toISOString();
      const existing = this.getInsightByIdentity(input.identityKey);
      if (existing) {
        this.db
          .prepare(
            `UPDATE failure_insights
               SET summary=@summary, recommendation=@recommendation,
                   supporting_failure_ids=@ids, distinct_sessions=@ds,
                   distinct_cause_commits=@dc, target_category=@tc,
                   baseline_rate=@br, updated_at=@now, version=version+1
             WHERE id=@id`,
          )
          .run({
            id: existing.id, summary: input.summary, recommendation: input.recommendation,
            ids: JSON.stringify(input.supportingFailureIds), ds: input.distinctSessions,
            dc: input.distinctCauseCommits, tc: input.targetCategory ?? null,
            br: input.baselineRate ?? null, now,
          });
        return this.getInsight(existing.id);
      }
      const id = `INS-${this.machineId}-${this.nextInsightSeq()}`;
      this.db
        .prepare(
          `INSERT INTO failure_insights
             (id, identity_key, discovered_at, summary, recommendation,
              supporting_failure_ids, distinct_sessions, distinct_cause_commits,
              target_category, baseline_rate,
              status, reopen_count, verified_outcome, announced, created_at, updated_at, version)
           VALUES (@id,@ik,@now,@summary,@rec,@ids,@ds,@dc,@tc,@br,'discovered',0,'pending',0,@now,@now,1)`,
        )
        .run({
          id, ik: input.identityKey, now, summary: input.summary, rec: input.recommendation,
          ids: JSON.stringify(input.supportingFailureIds), ds: input.distinctSessions, dc: input.distinctCauseCommits,
          tc: input.targetCategory ?? null, br: input.baselineRate ?? null,
        });
      return this.getInsight(id);
    } catch (err) {
      this.onError('upsertInsight', err);
      return null;
    }
  }

  private nextInsightSeq(): string {
    const key = `insight:${this.machineId}`;
    const row = this.db.prepare(`SELECT next_seq FROM failure_seq WHERE machine_id = ?`).get(key) as { next_seq: number } | undefined;
    const seq = row?.next_seq ?? 1;
    this.db.prepare(`INSERT INTO failure_seq (machine_id, next_seq) VALUES (?, ?) ON CONFLICT(machine_id) DO UPDATE SET next_seq = ?`).run(key, seq + 1, seq + 1);
    return String(seq).padStart(3, '0');
  }

  getInsight(id: string): InsightRecord | null {
    const row = this.db.prepare(`SELECT * FROM failure_insights WHERE id = ?`).get(id);
    return row ? this.rowToInsight(row as Record<string, unknown>) : null;
  }

  getInsightByIdentity(identityKey: string): InsightRecord | null {
    const row = this.db.prepare(`SELECT * FROM failure_insights WHERE identity_key = ?`).get(identityKey);
    return row ? this.rowToInsight(row as Record<string, unknown>) : null;
  }

  listInsights(filter: InsightListFilter = {}): InsightRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.status) { where.push('status = @status'); params.status = filter.status; }
    if (filter.beforeMs) { where.push('discovered_at < @before'); params.before = new Date(filter.beforeMs).toISOString(); }
    // Insight-specific clamp: 50 default / 1000 max (do NOT copy list()'s 200 default).
    const limit = filter.limit && filter.limit > 0 ? Math.min(filter.limit, 1000) : 50;
    const sql =
      `SELECT * FROM failure_insights` +
      (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
      ` ORDER BY discovered_at DESC LIMIT ${limit}`;
    return (this.db.prepare(sql).all(params) as Record<string, unknown>[]).map((r) =>
      this.rowToInsight(r),
    );
  }

  updateInsight(
    id: string,
    patch: Partial<Pick<InsightRecord, 'status' | 'actedOnVia' | 'verifyWindowStart' | 'verifyWindowEnd' | 'targetCategory' | 'baselineRate' | 'reopenCount' | 'verifiedOutcome' | 'announced'>>,
    ifMatch: number,
  ): InsightUpdateResult {
    try {
      const current = this.getInsight(id);
      if (!current) return { ok: false, conflict: false, reason: 'not-found' };
      if (current.version !== ifMatch) return { ok: false, conflict: true, current };
      const map: Record<string, string> = {
        status: 'status', actedOnVia: 'acted_on_via', verifyWindowStart: 'verify_window_start',
        verifyWindowEnd: 'verify_window_end', targetCategory: 'target_category', baselineRate: 'baseline_rate',
        reopenCount: 'reopen_count', verifiedOutcome: 'verified_outcome', announced: 'announced',
      };
      const cols: string[] = [];
      const params: Record<string, unknown> = { id, ifMatch };
      for (const [k, v] of Object.entries(patch)) {
        const col = map[k]; if (!col) continue;
        cols.push(`${col} = @${k}`);
        params[k] = k === 'announced' ? (v ? 1 : 0) : (v ?? null);
      }
      if (cols.length === 0) return { ok: true, record: current };
      const now = new Date().toISOString();
      const res = this.db.prepare(`UPDATE failure_insights SET ${cols.join(', ')}, updated_at=@now, version=version+1 WHERE id=@id AND version=@ifMatch`).run({ ...params, now });
      if (res.changes === 0) return { ok: false, conflict: true, current: this.getInsight(id) ?? undefined };
      return { ok: true, record: this.getInsight(id)! };
    } catch (err) {
      this.onError('updateInsight', err);
      return { ok: false, conflict: false, reason: 'storage-error' };
    }
  }

  private rowToInsight(r: Record<string, unknown>): InsightRecord {
    let ids: string[] = [];
    try { ids = JSON.parse((r.supporting_failure_ids as string) || '[]'); } catch { ids = []; }
    return {
      id: r.id as string,
      identityKey: r.identity_key as string,
      discoveredAt: r.discovered_at as string,
      summary: r.summary as string,
      recommendation: (r.recommendation as string) ?? '',
      supportingFailureIds: ids,
      distinctSessions: r.distinct_sessions as number,
      distinctCauseCommits: r.distinct_cause_commits as number,
      status: r.status as InsightStatus,
      actedOnVia: (r.acted_on_via as string) ?? undefined,
      verifyWindowStart: (r.verify_window_start as string) ?? undefined,
      verifyWindowEnd: (r.verify_window_end as string) ?? undefined,
      targetCategory: (r.target_category as string) ?? undefined,
      baselineRate: (r.baseline_rate as number) ?? undefined,
      reopenCount: r.reopen_count as number,
      verifiedOutcome: r.verified_outcome as VerifiedOutcome,
      announced: !!(r.announced as number),
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      version: r.version as number,
    };
  }

  /** Strip detail.full — the ONLY shape that may cross an HTTP boundary (spec §4.8). */
  static toApiView(record: FailureRecord): FailureRecordApiView {
    const { detail, ...rest } = record;
    return { ...rest, detail: { redacted: detail.redacted } };
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  private rowToRecord(r: Record<string, unknown>): FailureRecord {
    return {
      id: r.id as string,
      dedupeKey: r.dedupe_key as string,
      occurrenceCount: r.occurrence_count as number,
      detectedAt: r.detected_at as string,
      filedBy: r.filed_by as string,
      source: r.source as FailureSource,
      severity: r.severity as FailureSeverity,
      summary: r.summary as string,
      detail: { redacted: (r.detail_redacted as string) ?? '', full: (r.detail_full as string) ?? '' },
      category: r.category as FailureCategory,
      judgmentCandidate: (r.judgment_candidate as number) === 1 ? true : undefined,
      initiativeId: (r.initiative_id as string) ?? undefined,
      projectId: (r.project_id as string) ?? undefined,
      specPath: (r.spec_path as string) ?? undefined,
      causeCommitOid: (r.cause_commit_oid as string) ?? undefined,
      fixCommitOid: (r.fix_commit_oid as string) ?? undefined,
      prNumber: (r.pr_number as number) ?? undefined,
      toolchainRef: (r.toolchain_ref as string) ?? undefined,
      buildSkill: (r.build_skill as string) ?? undefined,
      provenance: (r.provenance as 'verified' | 'claimed' | 'unknown') ?? 'unknown',
      attribution: r.attribution as AttributionMode,
      attributionConfidence: r.attribution_confidence as number,
      status: r.status as FailureStatus,
      learningId: (r.learning_id as string) ?? undefined,
      createdAt: r.created_at as string,
      updatedAt: r.updated_at as string,
      version: r.version as number,
    };
  }
}
