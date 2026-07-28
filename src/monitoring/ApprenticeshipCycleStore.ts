/**
 * ApprenticeshipCycleStore — durable differential-cycle capture.
 *
 * One row per apprenticeship/mentorship cycle. This is intentionally
 * persistence-only: the store records what the mentee produced, what the mentor
 * flagged, what the overseer differential found, coaching, and infra follow-up
 * items. It does not judge quality or drive lifecycle transitions.
 */
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';

export interface ApprenticeshipCycleStoreOptions {
  /** SQLite DB path. Use `:memory:` for tests. */
  dbPath: string;
  /** Override clock for deterministic tests. */
  now?: () => Date;
}

export interface ApprenticeshipCycleRecordInput {
  id?: string;
  instanceId: string;
  cycleNumber: number;
  createdAt?: string;
  task: string;
  menteeOutput: string;
  mentorFlagged?: string[];
  overseerDifferential?: string[];
  coaching?: string;
  infraItems?: string[];
  kind?: string;
  status?: string;
  /** The channel this cycle's mentor↔mentee interaction ACTUALLY ran through
   *  (the dogfooded-channel standard, APPRENTICESHIP-PROGRAM-PROJECT-DESIGN §4a). */
  channel?: string;
  /** REQUIRED operator-seat UX verdict (2026-06-05 UX-blindspot directive).
   *  Typed loose here so the runtime gate — not the compiler — produces the
   *  self-describing refusal callers actually see over HTTP. */
  operatorSeatUx?: unknown;
  /** REQUIRED for telegram-playwright cycles: the objective post-drive
   *  transcript-audit artifact (PR #864's report, distilled). Typed loose for
   *  the same runtime-gate reason as operatorSeatUx. */
  transcriptAudit?: unknown;
}

/**
 * The objective half of the cycle's observation record — proof that the
 * post-drive transcript auditor (`instar dev:post-drive-transcript-audit`,
 * PR #864) actually RAN over this drive's window.
 *
 * WHY THIS IS REQUIRED (Observation Needs Structure, PR #861): #856 gated the
 * mentor's SUBJECTIVE seat-counts, but the judgment-free auditor shipped as a
 * manual CLI — nothing structurally guaranteed it ran after a drive. An
 * observation tool nobody is forced to run is the same wish the article bans,
 * one level up. This block makes the audit an unskippable artifact on the
 * channel whose entire point is UX-under-test.
 *
 * `ledger` is an honesty declaration of where findings were filed:
 *  - 'local'   — filed into THIS agent's framework ledger (cross-checkable;
 *                the route verifies the dedup keys actually resolve).
 *  - 'remote'  — filed into another agent's ledger (e.g. the mentee's server
 *                holds the transcript AND took the observations).
 *  - 'dry-run' — auditor ran with --dry-run; findings counted, none filed.
 *  - 'failed'  — auditor ran but filing failed; reason belongs in `notes`.
 */
export interface TranscriptAuditAttachment {
  /** Topic ids the auditor read (the drive's actual transcript locations). */
  topicIds: number[];
  /** The audited drive window (ISO timestamps). */
  window: { start: string; end: string };
  /** The report's per-category counts (e.g. { 'asks-of-user': 1, total: 3 }). */
  summary: Record<string, number>;
  /** Stable dedup keys of every finding (empty array = clean drive). */
  findingDedupKeys: string[];
  /** Report generation timestamp (ISO). */
  generatedAt: string;
  /** Where the findings were filed — see interface doc. */
  ledger: 'local' | 'remote' | 'dry-run' | 'failed';
  /** Free-form context (e.g. the remote base-url, or why filing failed). */
  notes?: string;
}

/**
 * The operator-seat UX verdict — what a HUMAN sitting in the user's chair
 * would have experienced during this cycle's drive.
 *
 * WHY THIS IS REQUIRED (the 2026-06-05 UX-blindspot incident): the mentor
 * prompt had instructed "observe the Telegram UX" for weeks as prose; 35
 * ledger findings later, not one was experience-framed — the operator found
 * the resend-asks / duplicate notices / photo failures himself. A standing
 * responsibility to NOTICE something is a wish unless an unskippable artifact
 * proves the looking happened. record() refuses cycles without this block.
 *
 * The counts are the agent's antidote to its own pain-threshold asymmetry:
 * an agent compensates for friction at zero felt cost (resends, ignores
 * duplicates), so the block forces it to COUNT what it compensated for.
 */
export interface OperatorSeatUx {
  /** Duplicate deliveries/notices observed in the drive window ("actively working" x2, replayed messages). */
  dupNotices: number;
  /** Infra-noise messages a human user shouldn't have to see (restart/queue chatter, internal status leaks). */
  infraNoiseMsgs: number;
  /** Times the mentee asked the USER to do machine work (resend, retry, re-paste). Each one is a finding. */
  asksOfUser: number;
  /** Updates carrying no information a user could act on ("still working, nothing to report" filler). */
  contentFreeUpdates: number;
  /** Modalities actually exercised this drive (e.g. 'text', 'photo', 'file'). Coverage = what's listed here, nothing more. */
  modalitiesExercised: string[];
  /** Whether the drive overlapped restart churn / degraded infra — bad-weather coverage is part of the job. */
  duringRestartChurn: boolean;
  /** Free-form observations from the user's chair. */
  notes?: string;
}

export const APPRENTICESHIP_CYCLE_AXES = [
  'mentor-mentee-differential',
  'overseer-apprentice-devreview',
  'overseer-mentee-direct',
] as const;

export type ApprenticeshipCycleAxis = typeof APPRENTICESHIP_CYCLE_AXES[number];
export type ApprenticeshipCycleKind = ApprenticeshipCycleAxis | 'unknown';

/**
 * How a cycle's mentor↔mentee interaction actually ran (§4a "dogfooded channel").
 *  - `telegram-playwright` — THE channel: the mentor drove the mentee through the
 *    real Telegram UX via the dedicated Playwright profile (experiences the UX).
 *  - `threadline-backup`   — the backup transport (only when Playwright can't reach
 *    Telegram); still counts toward the keystone.
 *  - `direct-shortcut`     — a CLI/API shortcut that bypassed the UX-under-test;
 *    recorded for honesty but does NOT count toward the keystone axis.
 *  - `unknown`             — unset / grandfathered (pre-field cycles); counts, so the
 *    enforcement never retroactively un-fires an already-earned keystone.
 */
export const APPRENTICESHIP_CYCLE_CHANNELS = [
  'telegram-playwright',
  'threadline-backup',
  'direct-shortcut',
  'unknown',
] as const;
export type ApprenticeshipCycleChannel = typeof APPRENTICESHIP_CYCLE_CHANNELS[number];

export interface ApprenticeshipRoleAxisCoverage {
  fired: boolean;
  cycleCount: number;
  lastAt: string | null;
}

/**
 * The keystone axis — the ONE that proves the recursion actually ran at its
 * deepest layer (the mentor actually drove the mentee, vs merely reviewing or
 * overseeing). Surfacing its health is what makes the 2026-06-06 imbalance
 * (mentor-heavy / mentee-light: the mentor layer ran 13 cycles while the
 * mentee layer ran 3) a VISIBLE tracked fact instead of something only a human
 * notices weeks later. "Observation Needs Structure" applied to layer balance.
 */
export const APPRENTICESHIP_KEYSTONE_AXIS: ApprenticeshipCycleAxis = 'mentor-mentee-differential';

/** Oversight axes — review/direct activity that is NOT the keystone drive. A
 *  program busy on these while the keystone goes stale is drifting away from
 *  actually exercising its mentee. */
export const APPRENTICESHIP_OVERSIGHT_AXES: ApprenticeshipCycleAxis[] = [
  'overseer-apprentice-devreview',
  'overseer-mentee-direct',
];

/** Default: this many oversight cycles AFTER the last keystone cycle marks the
 *  deepest layer as starved (the program kept reviewing/overseeing without
 *  driving the mentee). Observe-only threshold; tune via roleCoverage opts. */
export const DEFAULT_KEYSTONE_STARVATION_OVERSIGHT = 3;

/** Default: the keystone (deepest) layer is DORMANT once its last drive is this
 *  old, regardless of oversight activity. Distinct from `starved` (which needs
 *  oversight to pile up): dormancy is the wall-clock silence that masks as
 *  "healthy" when the whole layer simply goes quiet — the exact blind spot the
 *  bare oversight-since-keystone count can't see. 6h: long enough not to fire on
 *  a normal gap between mentee drives, short enough to catch a real stall.
 *  Observe-only; tune via roleCoverage opts. */
export const DEFAULT_KEYSTONE_DORMANCY_MS = 6 * 60 * 60 * 1000;

/**
 * Observe-only health of the keystone (deepest) layer for one instance. Never
 * gates or blocks — it makes "is the mentee layer actually running?" a
 * queryable fact. `starved=true` means the program is active but its deepest
 * layer is under-firing: either the keystone never ran while oversight did, or
 * enough oversight has piled up since the last keystone drive that the layer
 * has clearly drifted. The generalization of the older narrow `driftWarning`.
 */
export interface ApprenticeshipKeystoneBalance {
  keystoneAxis: ApprenticeshipCycleAxis;
  keystoneCycleCount: number;
  lastKeystoneAt: string | null;
  /** Combined cycle count across the oversight axes. */
  oversightCycleCount: number;
  /** Oversight cycles recorded strictly AFTER the last keystone cycle (or all
   *  of them, if the keystone never fired). */
  oversightSinceKeystone: number;
  /** The deepest layer is under-firing relative to ongoing program activity. */
  starved: boolean;
  /** The threshold actually applied (so callers can show "3 of 3"). */
  starvationThreshold: number;
  /** Milliseconds since the last keystone drive (null if it never fired). The
   *  wall-clock staleness `oversightSinceKeystone` is blind to. */
  lastKeystoneAgeMs: number | null;
  /** The keystone fired before, but its last drive is older than the dormancy
   *  threshold — the deepest layer has gone quiet. Orthogonal to `starved`: a
   *  layer can be dormant without any oversight piling up (total silence reads
   *  "healthy" to the starvation check, which is the gap this closes). */
  dormant: boolean;
  /** The dormancy threshold actually applied, in milliseconds. */
  dormancyThresholdMs: number;
  /** Plain-English why, for surfacing to a human. */
  reason: string;
}

export interface ApprenticeshipRoleCoverage {
  instanceId: string;
  axes: Record<ApprenticeshipCycleAxis, ApprenticeshipRoleAxisCoverage>;
  unknown: ApprenticeshipRoleAxisCoverage;
  dormantAxes: ApprenticeshipCycleAxis[];
  driftWarning: boolean;
  /** mentor-mentee-differential cycles that ran via a `direct-shortcut` (so they
   *  did NOT count toward the keystone axis). Surfaced for honesty — a shortcut is
   *  recorded but can never make the keystone look healthy (§4a enforcement). */
  shortcutDifferentialCount: number;
  /** Observe-only deepest-layer health (the 2026-06-06 mentor/mentee balance
   *  signal). Never gates; surfaces the imbalance so it can't silently drift. */
  keystoneBalance: ApprenticeshipKeystoneBalance;
  /** Same UUID observed with different coverage-relevant fields across stores. */
  coverageConflictingCycleIds: string[];
}

export interface RoleCoverageOptions {
  /** Oversight-since-keystone count that marks the deepest layer starved.
   *  Defaults to DEFAULT_KEYSTONE_STARVATION_OVERSIGHT. */
  oversightStarvationThreshold?: number;
  /** Age (ms) past which the keystone layer is reported DORMANT regardless of
   *  oversight. Defaults to DEFAULT_KEYSTONE_DORMANCY_MS. */
  keystoneDormancyMs?: number;
}

export interface ApprenticeshipCycleRecord {
  id: string;
  instanceId: string;
  cycleNumber: number;
  createdAt: string;
  task: string;
  menteeOutput: string;
  mentorFlagged: string[];
  overseerDifferential: string[];
  coaching: string;
  infraItems: string[];
  kind: ApprenticeshipCycleKind;
  status: string;
  channel: ApprenticeshipCycleChannel;
  /** null only on legacy rows recorded before the gate (grandfathered, like channel='unknown'). */
  operatorSeatUx: OperatorSeatUx | null;
  /** null on legacy rows and on channels where the audit is optional and was not supplied. */
  transcriptAudit: TranscriptAuditAttachment | null;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS apprenticeship_cycles (
     id                    TEXT PRIMARY KEY,
     instance_id           TEXT NOT NULL,
     cycle_number          INTEGER NOT NULL,
     created_at            TEXT NOT NULL,
     task                  TEXT NOT NULL,
     mentee_output         TEXT NOT NULL,
     mentor_flagged_json   TEXT NOT NULL,
     overseer_diff_json    TEXT NOT NULL,
     coaching              TEXT NOT NULL,
     infra_items_json      TEXT NOT NULL,
     kind                  TEXT NOT NULL,
     status                TEXT NOT NULL,
     channel               TEXT NOT NULL DEFAULT 'unknown',
     operator_seat_ux_json TEXT NOT NULL DEFAULT '',
     transcript_audit_json TEXT NOT NULL DEFAULT ''
   )`,
  `CREATE INDEX IF NOT EXISTS idx_apprenticeship_cycles_instance_created
     ON apprenticeship_cycles(instance_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_apprenticeship_cycles_created
     ON apprenticeship_cycles(created_at DESC)`,
];

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  return value;
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() !== '' ? value : fallback;
}

function stringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${field} must be an array of strings`);
  }
  return value;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function clampLimit(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return 50;
  return Math.max(1, Math.min(500, Math.floor(n)));
}

function normalizeKind(raw: unknown): ApprenticeshipCycleKind {
  if (raw === undefined || raw === null || raw === '') return 'mentor-mentee-differential';
  if (raw === 'differential-cycle') return 'unknown';
  if (raw === 'unknown' || APPRENTICESHIP_CYCLE_AXES.includes(raw as ApprenticeshipCycleAxis)) {
    return raw as ApprenticeshipCycleKind;
  }
  throw new Error(`kind must be one of ${[...APPRENTICESHIP_CYCLE_AXES, 'unknown'].join(', ')}`);
}

/** Legacy rows must remain readable even when their historical kind predates the enum. */
function normalizeStoredKind(raw: unknown): ApprenticeshipCycleKind {
  try {
    return normalizeKind(raw);
  } catch {
    return 'unknown';
  }
}

function normalizeChannel(raw: unknown): ApprenticeshipCycleChannel {
  if (
    typeof raw === 'string' &&
    (APPRENTICESHIP_CYCLE_CHANNELS as readonly string[]).includes(raw)
  ) {
    return raw as ApprenticeshipCycleChannel;
  }
  return 'unknown';
}

/** The exact shape named in the refusal so a blocked caller can self-serve the fix. */
const OPERATOR_SEAT_UX_SHAPE =
  '{ dupNotices: int>=0, infraNoiseMsgs: int>=0, asksOfUser: int>=0, contentFreeUpdates: int>=0, ' +
  "modalitiesExercised: string[] (e.g. ['text','photo']), duringRestartChurn: boolean, notes?: string }";

function nonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `operatorSeatUx.${field} must be a non-negative integer (got ${JSON.stringify(value)}). Required shape: ${OPERATOR_SEAT_UX_SHAPE}`,
    );
  }
  return value;
}

/**
 * THE GATE (2026-06-05 UX-blindspot directive, Justin-approved): a cycle
 * record without an operator-seat UX verdict is refused — observation without
 * a required artifact is indistinguishable from no observation. The refusal
 * message carries the full required shape so the blocked caller (the mentor
 * loop, over HTTP) can fix its next attempt without archaeology.
 */
function requireOperatorSeatUx(raw: unknown): OperatorSeatUx {
  if (raw === undefined || raw === null) {
    throw new Error(
      'operatorSeatUx is required: every apprenticeship cycle must record what a human in the ' +
        "user's seat experienced during the drive (UX-blindspot gate, 2026-06-05). " +
        `Required shape: ${OPERATOR_SEAT_UX_SHAPE}`,
    );
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`operatorSeatUx must be an object. Required shape: ${OPERATOR_SEAT_UX_SHAPE}`);
  }
  const o = raw as Record<string, unknown>;
  const modalities = o.modalitiesExercised;
  if (!Array.isArray(modalities) || modalities.length === 0 || !modalities.every((m) => typeof m === 'string' && m.trim() !== '')) {
    throw new Error(
      `operatorSeatUx.modalitiesExercised must be a non-empty string array — coverage equals what is listed, nothing more. Required shape: ${OPERATOR_SEAT_UX_SHAPE}`,
    );
  }
  if (typeof o.duringRestartChurn !== 'boolean') {
    throw new Error(
      `operatorSeatUx.duringRestartChurn must be a boolean (was the drive during restart churn / degraded infra?). Required shape: ${OPERATOR_SEAT_UX_SHAPE}`,
    );
  }
  if (o.notes !== undefined && typeof o.notes !== 'string') {
    throw new Error(`operatorSeatUx.notes must be a string when present. Required shape: ${OPERATOR_SEAT_UX_SHAPE}`);
  }
  return {
    dupNotices: nonNegativeInt(o.dupNotices, 'dupNotices'),
    infraNoiseMsgs: nonNegativeInt(o.infraNoiseMsgs, 'infraNoiseMsgs'),
    asksOfUser: nonNegativeInt(o.asksOfUser, 'asksOfUser'),
    contentFreeUpdates: nonNegativeInt(o.contentFreeUpdates, 'contentFreeUpdates'),
    modalitiesExercised: modalities as string[],
    duringRestartChurn: o.duringRestartChurn,
    ...(typeof o.notes === 'string' ? { notes: o.notes } : {}),
  };
}

/** The exact shape named in the transcript-audit refusal so a blocked caller can self-serve. */
const TRANSCRIPT_AUDIT_SHAPE =
  '{ topicIds: int[]>0, window: { start: ISO, end: ISO }, summary: Record<string,int>, ' +
  "findingDedupKeys: string[], generatedAt: ISO, ledger: 'local'|'remote'|'dry-run'|'failed', notes?: string }";

const TRANSCRIPT_AUDIT_LEDGERS = new Set(['local', 'remote', 'dry-run', 'failed']);

function isIsoParseable(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/**
 * THE AUDIT GATE (Observation Needs Structure, follow-through on PR #864):
 * a telegram-playwright cycle without the objective transcript-audit artifact
 * is refused — the auditor exists precisely so compensation can't hide
 * friction, so a dogfooded-channel cycle that skipped it is an unobserved
 * drive. The refusal teaches the exact CLI that produces the artifact.
 */
function validateTranscriptAudit(raw: unknown, channel: ApprenticeshipCycleChannel): TranscriptAuditAttachment | null {
  if (raw === undefined || raw === null) {
    if (channel === 'telegram-playwright') {
      throw new Error(
        'transcriptAudit is required for telegram-playwright cycles: run ' +
          '`instar dev:post-drive-transcript-audit --topic <driveTopicId> --start <windowStart> --end <windowEnd> --json` ' +
          'over the drive window (point --history-base-url at the server holding the transcript when it is not this one), ' +
          `then attach { topicIds, window, summary, findingDedupKeys, generatedAt, ledger }. Required shape: ${TRANSCRIPT_AUDIT_SHAPE}`,
      );
    }
    return null;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`transcriptAudit must be an object. Required shape: ${TRANSCRIPT_AUDIT_SHAPE}`);
  }
  const o = raw as Record<string, unknown>;
  const topicIds = o.topicIds;
  if (!Array.isArray(topicIds) || topicIds.length === 0 || !topicIds.every((t) => Number.isInteger(t) && (t as number) > 0)) {
    throw new Error(`transcriptAudit.topicIds must be a non-empty array of positive integers. Required shape: ${TRANSCRIPT_AUDIT_SHAPE}`);
  }
  const window = o.window as Record<string, unknown> | undefined;
  if (!window || typeof window !== 'object' || Array.isArray(window) || !isIsoParseable(window.start) || !isIsoParseable(window.end)) {
    throw new Error(`transcriptAudit.window must be { start, end } with parseable timestamps. Required shape: ${TRANSCRIPT_AUDIT_SHAPE}`);
  }
  if (Date.parse(window.end as string) < Date.parse(window.start as string)) {
    throw new Error('transcriptAudit.window.end must be at or after window.start');
  }
  const summary = o.summary;
  if (
    !summary || typeof summary !== 'object' || Array.isArray(summary) ||
    !Object.values(summary as Record<string, unknown>).every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0)
  ) {
    throw new Error(`transcriptAudit.summary must be an object of non-negative integer counts. Required shape: ${TRANSCRIPT_AUDIT_SHAPE}`);
  }
  const keys = o.findingDedupKeys;
  if (!Array.isArray(keys) || !keys.every((k) => typeof k === 'string' && k.trim() !== '')) {
    throw new Error(`transcriptAudit.findingDedupKeys must be a string array (empty = clean drive). Required shape: ${TRANSCRIPT_AUDIT_SHAPE}`);
  }
  if (!isIsoParseable(o.generatedAt)) {
    throw new Error(`transcriptAudit.generatedAt must be a parseable timestamp. Required shape: ${TRANSCRIPT_AUDIT_SHAPE}`);
  }
  if (typeof o.ledger !== 'string' || !TRANSCRIPT_AUDIT_LEDGERS.has(o.ledger)) {
    throw new Error(`transcriptAudit.ledger must be one of local|remote|dry-run|failed. Required shape: ${TRANSCRIPT_AUDIT_SHAPE}`);
  }
  if (o.notes !== undefined && typeof o.notes !== 'string') {
    throw new Error(`transcriptAudit.notes must be a string when present. Required shape: ${TRANSCRIPT_AUDIT_SHAPE}`);
  }
  return {
    topicIds: topicIds as number[],
    window: { start: window.start as string, end: window.end as string },
    summary: summary as Record<string, number>,
    findingDedupKeys: keys as string[],
    generatedAt: o.generatedAt as string,
    ledger: o.ledger as TranscriptAuditAttachment['ledger'],
    ...(typeof o.notes === 'string' ? { notes: o.notes } : {}),
  };
}

/** Legacy/optional rows parse to null — grandfathered, mirroring operatorSeatUx. */
function parseTranscriptAudit(json: string | null | undefined): TranscriptAuditAttachment | null {
  if (!json || json.trim() === '') return null;
  try {
    const parsed = JSON.parse(json);
    // Stored blocks were validated at write time; re-validate leniently so a
    // hand-edited row degrades to null instead of bricking reads.
    return validateTranscriptAudit(parsed, 'unknown');
  } catch {
    // @silent-fallback-ok corrupt legacy row reads as "no transcript audit recorded"
    return null;
  }
}

/** Legacy rows (pre-gate) parse to null — grandfathered, mirroring channel='unknown'. */
function parseOperatorSeatUx(json: string | null | undefined): OperatorSeatUx | null {
  if (!json || json.trim() === '') return null;
  try {
    return requireOperatorSeatUx(JSON.parse(json));
  } catch {
    // A corrupt stored block must not brick reads of historical cycles; the
    // gate guarantees new writes are valid, so this only fires on legacy/
    // hand-edited rows. Degrading to null is the honest representation.
    // @silent-fallback-ok corrupt legacy row reads as "no UX block recorded"
    return null;
  }
}

interface Row {
  id: string;
  instance_id: string;
  cycle_number: number;
  created_at: string;
  task: string;
  mentee_output: string;
  mentor_flagged_json: string;
  overseer_diff_json: string;
  coaching: string;
  infra_items_json: string;
  kind: string;
  status: string;
  channel: string;
  operator_seat_ux_json: string;
  transcript_audit_json: string;
}

export class ApprenticeshipCycleStore {
  private db: BetterSqliteDatabase;
  private unregisterSqliteHandle: (() => void) | null = null;
  private now: () => Date;
  private stmts!: {
    insert: Database.Statement;
    listAll: Database.Statement;
    listByInstance: Database.Statement;
    listAllByInstance: Database.Statement;
    get: Database.Statement;
    close: Database.Statement;
  };

  constructor(opts: ApprenticeshipCycleStoreOptions) {
    this.now = opts.now ?? (() => new Date());
    if (opts.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    }
    this.db = NativeModuleHealer.openWithHealSync(
      'ApprenticeshipCycleStore',
      () => new Database(opts.dbPath),
    );
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.unregisterSqliteHandle = registerSqliteHandle(() => {
      try { this.db.close(); } catch { /* already closed */ }
    });
    for (const ddl of SCHEMA) this.db.exec(ddl);
    // Migration: add the `channel` column to DBs created before the dogfooded-
    // channel enforcement (§4a). Idempotent — only ALTER if it's missing. Existing
    // rows default to 'unknown' (grandfathered → still count, never un-firing an
    // already-earned keystone).
    const cols = this.db.prepare(`PRAGMA table_info(apprenticeship_cycles)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'channel')) {
      this.db.exec(`ALTER TABLE apprenticeship_cycles ADD COLUMN channel TEXT NOT NULL DEFAULT 'unknown'`);
    }
    // operator-seat UX gate (2026-06-05). Same idempotent pattern as channel:
    // existing rows default to '' (grandfathered → read as null), only NEW
    // records pass through the requireOperatorSeatUx refusal in record().
    if (!cols.some((c) => c.name === 'operator_seat_ux_json')) {
      this.db.exec(`ALTER TABLE apprenticeship_cycles ADD COLUMN operator_seat_ux_json TEXT NOT NULL DEFAULT ''`);
    }
    // transcript-audit artifact gate (Observation Needs Structure follow-through).
    // Same idempotent pattern: existing rows default to '' (read as null), only
    // NEW telegram-playwright records pass through validateTranscriptAudit().
    if (!cols.some((c) => c.name === 'transcript_audit_json')) {
      this.db.exec(`ALTER TABLE apprenticeship_cycles ADD COLUMN transcript_audit_json TEXT NOT NULL DEFAULT ''`);
    }
    // Legacy rows pre-date axis vocabulary. Keep them visible, but never
    // fabricate an axis from the old catch-all label.
    this.db.prepare(`UPDATE apprenticeship_cycles SET kind = 'unknown' WHERE kind = 'differential-cycle'`).run();
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmts = {
      insert: this.db.prepare(`
        INSERT INTO apprenticeship_cycles
          (id, instance_id, cycle_number, created_at, task, mentee_output,
           mentor_flagged_json, overseer_diff_json, coaching, infra_items_json,
           kind, status, channel, operator_seat_ux_json, transcript_audit_json)
        VALUES
          (@id, @instanceId, @cycleNumber, @createdAt, @task, @menteeOutput,
           @mentorFlaggedJson, @overseerDifferentialJson, @coaching,
           @infraItemsJson, @kind, @status, @channel, @operatorSeatUxJson,
           @transcriptAuditJson)
      `),
      listAll: this.db.prepare(`
        SELECT * FROM apprenticeship_cycles
        ORDER BY created_at DESC, cycle_number DESC
        LIMIT ?
      `),
      listByInstance: this.db.prepare(`
        SELECT * FROM apprenticeship_cycles
        WHERE instance_id = ?
        ORDER BY created_at DESC, cycle_number DESC
        LIMIT ?
      `),
      listAllByInstance: this.db.prepare(`
        SELECT * FROM apprenticeship_cycles
        WHERE instance_id = ?
        ORDER BY created_at DESC, cycle_number DESC
      `),
      get: this.db.prepare(`SELECT * FROM apprenticeship_cycles WHERE id = ?`),
      close: this.db.prepare(`
        UPDATE apprenticeship_cycles
        SET status = 'closed'
        WHERE id = ?
        RETURNING *
      `),
    };
  }

  record(input: ApprenticeshipCycleRecordInput): ApprenticeshipCycleRecord {
    // Channel resolves first: the transcript-audit gate is channel-dependent
    // (required on the dogfooded telegram-playwright channel, optional elsewhere).
    const channel = normalizeChannel(input.channel);
    const record: ApprenticeshipCycleRecord = {
      id: optionalString(input.id, randomUUID()),
      instanceId: requireString(input.instanceId, 'instanceId'),
      cycleNumber: Number.isInteger(input.cycleNumber) && input.cycleNumber > 0
        ? input.cycleNumber
        : (() => { throw new Error('cycleNumber must be a positive integer'); })(),
      createdAt: optionalString(input.createdAt, this.now().toISOString()),
      task: requireString(input.task, 'task'),
      menteeOutput: requireString(input.menteeOutput, 'menteeOutput'),
      mentorFlagged: stringArray(input.mentorFlagged, 'mentorFlagged'),
      overseerDifferential: stringArray(input.overseerDifferential, 'overseerDifferential'),
      coaching: typeof input.coaching === 'string' ? input.coaching : '',
      infraItems: stringArray(input.infraItems, 'infraItems'),
      kind: normalizeKind(input.kind),
      status: optionalString(input.status, 'open'),
      channel,
      // THE UX GATE — refuses the whole record when the block is missing or
      // malformed (self-describing error names the exact required shape).
      operatorSeatUx: requireOperatorSeatUx(input.operatorSeatUx),
      // THE AUDIT GATE — telegram-playwright cycles refuse to exist without
      // the objective post-drive transcript-audit artifact (#864 follow-through).
      transcriptAudit: validateTranscriptAudit(input.transcriptAudit, channel),
    };

    const { operatorSeatUx, transcriptAudit, ...flatRecord } = record;
    this.stmts.insert.run({
      ...flatRecord,
      mentorFlaggedJson: JSON.stringify(record.mentorFlagged),
      overseerDifferentialJson: JSON.stringify(record.overseerDifferential),
      infraItemsJson: JSON.stringify(record.infraItems),
      operatorSeatUxJson: JSON.stringify(operatorSeatUx),
      transcriptAuditJson: transcriptAudit === null ? '' : JSON.stringify(transcriptAudit),
    });
    return record;
  }

  list(opts: { instanceId?: string; limit?: number | string } = {}): ApprenticeshipCycleRecord[] {
    const limit = clampLimit(opts.limit);
    const rows = opts.instanceId
      ? this.stmts.listByInstance.all(opts.instanceId, limit)
      : this.stmts.listAll.all(limit);
    return (rows as Row[]).map((row) => this.rowToRecord(row));
  }

  get(id: string): ApprenticeshipCycleRecord | null {
    const row = this.stmts.get.get(id) as Row | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  roleCoverage(
    instanceId: string,
    opts: RoleCoverageOptions = {},
    additionalRecords: readonly ApprenticeshipCycleRecord[] = [],
  ): ApprenticeshipRoleCoverage {
    const id = requireString(instanceId, 'instanceId');
    const localRecords = (this.stmts.listAllByInstance.all(id) as Row[]).map((row) => this.rowToRecord(row));
    // A cycle may have been mirrored or recorded by more than one participating
    // agent. Its UUID is the transport-stable identity, so the local copy wins
    // and peer copies are folded exactly once.
    const recordsById = new Map(localRecords.map((record) => [record.id, record]));
    const coverageConflictingCycleIds = new Set<string>();
    const coverageFingerprint = (record: ApprenticeshipCycleRecord): string =>
      JSON.stringify([record.instanceId, record.createdAt, record.kind, record.channel]);
    for (const record of additionalRecords) {
      if (record.instanceId !== id) continue;
      const existing = recordsById.get(record.id);
      if (!existing) {
        recordsById.set(record.id, record);
      } else if (coverageFingerprint(existing) !== coverageFingerprint(record)) {
        coverageConflictingCycleIds.add(record.id);
      }
    }
    const blank = (): ApprenticeshipRoleAxisCoverage => ({ fired: false, cycleCount: 0, lastAt: null });
    const axes = Object.fromEntries(
      APPRENTICESHIP_CYCLE_AXES.map((axis) => [axis, blank()]),
    ) as Record<ApprenticeshipCycleAxis, ApprenticeshipRoleAxisCoverage>;
    const unknown = blank();
    let shortcutDifferentialCount = 0;
    // Oversight rows are gathered with their timestamps so we can count how
    // many landed AFTER the last keystone drive (the starvation signal).
    const oversightTimestamps: string[] = [];

    for (const record of recordsById.values()) {
      const kind = normalizeStoredKind(record.kind);
      const channel = normalizeChannel(record.channel);
      // §4a ENFORCEMENT: a mentor-mentee-differential cycle that ran through a
      // `direct-shortcut` (bypassing the dogfooded Telegram-Playwright UX-under-test)
      // is recorded for honesty but does NOT count toward the keystone axis — a
      // shortcut can never make the program look healthy. Dogfooded, backup, and
      // grandfathered ('unknown') channels all count as before.
      if (kind === 'mentor-mentee-differential' && channel === 'direct-shortcut') {
        shortcutDifferentialCount += 1;
        continue;
      }
      const target = kind === 'unknown' ? unknown : axes[kind];
      target.fired = true;
      target.cycleCount += 1;
      if (!target.lastAt || record.createdAt > target.lastAt) target.lastAt = record.createdAt;
      if ((APPRENTICESHIP_OVERSIGHT_AXES as string[]).includes(kind)) {
        oversightTimestamps.push(record.createdAt);
      }
    }

    const dormantAxes = APPRENTICESHIP_CYCLE_AXES.filter((axis) => !axes[axis].fired);
    const driftWarning =
      !axes['mentor-mentee-differential'].fired &&
      axes['overseer-apprentice-devreview'].cycleCount >= 2;

    const keystoneBalance = this.computeKeystoneBalance(
      axes,
      oversightTimestamps,
      opts.oversightStarvationThreshold,
      opts.keystoneDormancyMs,
    );

    return {
      instanceId: id, axes, unknown, dormantAxes, driftWarning, shortcutDifferentialCount,
      keystoneBalance, coverageConflictingCycleIds: [...coverageConflictingCycleIds].sort(),
    };
  }

  /**
   * Observe-only keystone (deepest-layer) health. NEVER gates — it only makes
   * the mentor/mentee balance a queryable fact (the 2026-06-06 imbalance fix:
   * "Observation Needs Structure" applied to layer balance). Starved when the
   * program is active but its keystone drive is under-firing: keystone never
   * ran while oversight did, OR enough oversight has accrued since the last
   * keystone cycle that the layer has clearly drifted.
   */
  private computeKeystoneBalance(
    axes: Record<ApprenticeshipCycleAxis, ApprenticeshipRoleAxisCoverage>,
    oversightTimestamps: string[],
    thresholdOpt?: number,
    dormancyMsOpt?: number,
  ): ApprenticeshipKeystoneBalance {
    const threshold =
      typeof thresholdOpt === 'number' && Number.isInteger(thresholdOpt) && thresholdOpt > 0
        ? thresholdOpt
        : DEFAULT_KEYSTONE_STARVATION_OVERSIGHT;
    const dormancyThresholdMs =
      typeof dormancyMsOpt === 'number' && Number.isFinite(dormancyMsOpt) && dormancyMsOpt > 0
        ? dormancyMsOpt
        : DEFAULT_KEYSTONE_DORMANCY_MS;
    const keystone = axes[APPRENTICESHIP_KEYSTONE_AXIS];
    const lastKeystoneAt = keystone.lastAt;
    const oversightCycleCount = oversightTimestamps.length;
    // Oversight strictly after the last keystone drive (string ISO compare is
    // safe — createdAt is always a normalized ISO timestamp). When the keystone
    // never ran, ALL oversight counts as "since" (there was never a drive).
    const oversightSinceKeystone = lastKeystoneAt
      ? oversightTimestamps.filter((ts) => ts > lastKeystoneAt).length
      : oversightCycleCount;

    // Wall-clock staleness of the last keystone drive — the dimension the bare
    // oversight-since count is blind to (a layer that simply goes silent reads
    // "healthy" because no oversight piled up). A parse failure degrades to null
    // (no false dormancy) rather than throwing.
    const parsedLastMs = lastKeystoneAt ? Date.parse(lastKeystoneAt) : NaN;
    const lastKeystoneAgeMs = Number.isFinite(parsedLastMs)
      ? Math.max(0, this.now().getTime() - parsedLastMs)
      : null;
    const dormant =
      keystone.fired && lastKeystoneAgeMs !== null && lastKeystoneAgeMs >= dormancyThresholdMs;
    const fmtAge = (ms: number): string => {
      const h = ms / 3_600_000;
      return h >= 48 ? `${(h / 24).toFixed(1)}d` : `${h.toFixed(1)}h`;
    };
    const dormancyNote =
      dormant && lastKeystoneAgeMs !== null
        ? `last keystone drive was ${fmtAge(lastKeystoneAgeMs)} ago (>= ${fmtAge(dormancyThresholdMs)})`
        : '';

    let starved = false;
    let reason: string;
    if (!keystone.fired && oversightCycleCount > 0) {
      starved = true;
      reason = `keystone (${APPRENTICESHIP_KEYSTONE_AXIS}) has NEVER fired while ${oversightCycleCount} oversight cycle(s) ran — the deepest layer was never exercised.`;
    } else if (keystone.fired && oversightSinceKeystone >= threshold) {
      starved = true;
      reason = `${oversightSinceKeystone} oversight cycle(s) since the last keystone drive (>= ${threshold}) — the program has drifted to reviewing/overseeing without driving the mentee.`;
      if (dormant) reason += ` It is also DORMANT — ${dormancyNote}.`;
    } else if (!keystone.fired) {
      reason = `keystone has not fired yet, but no oversight activity to drift against — program just hasn't started its deepest layer.`;
    } else if (dormant) {
      reason = `keystone DORMANT — ${dormancyNote}; the deepest layer has gone quiet. Not "starved" (no oversight has piled up since), but silent — re-drive the mentee.`;
    } else {
      reason = `keystone healthy: last drive ${lastKeystoneAgeMs !== null ? `${fmtAge(lastKeystoneAgeMs)} ago` : 'recorded'}, ${oversightSinceKeystone} oversight cycle(s) since (< ${threshold}).`;
    }

    return {
      keystoneAxis: APPRENTICESHIP_KEYSTONE_AXIS,
      keystoneCycleCount: keystone.cycleCount,
      lastKeystoneAt,
      oversightCycleCount,
      oversightSinceKeystone,
      starved,
      starvationThreshold: threshold,
      lastKeystoneAgeMs,
      dormant,
      dormancyThresholdMs,
      reason,
    };
  }

  closeCycle(id: string): ApprenticeshipCycleRecord | null {
    const row = this.stmts.close.get(id) as Row | undefined;
    return row ? this.rowToRecord(row) : null;
  }

  close(): void {
    try {
      this.unregisterSqliteHandle?.();
      this.unregisterSqliteHandle = null;
      this.db.close();
    } catch {
      /* ignore */
    }
  }

  private rowToRecord(row: Row): ApprenticeshipCycleRecord {
    return {
      id: row.id,
      instanceId: row.instance_id,
      cycleNumber: row.cycle_number,
      createdAt: row.created_at,
      task: row.task,
      menteeOutput: row.mentee_output,
      mentorFlagged: parseJsonArray(row.mentor_flagged_json),
      overseerDifferential: parseJsonArray(row.overseer_diff_json),
      coaching: row.coaching,
      infraItems: parseJsonArray(row.infra_items_json),
      kind: normalizeStoredKind(row.kind),
      status: row.status,
      channel: normalizeChannel(row.channel),
      operatorSeatUx: parseOperatorSeatUx(row.operator_seat_ux_json),
      transcriptAudit: parseTranscriptAudit(row.transcript_audit_json),
    };
  }
}
