/**
 * FrameworkIssueLedger — durable record of behavioral issues observed while
 * onboarding an agent framework onto Instar (the Framework-Onboarding Mentor
 * System, docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md).
 *
 * Two tables, by design (spec §13):
 *   - `framework_issues`       — canonical root-cause records (one per distinct problem)
 *   - `framework_observations` — per-occurrence evidence (one per time it happened)
 *
 * The split exists because "false merges are worse than false splits" — a
 * single-row model would bury distinct root causes. Recurrence is counted in
 * distinct *episodes* (not raw ticks) via `episode_key`, materialized into
 * `recurrence_count` on the canonical row so the playbook ranking never pays a
 * read-time COUNT (spec §13.4).
 *
 * Signal-only: this ledger never gates a job, blocks a message, or constrains a
 * session. Stage B of the mentor loop writes observations; the read-only HTTP
 * routes (`/framework-issues`, `/framework-issues/playbook`) serve them. All
 * authority to act on an entry rests with the human (spec §6).
 *
 * Security (spec §17): `evidence` is an OPAQUE reference only — never inlined
 * log text or diff hunks — and is secret-scanned at capture. All captured
 * free-text is length-capped + sanitized on write. Every query uses a prepared
 * statement with bound parameters; enum columns are validated against fixed
 * allowlists on write.
 */
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';

// ── Enums / allowlists (validated on write — spec §13.8, §17) ───────────────

export const ISSUE_BUCKETS = [
  'framework-limitation',
  'instar-integration-gap',
  'generic-agent-mistake',
] as const;
export type IssueBucket = (typeof ISSUE_BUCKETS)[number];

export const ISSUE_SEVERITIES = ['low', 'medium', 'high'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const ISSUE_STATUSES = ['open', "spec'd", 'fixed', 'wont-fix'] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const PLAYBOOK_STATUSES = ['none', 'candidate', 'extracted', 'superseded'] as const;
export type PlaybookStatus = (typeof PLAYBOOK_STATUSES)[number];

/** Buckets that generalize to the next framework feed the playbook (spec §13.4). */
const GENERALIZABLE_BUCKETS: ReadonlySet<IssueBucket> = new Set<IssueBucket>([
  'framework-limitation',
  'instar-integration-gap',
]);

const SEVERITY_WEIGHT: Record<IssueSeverity, number> = { low: 1, medium: 3, high: 9 };

// ── Tunables (spec §13.2 retention, §13.4 caps) ─────────────────────────────

const MAX_FREE_TEXT = 500; // length-cap for title / signature / rationale (§17)
const MAX_EVIDENCE = 1024; // evidence pointer cap (§13.2 — pointer, not content)
const RETENTION_KEEP_FIRST = 5; // keep first N observations per issue (§13.2)
const RETENTION_KEEP_LAST = 20; // + last M
const PROBABLE_LOOP_PER_HOUR = 12; // obs/hr above which an issue is flagged probable-loop (§13.4)
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30d decay on impactScore (§13.4)

// ── Schema (spec §13.1 / §13.2) ─────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS framework_issues (
     id                     TEXT PRIMARY KEY,
     framework              TEXT NOT NULL,
     bucket                 TEXT NOT NULL,
     bucket_primary         TEXT,
     title                  TEXT NOT NULL,
     severity               TEXT NOT NULL DEFAULT 'medium',
     status                 TEXT NOT NULL DEFAULT 'open',
     dedup_key              TEXT NOT NULL,
     signature              TEXT,
     recurrence_count       INTEGER NOT NULL DEFAULT 0,
     first_seen_version     TEXT,
     last_seen_version      TEXT,
     fixed_in_version       TEXT,
     regressed_from_issue_id TEXT,
     playbook_status        TEXT NOT NULL DEFAULT 'none',
     promoted_by            TEXT,
     wont_fix_reason        TEXT,
     related_spec           TEXT,
     probable_loop          INTEGER NOT NULL DEFAULT 0,
     created_at             INTEGER NOT NULL,
     updated_at             INTEGER NOT NULL
   )`,
  // Idempotent migration for ledgers created by §19.1/§19.2 (v1.3.5–1.3.8) that
  // predate promoted_by. Duplicate-column errors are swallowed in init (below).
  `ALTER TABLE framework_issues ADD COLUMN promoted_by TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_fwissues_dedup ON framework_issues(framework, dedup_key)`,
  `CREATE INDEX IF NOT EXISTS idx_fwissues_framework_pb ON framework_issues(framework, playbook_status)`,
  `CREATE INDEX IF NOT EXISTS idx_fwissues_bucket ON framework_issues(bucket)`,
  `CREATE INDEX IF NOT EXISTS idx_fwissues_status ON framework_issues(status)`,
  `CREATE TABLE IF NOT EXISTS framework_observations (
     id              TEXT PRIMARY KEY,
     issue_id        TEXT NOT NULL,
     framework       TEXT NOT NULL,
     evidence        TEXT,
     observed_version TEXT,
     observed_at     INTEGER NOT NULL,
     tick_id         TEXT,
     episode_key     TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_fwobs_issue ON framework_observations(issue_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_fwobs_episode ON framework_observations(issue_id, episode_key)`,
  `CREATE INDEX IF NOT EXISTS idx_fwobs_observed_at ON framework_observations(observed_at)`,
  // Capture-funnel (spec §5/§18): EVERY Stage-B capture run is logged here —
  // including runs that found nothing — so an inert/broken writer (runs > 0,
  // observations stuck at 0) is distinguishable from "ran, genuinely nothing to
  // report." The North Star anti-pattern guard: a silent no-op writer cannot
  // masquerade as a healthy quiet one.
  `CREATE TABLE IF NOT EXISTS framework_capture_runs (
     id                   TEXT PRIMARY KEY,
     framework            TEXT NOT NULL,
     tick_id              TEXT,
     findings_count       INTEGER NOT NULL DEFAULT 0,
     observations_written INTEGER NOT NULL DEFAULT 0,
     ran_at               INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_fwruns_framework ON framework_capture_runs(framework)`,
  `CREATE INDEX IF NOT EXISTS idx_fwruns_ran_at ON framework_capture_runs(ran_at)`,
];

// ── Types ───────────────────────────────────────────────────────────────────

export interface FrameworkIssueLedgerOptions {
  dbPath: string;
  /** Override clock for deterministic tests. */
  now?: () => number;
}

/** What Stage B emits per observation (spec §5). */
export interface RecordObservationInput {
  framework: string;
  bucket: IssueBucket;
  title: string;
  severity?: IssueSeverity;
  /** Conservative auto-merge key (spec §13.3). Required — identifies the canonical issue. */
  dedupKey: string;
  /** Richer fingerprint for probable-dup review (spec §13.3). */
  signature?: string;
  /** OPAQUE reference only — path+line, log ref, PR#, sentinel-event id (spec §13.2/§17). */
  evidence?: string;
  observedVersion?: string;
  tickId?: string;
  /**
   * Collapses repeated observations of the same open issue within a fix-window
   * to one episode (spec §13.4). Defaults to the observed version so an unfixed
   * issue accrues at most one episode per version span.
   */
  episodeKey?: string;
  /** Forced primary when dual-tagged (spec §6). */
  bucketPrimary?: IssueBucket;
  relatedSpec?: string;
}

export interface RecordObservationResult {
  issueId: string;
  created: boolean;
  episodeRecorded: boolean; // false when the episode was already counted (deduped)
  recurrenceCount: number;
  probableLoop: boolean;
}

export interface IssueRow {
  id: string;
  framework: string;
  bucket: IssueBucket;
  bucketPrimary: IssueBucket | null;
  title: string;
  severity: IssueSeverity;
  status: IssueStatus;
  dedupKey: string;
  signature: string | null;
  recurrenceCount: number;
  firstSeenVersion: string | null;
  lastSeenVersion: string | null;
  fixedInVersion: string | null;
  regressedFromIssueId: string | null;
  playbookStatus: PlaybookStatus;
  /** Non-Echo actor who attested the candidate→extracted promotion (§13.6). */
  promotedBy: string | null;
  wontFixReason: string | null;
  relatedSpec: string | null;
  probableLoop: boolean;
  createdAt: number;
  updatedAt: number;
  /** Derived at read (spec §13.4) — never stored, so a re-classification can't stale it. */
  generalizable: boolean;
  /** Derived at read: severityWeight × recurrenceCount × recency decay (spec §13.4). */
  impactScore: number;
}

export interface ListIssuesQuery {
  framework?: string;
  bucket?: IssueBucket;
  status?: IssueStatus;
  limit?: number;
}

export interface PlaybookQuery {
  targetFramework: string;
  limit?: number;
}

/** A single issue Stage-B forensics produced for a run (everything but the
 *  per-run framework/tickId, which `captureRun` supplies). */
export type ForensicFinding = Omit<RecordObservationInput, 'framework' | 'tickId'>;

export interface CaptureRunInput {
  framework: string;
  tickId?: string;
  findings: ForensicFinding[];
}

export interface CaptureRunResult {
  runId: string;
  framework: string;
  findingsCount: number;
  observationsWritten: number; // distinct episodes actually recorded this run
  newIssues: number;
  /** Previously-fixed issues whose signature/dedupKey matches a new finding —
   *  surfaced for human regression review, NOT auto-linked (spec §13.5). */
  regressionCandidates: Array<{ findingDedupKey: string; candidateIssueId: string }>;
}

export interface CaptureStats {
  totalRuns: number;
  totalObservationsWritten: number;
  lastRanAt: number | null;
  byFramework: Array<{ framework: string; runs: number; observations: number; lastRanAt: number }>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Reject anything that looks like an inlined secret/log-body rather than an
 * opaque pointer (spec §17). Returns a sanitized, length-capped string. We do
 * NOT silently store a suspected secret — we redact it and tag the evidence so
 * the capture is visibly degraded rather than leaking.
 */
const SECRET_PATTERNS: RegExp[] = [
  /\b(sk|pk|rk)-[A-Za-z0-9]{16,}\b/, // api-key-shaped
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/i,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // slack
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, // github
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/, // jwt
];

export function scanForSecret(s: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(s));
}

function sanitizeFreeText(s: string | undefined, cap: number): string {
  if (!s) return '';
  // Strip control chars; collapse whitespace; cap length.
  // eslint-disable-next-line no-control-regex
  const cleaned = s.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > cap ? cleaned.slice(0, cap) : cleaned;
}

function sanitizeEvidence(s: string | undefined): string | null {
  if (!s) return null;
  const capped = sanitizeFreeText(s, MAX_EVIDENCE);
  if (scanForSecret(capped)) {
    // Redact the body; keep a marker so the capture is visibly degraded (§17).
    return '[redacted: evidence matched a secret pattern — store an opaque reference, not log content]';
  }
  return capped;
}

function assertEnum<T extends string>(value: T, allowed: readonly T[], field: string): T {
  if (!allowed.includes(value)) {
    throw new Error(`FrameworkIssueLedger: invalid ${field} '${value}' (allowed: ${allowed.join(', ')})`);
  }
  return value;
}

// ── Ledger ──────────────────────────────────────────────────────────────────

export class FrameworkIssueLedger {
  private db: BetterSqliteDatabase;
  private now: () => number;

  constructor(opts: FrameworkIssueLedgerOptions) {
    this.now = opts.now ?? (() => Date.now());
    if (opts.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    }
    this.db = NativeModuleHealer.openWithHealSync(
      'FrameworkIssueLedger',
      () => new Database(opts.dbPath),
    );
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    // Close-on-exit registry (SqliteRegistry.ts) — closed once at shutdown.
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
    for (const ddl of SCHEMA) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        // ALTER TABLE … ADD COLUMN throws if the column already exists; that's
        // the idempotent-migration case. Swallow only that; rethrow anything else.
        if (!/duplicate column name/i.test((err as Error).message || '')) throw err;
      }
    }
    // §13.6: seed none→candidate for generalizable issues that were resolved
    // before the auto-suggestion existed (idempotent + self-limiting — matches
    // nothing after the first run). A backfill failure must never block ledger
    // construction (read-mostly infra); the next boot simply retries.
    try {
      this.backfillPlaybookCandidates();
    } catch {
      /* non-fatal: ledger remains usable; backfill retries next construction */
    }
  }

  /** Stable list of frameworks the ledger has seen — for the route allowlist (spec §5/§17). */
  knownFrameworks(): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT framework FROM framework_issues ORDER BY framework`)
      .all() as Array<{ framework: string }>;
    return rows.map((r) => r.framework);
  }

  /**
   * Record one Stage-B observation. Finds-or-creates the canonical issue via
   * (framework, dedupKey); collapses the observation into a distinct episode via
   * episodeKey; increments the materialized recurrence_count only on a new
   * episode (spec §13.4). All writes run in a single transaction (CAS-safe: the
   * UNIQUE(issue_id, episode_key) index is the concurrency guard — a racing
   * duplicate episode insert fails and is counted as already-recorded).
   */
  recordObservation(input: RecordObservationInput): RecordObservationResult {
    const framework = sanitizeFreeText(input.framework, 120);
    if (!framework) throw new Error('FrameworkIssueLedger: framework is required');
    const bucket = assertEnum(input.bucket, ISSUE_BUCKETS, 'bucket');
    const severity = assertEnum(input.severity ?? 'medium', ISSUE_SEVERITIES, 'severity');
    const dedupKey = sanitizeFreeText(input.dedupKey, 200);
    if (!dedupKey) throw new Error('FrameworkIssueLedger: dedupKey is required');
    const title = sanitizeFreeText(input.title, MAX_FREE_TEXT) || '(untitled)';
    const signature = input.signature ? sanitizeFreeText(input.signature, MAX_FREE_TEXT) : null;
    const evidence = sanitizeEvidence(input.evidence);
    const observedVersion = input.observedVersion ? sanitizeFreeText(input.observedVersion, 60) : null;
    const tickId = input.tickId ? sanitizeFreeText(input.tickId, 120) : null;
    const episodeKey = sanitizeFreeText(input.episodeKey ?? observedVersion ?? 'default', 200);
    const bucketPrimary = input.bucketPrimary
      ? assertEnum(input.bucketPrimary, ISSUE_BUCKETS, 'bucketPrimary')
      : null;
    const relatedSpec = input.relatedSpec ? sanitizeFreeText(input.relatedSpec, 200) : null;
    const ts = this.now();

    const txn = this.db.transaction((): RecordObservationResult => {
      // Find-or-create canonical issue.
      let issue = this.db
        .prepare(`SELECT * FROM framework_issues WHERE framework = ? AND dedup_key = ?`)
        .get(framework, dedupKey) as Record<string, unknown> | undefined;

      let created = false;
      let issueId: string;
      if (!issue) {
        issueId = crypto.randomUUID();
        this.db
          .prepare(
            `INSERT INTO framework_issues
               (id, framework, bucket, bucket_primary, title, severity, status, dedup_key,
                signature, recurrence_count, first_seen_version, last_seen_version,
                playbook_status, probable_loop, created_at, updated_at)
             VALUES (@id, @framework, @bucket, @bucketPrimary, @title, @severity, 'open', @dedupKey,
                @signature, 0, @observedVersion, @observedVersion, 'none', 0, @ts, @ts)`,
          )
          .run({ id: issueId, framework, bucket, bucketPrimary, title, severity, dedupKey, signature, observedVersion, ts });
        created = true;
        issue = { id: issueId };
      } else {
        issueId = issue.id as string;
        // Refresh last-seen + (non-destructively) escalate severity if higher.
        this.db
          .prepare(
            `UPDATE framework_issues
               SET last_seen_version = COALESCE(@observedVersion, last_seen_version),
                   severity = CASE WHEN @newWeight > @oldWeight THEN @severity ELSE severity END,
                   updated_at = @ts
             WHERE id = @id`,
          )
          .run({
            id: issueId,
            observedVersion,
            severity,
            newWeight: SEVERITY_WEIGHT[severity],
            oldWeight: SEVERITY_WEIGHT[(issue.severity as IssueSeverity) ?? 'medium'],
            ts,
          });
      }

      // Insert the observation as a distinct episode. UNIQUE(issue_id, episode_key)
      // collapses repeats within a fix-window to one episode (spec §13.4).
      let episodeRecorded = false;
      const obsId = crypto.randomUUID();
      const insert = this.db
        .prepare(
          `INSERT OR IGNORE INTO framework_observations
             (id, issue_id, framework, evidence, observed_version, observed_at, tick_id, episode_key)
           VALUES (@obsId, @issueId, @framework, @evidence, @observedVersion, @ts, @tickId, @episodeKey)`,
        )
        .run({ obsId, issueId, framework, evidence, observedVersion, ts, tickId, episodeKey });
      episodeRecorded = insert.changes > 0;

      if (episodeRecorded) {
        this.db
          .prepare(`UPDATE framework_issues SET recurrence_count = recurrence_count + 1, updated_at = ? WHERE id = ?`)
          .run(ts, issueId);
      }

      // Apply retention: keep first N + last M observations for this issue (§13.2).
      this.pruneObservations(issueId);

      // Probable-loop flag: too many observations in the trailing hour (§13.4).
      const recentCount = this.db
        .prepare(`SELECT COUNT(*) AS c FROM framework_observations WHERE issue_id = ? AND observed_at >= ?`)
        .get(issueId, ts - 60 * 60 * 1000) as { c: number };
      const probableLoop = recentCount.c >= PROBABLE_LOOP_PER_HOUR;
      this.db
        .prepare(`UPDATE framework_issues SET probable_loop = ? WHERE id = ?`)
        .run(probableLoop ? 1 : 0, issueId);

      const after = this.db
        .prepare(`SELECT recurrence_count FROM framework_issues WHERE id = ?`)
        .get(issueId) as { recurrence_count: number };

      return { issueId, created, episodeRecorded, recurrenceCount: after.recurrence_count, probableLoop };
    });

    return txn();
  }

  /** Retention pruning — keep first N + last M observations per issue (spec §13.2). */
  private pruneObservations(issueId: string): void {
    const total = this.db
      .prepare(`SELECT COUNT(*) AS c FROM framework_observations WHERE issue_id = ?`)
      .get(issueId) as { c: number };
    if (total.c <= RETENTION_KEEP_FIRST + RETENTION_KEEP_LAST) return;
    // Delete the middle band: everything not in the first-N or last-M by observed_at.
    this.db
      .prepare(
        `DELETE FROM framework_observations
           WHERE issue_id = @issueId
             AND id NOT IN (
               SELECT id FROM framework_observations WHERE issue_id = @issueId ORDER BY observed_at ASC LIMIT @first
             )
             AND id NOT IN (
               SELECT id FROM framework_observations WHERE issue_id = @issueId ORDER BY observed_at DESC LIMIT @last
             )`,
      )
      .run({ issueId, first: RETENTION_KEEP_FIRST, last: RETENTION_KEEP_LAST });
  }

  /**
   * Single-writer CAS mutate of an issue's mutable fields (status, bucket,
   * playbookStatus, regression link, etc.). Follows CommitmentTracker's
   * read-modify-write-with-version-check pattern; enum fields are validated.
   * `wont-fix` requires a reason (spec §13.7).
   */
  updateIssue(
    issueId: string,
    patch: Partial<{
      status: IssueStatus;
      bucket: IssueBucket;
      bucketPrimary: IssueBucket | null;
      playbookStatus: PlaybookStatus;
      fixedInVersion: string | null;
      regressedFromIssueId: string | null;
      wontFixReason: string | null;
      relatedSpec: string | null;
    }>,
  ): IssueRow | null {
    const txn = this.db.transaction((): IssueRow | null => {
      const cur = this.db.prepare(`SELECT * FROM framework_issues WHERE id = ?`).get(issueId) as
        | Record<string, unknown>
        | undefined;
      if (!cur) return null;

      const status = patch.status ? assertEnum(patch.status, ISSUE_STATUSES, 'status') : (cur.status as IssueStatus);
      const bucket = patch.bucket ? assertEnum(patch.bucket, ISSUE_BUCKETS, 'bucket') : (cur.bucket as IssueBucket);
      let playbookStatus = patch.playbookStatus
        ? assertEnum(patch.playbookStatus, PLAYBOOK_STATUSES, 'playbookStatus')
        : (cur.playbook_status as PlaybookStatus);
      const bucketPrimary =
        patch.bucketPrimary !== undefined
          ? patch.bucketPrimary
            ? assertEnum(patch.bucketPrimary, ISSUE_BUCKETS, 'bucketPrimary')
            : null
          : (cur.bucket_primary as IssueBucket | null);
      const wontFixReason =
        patch.wontFixReason !== undefined ? sanitizeFreeText(patch.wontFixReason ?? '', MAX_FREE_TEXT) || null : (cur.wont_fix_reason as string | null);

      if (status === 'wont-fix' && !wontFixReason) {
        throw new Error('FrameworkIssueLedger: wont-fix requires a wontFixReason (spec §13.7)');
      }

      // §13.6 auto-suggest: when a generalizable issue reaches a terminal-resolved
      // state (fixed | wont-fix) its lesson is fully formed and should feed the
      // NEXT framework's onboarding playbook — so promote none→candidate in the
      // same write. Without this the playbook stays permanently empty: lessons are
      // logged but never surface (every issue sits at 'none', and nothing else
      // auto-suggests candidates). Only none→candidate is automated here; the
      // candidate→extracted step still requires a non-Echo attestation via
      // promotePlaybook(). Never downgrades (acts only on 'none'); skipped when the
      // caller set playbookStatus explicitly.
      if (
        patch.playbookStatus === undefined &&
        playbookStatus === 'none' &&
        (status === 'fixed' || status === 'wont-fix') &&
        GENERALIZABLE_BUCKETS.has(bucket)
      ) {
        playbookStatus = 'candidate';
      }

      this.db
        .prepare(
          `UPDATE framework_issues SET
             status = @status, bucket = @bucket, bucket_primary = @bucketPrimary,
             playbook_status = @playbookStatus,
             fixed_in_version = @fixedInVersion, regressed_from_issue_id = @regressedFromIssueId,
             wont_fix_reason = @wontFixReason, related_spec = @relatedSpec, updated_at = @ts
           WHERE id = @id`,
        )
        .run({
          id: issueId,
          status,
          bucket,
          bucketPrimary,
          playbookStatus,
          fixedInVersion:
            patch.fixedInVersion !== undefined ? patch.fixedInVersion : (cur.fixed_in_version as string | null),
          regressedFromIssueId:
            patch.regressedFromIssueId !== undefined
              ? patch.regressedFromIssueId
              : (cur.regressed_from_issue_id as string | null),
          wontFixReason,
          relatedSpec: patch.relatedSpec !== undefined ? patch.relatedSpec : (cur.related_spec as string | null),
          ts: this.now(),
        });
      return this.getIssue(issueId);
    });
    return txn();
  }

  /**
   * Promote an issue along the playbook lifecycle (spec §13.6):
   *   none → candidate → extracted → superseded.
   * `none → candidate` may be auto-suggested by Stage B (any actor). But
   * `candidate → extracted` — the step that puts a lesson into the reusable
   * onboarding checklist — REQUIRES a non-Echo attestation, so the playbook's
   * contents are never end-to-end under the proposing agent's control. The
   * attesting actor is recorded in `promoted_by`. Throws if Echo attempts the
   * `extracted` promotion itself.
   */
  promotePlaybook(issueId: string, target: PlaybookStatus, promotedBy: string): IssueRow | null {
    assertEnum(target, PLAYBOOK_STATUSES, 'playbookStatus');
    const actor = sanitizeFreeText(promotedBy, 120).toLowerCase();
    if (target === 'extracted' && (!actor || actor === 'echo')) {
      throw new Error(
        'FrameworkIssueLedger: candidate→extracted requires a non-Echo attestation (spec §13.6) — ' +
          'the proposing agent cannot promote its own lessons into the playbook',
      );
    }
    const txn = this.db.transaction((): IssueRow | null => {
      const cur = this.db.prepare(`SELECT id FROM framework_issues WHERE id = ?`).get(issueId);
      if (!cur) return null;
      this.db
        .prepare(`UPDATE framework_issues SET playbook_status = ?, promoted_by = ?, updated_at = ? WHERE id = ?`)
        .run(target, target === 'extracted' ? actor : null, this.now(), issueId);
      return this.getIssue(issueId);
    });
    return txn();
  }

  /**
   * Idempotent backfill of the §13.6 none→candidate auto-suggestion for issues
   * that were already terminal-resolved (fixed | wont-fix) and generalizable
   * BEFORE that auto-suggestion existed — their lessons were logged but stuck at
   * 'none', so the onboarding playbook never surfaced them. Promotes every such
   * row to 'candidate'; never touches candidate/extracted/superseded rows; never
   * promotes non-generalizable or non-terminal issues. Self-limiting (the WHERE
   * clause matches nothing after the first run) so it is safe to call on every
   * boot — which is how existing ledgers across the fleet pick up the seeding
   * without a dedicated PostUpdateMigrator entry. Returns the rows promoted.
   * candidate→extracted still requires a non-Echo attestation (promotePlaybook);
   * this only seeds candidates.
   */
  backfillPlaybookCandidates(): number {
    const res = this.db
      .prepare(
        `UPDATE framework_issues SET playbook_status = 'candidate', updated_at = @ts
           WHERE playbook_status = 'none'
             AND status IN ('fixed', 'wont-fix')
             AND bucket IN ('framework-limitation', 'instar-integration-gap')`,
      )
      .run({ ts: this.now() });
    return res.changes;
  }

  /** Bucket-distribution telemetry (spec §15) — surfaces attribution skew (a
   *  sudden spike in `generic-agent-mistake` is the "blame the mentee" tell). */
  observability(): {
    bucketDistribution: Record<IssueBucket, number>;
    leakSuspected: number;
    probableLoops: number;
    playbookExtracted: number;
  } {
    const buckets = this.db
      .prepare(`SELECT bucket, COUNT(*) AS c FROM framework_issues GROUP BY bucket`)
      .all() as Array<{ bucket: IssueBucket; c: number }>;
    const dist: Record<IssueBucket, number> = {
      'framework-limitation': 0,
      'instar-integration-gap': 0,
      'generic-agent-mistake': 0,
    };
    for (const b of buckets) if (b.bucket in dist) dist[b.bucket] = b.c;
    const leak = this.db
      .prepare(`SELECT COUNT(*) AS c FROM framework_issues WHERE signature = 'stage-a-leak-suspected'`)
      .get() as { c: number };
    const loops = this.db
      .prepare(`SELECT COUNT(*) AS c FROM framework_issues WHERE probable_loop = 1`)
      .get() as { c: number };
    const extracted = this.db
      .prepare(`SELECT COUNT(*) AS c FROM framework_issues WHERE playbook_status = 'extracted'`)
      .get() as { c: number };
    return {
      bucketDistribution: dist,
      leakSuspected: leak.c,
      probableLoops: loops.c,
      playbookExtracted: extracted.c,
    };
  }

  /**
   * Suggest a regression link: a new issue whose signature/dedupKey matches a
   * previously-`fixed` issue is a candidate regression (spec §13.5). Returns the
   * matching fixed issues (does NOT auto-link — review decides).
   */
  suggestRegressions(input: { framework: string; dedupKey: string; signature?: string | null }): IssueRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM framework_issues
           WHERE framework = ? AND status = 'fixed'
             AND (dedup_key = ? OR (signature IS NOT NULL AND signature = ?))`,
      )
      .all(input.framework, input.dedupKey, input.signature ?? '__none__') as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToIssue(r));
  }

  getIssue(id: string): IssueRow | null {
    const r = this.db.prepare(`SELECT * FROM framework_issues WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? this.rowToIssue(r) : null;
  }

  listIssues(q: ListIssuesQuery = {}): IssueRow[] {
    const clauses: string[] = [];
    const params: Record<string, unknown> = {};
    if (q.framework) {
      clauses.push(`framework = @framework`);
      params.framework = q.framework;
    }
    if (q.bucket) {
      clauses.push(`bucket = @bucket`);
      params.bucket = assertEnum(q.bucket, ISSUE_BUCKETS, 'bucket');
    }
    if (q.status) {
      clauses.push(`status = @status`);
      params.status = assertEnum(q.status, ISSUE_STATUSES, 'status');
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = clampLimit(q.limit);
    const rows = this.db
      .prepare(`SELECT * FROM framework_issues ${where} ORDER BY updated_at DESC LIMIT @limit`)
      .all({ ...params, limit }) as Array<Record<string, unknown>>;
    return rows.map((r) => this.rowToIssue(r));
  }

  /**
   * The onboarding playbook for `targetFramework`: generalizable lessons from
   * PRIOR (other) frameworks, ranked by impactScore (spec §13.6). The playbook
   * for X is sourced from frameworks != X — never X's own issues.
   */
  playbook(q: PlaybookQuery): IssueRow[] {
    const limit = clampLimit(q.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM framework_issues
           WHERE framework != @targetFramework
             AND bucket IN ('framework-limitation', 'instar-integration-gap')
             AND playbook_status IN ('candidate', 'extracted')`,
      )
      .all({ targetFramework: q.targetFramework }) as Array<Record<string, unknown>>;
    return rows
      .map((r) => this.rowToIssue(r))
      .sort((a, b) => b.impactScore - a.impactScore)
      .slice(0, limit);
  }

  observationCount(issueId: string): number {
    const r = this.db
      .prepare(`SELECT COUNT(*) AS c FROM framework_observations WHERE issue_id = ?`)
      .get(issueId) as { c: number };
    return r.c;
  }

  /**
   * Stage-B auto-capture (spec §5, §19.2). The single atomic entry point the
   * mentor tick calls after forensics: it writes every finding to the ledger
   * (no "remember to log" — zero-manual-capture) and ALWAYS logs the run to the
   * capture-funnel, even when `findings` is empty. That funnel row is what makes
   * an inert/broken writer visible: a run that produced zero observations is
   * recorded as a run, so "ran, found nothing" is distinguishable from "never
   * ran." Regression candidates are surfaced for review, never auto-linked
   * (spec §13.5 — promotion is not the writer's call).
   */
  captureRun(input: CaptureRunInput): CaptureRunResult {
    const framework = sanitizeFreeText(input.framework, 120);
    if (!framework) throw new Error('FrameworkIssueLedger: captureRun requires a framework');
    const tickId = input.tickId ? sanitizeFreeText(input.tickId, 120) : null;
    const findings = input.findings ?? [];

    let observationsWritten = 0;
    let newIssues = 0;
    const regressionCandidates: Array<{ findingDedupKey: string; candidateIssueId: string }> = [];

    // Each recordObservation is its own transaction (better-sqlite3 has no
    // nested transactions); the funnel row is written last with the real count.
    for (const finding of findings) {
      const res = this.recordObservation({ ...finding, framework, tickId: tickId ?? undefined });
      if (res.episodeRecorded) observationsWritten++;
      if (res.created) {
        newIssues++;
        // A brand-new issue that matches a previously-fixed one is a candidate
        // regression — surface it (review decides), never silently auto-link.
        const candidates = this.suggestRegressions({
          framework,
          dedupKey: finding.dedupKey,
          signature: finding.signature ?? null,
        }).filter((c) => c.id !== res.issueId);
        for (const c of candidates) {
          regressionCandidates.push({ findingDedupKey: finding.dedupKey, candidateIssueId: c.id });
        }
      }
    }

    const runId = crypto.randomUUID();
    this.db
      .prepare(
        `INSERT INTO framework_capture_runs (id, framework, tick_id, findings_count, observations_written, ran_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(runId, framework, tickId, findings.length, observationsWritten, this.now());

    return { runId, framework, findingsCount: findings.length, observationsWritten, newIssues, regressionCandidates };
  }

  /** Capture-funnel observability (spec §5/§18). Surfaces ticks→observations so
   *  a writer that runs but never writes is visible. */
  captureStats(): CaptureStats {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(observations_written), 0) AS obs, MAX(ran_at) AS last
           FROM framework_capture_runs`,
      )
      .get() as { runs: number; obs: number; last: number | null };
    const byFw = this.db
      .prepare(
        `SELECT framework, COUNT(*) AS runs, COALESCE(SUM(observations_written), 0) AS obs, MAX(ran_at) AS last
           FROM framework_capture_runs GROUP BY framework ORDER BY last DESC`,
      )
      .all() as Array<{ framework: string; runs: number; obs: number; last: number }>;
    return {
      totalRuns: totals.runs,
      totalObservationsWritten: totals.obs,
      lastRanAt: totals.last ?? null,
      byFramework: byFw.map((r) => ({ framework: r.framework, runs: r.runs, observations: r.obs, lastRanAt: r.last })),
    };
  }

  private rowToIssue(r: Record<string, unknown>): IssueRow {
    const bucket = r.bucket as IssueBucket;
    const severity = (r.severity as IssueSeverity) ?? 'medium';
    const recurrenceCount = (r.recurrence_count as number) ?? 0;
    const updatedAt = (r.updated_at as number) ?? 0;
    // Recency decay (spec §13.4): a long-stale issue doesn't permanently dominate.
    const ageMs = Math.max(0, this.now() - updatedAt);
    const decay = Math.pow(0.5, ageMs / RECENCY_HALF_LIFE_MS);
    const impactScore = SEVERITY_WEIGHT[severity] * recurrenceCount * decay;
    return {
      id: r.id as string,
      framework: r.framework as string,
      bucket,
      bucketPrimary: (r.bucket_primary as IssueBucket | null) ?? null,
      title: r.title as string,
      severity,
      status: r.status as IssueStatus,
      dedupKey: r.dedup_key as string,
      signature: (r.signature as string | null) ?? null,
      recurrenceCount,
      firstSeenVersion: (r.first_seen_version as string | null) ?? null,
      lastSeenVersion: (r.last_seen_version as string | null) ?? null,
      fixedInVersion: (r.fixed_in_version as string | null) ?? null,
      regressedFromIssueId: (r.regressed_from_issue_id as string | null) ?? null,
      playbookStatus: r.playbook_status as PlaybookStatus,
      promotedBy: (r.promoted_by as string | null) ?? null,
      wontFixReason: (r.wont_fix_reason as string | null) ?? null,
      relatedSpec: (r.related_spec as string | null) ?? null,
      probableLoop: !!(r.probable_loop as number),
      createdAt: (r.created_at as number) ?? 0,
      updatedAt,
      generalizable: GENERALIZABLE_BUCKETS.has(bucket),
      impactScore: Math.round(impactScore * 1000) / 1000,
    };
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

/** Clamp a list limit to 1..500 (spec §5/§17). */
export function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return 100;
  return Math.max(1, Math.min(500, Math.floor(n)));
}
