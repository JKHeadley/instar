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
}

export const APPRENTICESHIP_CYCLE_AXES = [
  'mentor-mentee-differential',
  'overseer-apprentice-devreview',
  'overseer-mentee-direct',
] as const;

export type ApprenticeshipCycleAxis = typeof APPRENTICESHIP_CYCLE_AXES[number];
export type ApprenticeshipCycleKind = ApprenticeshipCycleAxis | 'unknown';

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
     status                TEXT NOT NULL
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
           kind, status)
        VALUES
          (@id, @instanceId, @cycleNumber, @createdAt, @task, @menteeOutput,
           @mentorFlaggedJson, @overseerDifferentialJson, @coaching,
           @infraItemsJson, @kind, @status)
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
    };

    this.stmts.insert.run({
      ...record,
      mentorFlaggedJson: JSON.stringify(record.mentorFlagged),
      overseerDifferentialJson: JSON.stringify(record.overseerDifferential),
      infraItemsJson: JSON.stringify(record.infraItems),
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

    for (const row of rows) {
      const kind = normalizeKind(row.kind);
      const target = kind === 'unknown' ? unknown : axes[kind];
      target.fired = true;
      target.cycleCount += 1;
      if (!target.lastAt || row.created_at > target.lastAt) target.lastAt = row.created_at;
    }

    const dormantAxes = APPRENTICESHIP_CYCLE_AXES.filter((axis) => !axes[axis].fired);
    const driftWarning =
      !axes['mentor-mentee-differential'].fired &&
      axes['overseer-apprentice-devreview'].cycleCount >= 2;

    return { instanceId: id, axes, unknown, dormantAxes, driftWarning };
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
    };
  }
}
