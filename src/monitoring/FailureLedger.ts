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

export interface OpenFailureInput {
  detectedAt?: string;
  filedBy: string;
  source: FailureSource;
  severity: FailureSeverity;
  summary: string;
  detail: FailureDetail;
  category?: FailureCategory;
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
  limit?: number;
}

export type UpdateResult =
  | { ok: true; record: FailureRecord }
  | { ok: false; conflict: true; current?: FailureRecord }
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
}

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
];

// ── FailureLedger ─────────────────────────────────────────────────────

export class FailureLedger {
  private db: BetterSqliteDatabase;
  private readonly machineId: string;
  private readonly onError: (where: string, err: unknown) => void;

  constructor(opts: FailureLedgerOptions) {
    this.machineId = (opts.machineId || os.hostname() || 'local')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24) || 'local';
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
    for (const ddl of SCHEMA) this.db.exec(ddl);
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
        this.db
          .prepare(
            `INSERT INTO failure_records
               (id, dedupe_key, occurrence_count, detected_at, filed_by, source, severity,
                summary, detail_redacted, detail_full, category, initiative_id, project_id,
                spec_path, cause_commit_oid, pr_number, toolchain_ref, build_skill, provenance,
                attribution, attribution_confidence, status, created_at, updated_at, version)
             VALUES
               (@id, @dedupeKey, 1, @detectedAt, @filedBy, @source, @severity,
                @summary, @detailRedacted, @detailFull, @category, @initiativeId, @projectId,
                @specPath, @causeCommitOid, @prNumber, @toolchainRef, @buildSkill, @provenance,
                @attribution, @attributionConfidence, 'open', @createdAt, @updatedAt, 1)`,
          )
          .run({
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
          });
        return id;
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
