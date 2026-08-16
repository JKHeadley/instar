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
     operator_seat_ux_json TEXT NOT NULL DEFAULT ''
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
           kind, status, channel, operator_seat_ux_json)
        VALUES
          (@id, @instanceId, @cycleNumber, @createdAt, @task, @menteeOutput,
           @mentorFlaggedJson, @overseerDifferentialJson, @coaching,
           @infraItemsJson, @kind, @status, @channel, @operatorSeatUxJson)
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
      channel: normalizeChannel(input.channel),
      // THE UX GATE — refuses the whole record when the block is missing or
      // malformed (self-describing error names the exact required shape).
      operatorSeatUx: requireOperatorSeatUx(input.operatorSeatUx),
    };

    const { operatorSeatUx, ...flatRecord } = record;
    this.stmts.insert.run({
      ...flatRecord,
      mentorFlaggedJson: JSON.stringify(record.mentorFlagged),
      overseerDifferentialJson: JSON.stringify(record.overseerDifferential),
      infraItemsJson: JSON.stringify(record.infraItems),
      operatorSeatUxJson: JSON.stringify(operatorSeatUx),
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

  roleCoverage(instanceId: string): ApprenticeshipRoleCoverage {
    const id = requireString(instanceId, 'instanceId');
    const rows = this.stmts.listAllByInstance.all(id) as Row[];
    const blank = (): ApprenticeshipRoleAxisCoverage => ({ fired: false, cycleCount: 0, lastAt: null });
    const axes = Object.fromEntries(
      APPRENTICESHIP_CYCLE_AXES.map((axis) => [axis, blank()]),
    ) as Record<ApprenticeshipCycleAxis, ApprenticeshipRoleAxisCoverage>;
    const unknown = blank();
    let shortcutDifferentialCount = 0;

    for (const row of rows) {
      const kind = normalizeKind(row.kind);
      const channel = normalizeChannel(row.channel);
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
      if (!target.lastAt || row.created_at > target.lastAt) target.lastAt = row.created_at;
    }

    const dormantAxes = APPRENTICESHIP_CYCLE_AXES.filter((axis) => !axes[axis].fired);
    const driftWarning =
      !axes['mentor-mentee-differential'].fired &&
      axes['overseer-apprentice-devreview'].cycleCount >= 2;

    return { instanceId: id, axes, unknown, dormantAxes, driftWarning, shortcutDifferentialCount };
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
      kind: normalizeKind(row.kind),
      status: row.status,
      channel: normalizeChannel(row.channel),
      operatorSeatUx: parseOperatorSeatUx(row.operator_seat_ux_json),
    };
  }
}
