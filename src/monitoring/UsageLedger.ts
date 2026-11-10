/**
 * UsageLedger — the unified, per-call token usage record (docs/specs/unified-usage-ledger.md).
 *
 * One SQLite file (`server-data/usage-ledger.db`) holds everything that must change
 * together: raw request rows, session bindings (which double as this agent's spawn
 * records), per-file source checkpoints, and the hour / day / session-day rollups.
 * Every event insert, checkpoint advance and rollup delta commits in ONE transaction,
 * so a crash can never leave them out of step (spec: Stores).
 *
 * This file implements the store, the record, membership, attribution, replay safety
 * and the rollups for the Claude transcript source (Slice 1). It is pure data
 * transformation: no LLM, no outward action, no decision about which calls run.
 *
 * Token arithmetic (spec: Token arithmetic): the five token columns are DISJOINT.
 * tok_input is fresh input only; cache read and cache write are separate; tok_output
 * includes reasoning; tok_reasoning is a subset of tok_output (display only).
 * Null means "not reported", which is distinct from 0.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export type UsageSource =
  | 'claude-transcript' | 'codex-rollout' | 'intelligence-call'
  | 'pi-session' | 'grok-session' | 'gemini-session';
export type UsageFramework = 'claude-code' | 'codex-cli' | 'pi-cli' | 'grok-build' | 'gemini-cli' | 'api';
export type SessionKind = 'interactive' | 'job' | 'internal' | 'subagent';
export type ScopeBasis = 'spawn-record' | 'cwd';
/** counted: contributes to totals. held: dedupe pair, other side counted. copied-history: predates its file, unresolved. replay: re-read before a checkpoint, detail only. */
/** paired: an invocation whose tokens moved to its settled file rows (its call and dollars still count). */
export type RowStatus = 'counted' | 'held' | 'copied-history' | 'replay' | 'paired';

export interface TokenParts {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
  reasoning: number | null;
}

export interface SessionBinding {
  sessionId: string;
  framework: UsageFramework;
  sessionKind: SessionKind;
  cwd: string | null;
  topicId: string | null;
  jobSlug: string | null;
  runId: string | null;
  accountId: string | null;
  machineId: string;
  validFrom: number;
  validTo: number | null;
}

export interface UsageLedgerOptions {
  dbPath: string;
  machineId: string;
  /** Stable id of this agent (refuses another agent's snapshot). */
  agentId: string;
  /** The agent's home and project dirs: the cwd membership rule's registered paths. */
  agentHomes: string[];
  /** Other registered agents' homes on this machine (a nested home is not ours). */
  otherAgentHomes?: string[];
  /** Max directory depth under `<root>/projects` (spec default 3). */
  maxDepth?: number;
  /** Shared per-tick file budget across all roots (spec default 500). */
  filesPerTick?: number;
  /** Files whose mtime is older than this are outside the backfill window (default 30 days). */
  maxFileAgeMs?: number;
  /** Raw-row ceiling per machine (spec default 4,000,000). */
  maxRawRows?: number;
  /** Raw retention (default 90 days). */
  rawRetentionMs?: number;
  /** Hour and session-day rollup retention (default 400 days). */
  rollupRetentionMs?: number;
  /** Bounded invocation queue (spec default 10,000; oldest dropped when full). */
  invocationQueueMax?: number;
  /** Dedupe pair settle window (spec default 2 minutes). */
  settleWindowMs?: number;
  now?: () => number;
  databaseFactory?: (p: string) => BetterSqliteDatabase;
}

export interface ScanReport {
  filesRead: number;
  rowsInserted: number;
  rowsCounted: number;
  pending: number;
}

export interface CoverageRoot {
  root: string;
  origin: string;
  filesScanned: number;
  filesSkippedDirs: number;
  filesOutOfWindow: number;
  filesTooDeep: number;
  filesPending: number;
}

export interface UsageTotals {
  calls: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  missing: { input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number };
  reportedActualUsd: number;
  reportedPlanRateUsd: number;
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const NONE = '';
const HEAD_BYTES = 256;
const MAX_STR = 256;

const TOKEN_COLS = ['tok_input', 'tok_cache_read', 'tok_cache_write', 'tok_output', 'tok_reasoning'] as const;
const MISSING_COLS = ['miss_input', 'miss_cache_read', 'miss_cache_write', 'miss_output', 'miss_reasoning'] as const;
const SUM_COLS = [...TOKEN_COLS, ...MISSING_COLS, 'reported_actual_usd', 'reported_plan_rate_usd', 'calls'] as const;
const SUM_DDL = SUM_COLS.map(c => `${c} ${c.endsWith('usd') ? 'REAL' : 'INTEGER'} NOT NULL DEFAULT 0`).join(',\n  ');

const HOUR_KEY = ['bucket', 'machine', 'framework', 'model', 'session_kind', 'topic', 'job', 'run', 'feature'] as const;
const DAY_KEY = ['bucket', 'machine', 'framework', 'model', 'session_kind', 'topic', 'job', 'feature'] as const;
const SESSION_DAY_KEY = ['bucket', 'machine', 'session_id', 'framework', 'model', 'topic', 'job', 'feature'] as const;

function keyDdl(cols: readonly string[]): string {
  return cols.map(c => `${c} ${c === 'bucket' ? 'INTEGER' : 'TEXT'} NOT NULL`).join(',\n  ');
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS usage_events (
    observation_id TEXT PRIMARY KEY,
    correlation_key TEXT,
    grain TEXT NOT NULL,
    ts INTEGER NOT NULL,
    source TEXT NOT NULL,
    framework TEXT NOT NULL,
    model TEXT,
    machine_id TEXT NOT NULL,
    account_id TEXT,
    session_id TEXT,
    session_kind TEXT NOT NULL,
    parent_session_id TEXT,
    scope_basis TEXT,
    topic_id TEXT,
    job_slug TEXT,
    run_id TEXT,
    feature TEXT,
    tok_input INTEGER, tok_cache_read INTEGER, tok_cache_write INTEGER, tok_output INTEGER, tok_reasoning INTEGER,
    status TEXT NOT NULL,
    reported_usd REAL,
    reported_basis TEXT,
    source_path TEXT,
    source_pos INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_session ON usage_events(session_id, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_events_corr ON usage_events(correlation_key)`,
  `CREATE TABLE IF NOT EXISTS session_bindings (
    session_id TEXT NOT NULL,
    framework TEXT NOT NULL,
    session_kind TEXT NOT NULL,
    cwd TEXT,
    topic_id TEXT,
    job_slug TEXT,
    run_id TEXT,
    account_id TEXT,
    machine_id TEXT NOT NULL,
    valid_from INTEGER NOT NULL,
    valid_to INTEGER,
    change_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (session_id, valid_from)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bindings_seq ON session_bindings(change_seq)`,
  `CREATE TABLE IF NOT EXISTS checkpoints (
    path TEXT PRIMARY KEY,
    root TEXT NOT NULL,
    inode INTEGER NOT NULL,
    head_hash TEXT NOT NULL,
    birth_ms INTEGER NOT NULL,
    offset INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rollup_hour (\n  ${keyDdl(HOUR_KEY)},\n  ${SUM_DDL},\n  change_seq INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (${HOUR_KEY.join(', ')}))`,
  `CREATE TABLE IF NOT EXISTS rollup_day (\n  ${keyDdl(DAY_KEY)},\n  ${SUM_DDL},\n  change_seq INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (${DAY_KEY.join(', ')}))`,
  `CREATE TABLE IF NOT EXISTS rollup_session_day (\n  ${keyDdl(SESSION_DAY_KEY)},\n  ${SUM_DDL},\n  change_seq INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (${SESSION_DAY_KEY.join(', ')}))`,
  `CREATE INDEX IF NOT EXISTS idx_rollup_hour_seq ON rollup_hour(change_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_rollup_day_seq ON rollup_day(change_seq)`,
  `CREATE INDEX IF NOT EXISTS idx_rollup_session_day_seq ON rollup_session_day(change_seq)`,
  `CREATE TABLE IF NOT EXISTS pairs (
    correlation_key TEXT PRIMARY KEY,
    inv_observation_id TEXT NOT NULL,
    inv_row TEXT NOT NULL,
    inv_start INTEGER NOT NULL,
    inv_end INTEGER NOT NULL,
    held TEXT NOT NULL DEFAULT '[]',
    file_path TEXT,
    last_file_at INTEGER,
    counted_side TEXT NOT NULL DEFAULT 'invocation',
    state TEXT NOT NULL DEFAULT 'open',
    disputed INTEGER NOT NULL DEFAULT 0,
    invocations INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pairs_state ON pairs(state)`,
  // Slice 4: peers' replicated rows (the lease holder's pooled copy) and per-peer cursors.
  `CREATE TABLE IF NOT EXISTS pool_rollup_hour (\n  ${keyDdl(HOUR_KEY)},\n  ${SUM_DDL},\n  change_seq INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (${HOUR_KEY.join(', ')}))`,
  `CREATE TABLE IF NOT EXISTS pool_rollup_day (\n  ${keyDdl(DAY_KEY)},\n  ${SUM_DDL},\n  change_seq INTEGER NOT NULL DEFAULT 0,\n  frozen INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (${DAY_KEY.join(', ')}))`,
  `CREATE TABLE IF NOT EXISTS pool_rollup_session_day (\n  ${keyDdl(SESSION_DAY_KEY)},\n  ${SUM_DDL},\n  change_seq INTEGER NOT NULL DEFAULT 0,\n  PRIMARY KEY (${SESSION_DAY_KEY.join(', ')}))`,
  `CREATE INDEX IF NOT EXISTS idx_pool_hour_bm ON pool_rollup_hour(bucket, machine)`,
  `CREATE INDEX IF NOT EXISTS idx_pool_day_bm ON pool_rollup_day(bucket, machine)`,
  `CREATE INDEX IF NOT EXISTS idx_pool_sd ON pool_rollup_session_day(bucket, session_id)`,
  `CREATE TABLE IF NOT EXISTS pool_bindings (
    session_id TEXT NOT NULL, framework TEXT NOT NULL, session_kind TEXT NOT NULL, cwd TEXT, topic_id TEXT, job_slug TEXT,
    run_id TEXT, account_id TEXT, machine_id TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER,
    PRIMARY KEY (session_id, valid_from)
  )`,
  `CREATE TABLE IF NOT EXISTS pool_peers (
    machine_id TEXT PRIMARY KEY, generation_id TEXT, last_seq INTEGER NOT NULL DEFAULT 0, last_pull_at INTEGER,
    warming INTEGER NOT NULL DEFAULT 1, invalid_rows INTEGER NOT NULL DEFAULT 0, generation_changes INTEGER NOT NULL DEFAULT 0
  )`,
];

/** Claude encodes a project dir name by replacing every non-alphanumeric character with '-'. */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

function clip(v: unknown): string | null {
  if (typeof v !== 'string' || v.length === 0) return null;
  return v.length > MAX_STR ? v.slice(0, MAX_STR) : v;
}

function isUnder(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function nonNegInt(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/** Map a Claude transcript `message.usage` block to the disjoint token parts. */
export function claudeUsageToParts(usage: Record<string, unknown>): TokenParts {
  return {
    input: nonNegInt(usage.input_tokens),
    cacheRead: nonNegInt(usage.cache_read_input_tokens),
    cacheWrite: nonNegInt(usage.cache_creation_input_tokens),
    output: nonNegInt(usage.output_tokens),
    reasoning: null,
  };
}

interface RowForRollup {
  ts: number;
  machine: string;
  framework: string;
  model: string | null;
  sessionKind: string;
  topic: string | null;
  job: string | null;
  run: string | null;
  feature: string | null;
  sessionId: string | null;
  parts: TokenParts;
  reportedUsd: number | null;
  reportedBasis: string | null;
  /** 0 for rows whose call is already counted by their invocation (dedupe pairs); default 1. */
  callsWeight?: 0 | 1;
  /** Tokens only: no call count, no dollars (a settlement move between sides). */
  tokensOnly?: boolean;
}

interface PendingDelta { key: Record<string, string | number>; sums: number[] }

/** Pre-aggregates rollup deltas for one batch: one upsert per key (spec: Slice 4). */
class DeltaBatch {
  readonly hour = new Map<string, PendingDelta>();
  readonly day = new Map<string, PendingDelta>();
  readonly sessionDay = new Map<string, PendingDelta>();

  add(r: RowForRollup, sign: 1 | -1): void {
    const sums = [
      r.parts.input ?? 0, r.parts.cacheRead ?? 0, r.parts.cacheWrite ?? 0, r.parts.output ?? 0, r.parts.reasoning ?? 0,
      r.parts.input == null ? 1 : 0, r.parts.cacheRead == null ? 1 : 0, r.parts.cacheWrite == null ? 1 : 0,
      r.parts.output == null ? 1 : 0, r.parts.reasoning == null ? 1 : 0,
      !r.tokensOnly && r.reportedBasis === 'actual' ? r.reportedUsd ?? 0 : 0,
      !r.tokensOnly && r.reportedBasis === 'plan-rate' ? r.reportedUsd ?? 0 : 0,
      r.tokensOnly ? 0 : (r.callsWeight ?? 1),
    ].map(v => v * sign);
    if (r.tokensOnly) for (let i = 5; i < 10; i++) sums[i] = 0;
    const base = {
      machine: r.machine, framework: r.framework, model: r.model ?? NONE, session_kind: r.sessionKind,
      topic: r.topic ?? NONE, job: r.job ?? NONE, feature: r.feature ?? NONE,
    };
    const hourKey = { bucket: Math.floor(r.ts / HOUR_MS) * HOUR_MS, ...base, run: r.run ?? NONE };
    const dayKey = { bucket: Math.floor(r.ts / DAY_MS) * DAY_MS, ...base };
    DeltaBatch.merge(this.hour, hourKey, HOUR_KEY, sums);
    DeltaBatch.merge(this.day, dayKey, DAY_KEY, sums);
    // Internal one-shots stay out of session-day rollups (each is its own session).
    if (r.sessionKind !== 'internal' && r.sessionId) {
      const sdKey = {
        bucket: dayKey.bucket, machine: r.machine, session_id: r.sessionId, framework: r.framework,
        model: base.model, topic: base.topic, job: base.job, feature: base.feature,
      };
      DeltaBatch.merge(this.sessionDay, sdKey, SESSION_DAY_KEY, sums);
    }
  }

  private static merge(map: Map<string, PendingDelta>, key: Record<string, string | number>, cols: readonly string[], sums: number[]): void {
    const k = cols.map(c => String(key[c])).join('\u0000');
    const cur = map.get(k);
    if (cur) cur.sums.forEach((_, i) => { cur.sums[i] += sums[i]; });
    else map.set(k, { key, sums: [...sums] });
  }

  get empty(): boolean { return this.hour.size === 0; }
}

export interface InvocationInput {
  feature: string;
  framework: string | null;
  model: string | null;
  startedAt: number;
  endedAt: number;
  outcome: 'ok' | 'error';
  usage: {
    sessionId?: string | null; input?: number | null; cacheRead?: number | null; cacheWrite?: number | null;
    output?: number | null; reasoning?: number | null; reportedUsd?: number | null; reportedBasis?: 'actual' | 'plan-rate' | null;
  } | null;
  jobSlug: string | null;
  runId: string | null;
}

interface QueuedInvocation extends InvocationInput { callId: string }

interface PairRow {
  correlation_key: string;
  inv_observation_id: string;
  inv_row: string;
  inv_start: number;
  inv_end: number;
  held: string;
  file_path: string | null;
  last_file_at: number | null;
  counted_side: 'invocation' | 'file';
  state: 'open' | 'settled' | 'disagreement' | 'ambiguous';
  disputed: number;
}

interface CodexTotals { input: number; cached: number; output: number; reasoning: number }
interface CodexCheckpointState {
  sessionId: string | null;
  cwd: string | null;
  model: string | null;
  last: CodexTotals | null;
  baseline: CodexTotals | null;
  resumed: boolean;
}

function codexTotals(u: Record<string, unknown>): CodexTotals {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
  return { input: n(u.input_tokens), cached: n(u.cached_input_tokens), output: n(u.output_tokens), reasoning: n(u.reasoning_output_tokens) };
}

function tokenTotal(p: TokenParts): number {
  return (p.input ?? 0) + (p.cacheRead ?? 0) + (p.cacheWrite ?? 0) + (p.output ?? 0);
}

/** Map a provider's framework id to the ledger's framework vocabulary. */
export function normalizeFramework(f: string | null | undefined): UsageFramework {
  const v = (f ?? '').toLowerCase();
  if (v.includes('claude') || v.includes('anthropic')) return 'claude-code';
  if (v.includes('codex') || v.includes('openai')) return 'codex-cli';
  if (v.includes('gemini')) return 'gemini-cli';
  if (v.includes('grok')) return 'grok-build';
  if (v === 'pi' || v.startsWith('pi-') || v.includes('pi-cli')) return 'pi-cli';
  return 'api';
}

const PAGE_ROWS = 5_000;
const PAGE_BYTES = 5 * 1024 * 1024;
const EXPORT_TABLES = ['rollup_hour', 'rollup_day', 'rollup_session_day', 'session_bindings'] as const;
const POOL_TABLE: Record<string, string> = {
  rollup_hour: 'pool_rollup_hour', rollup_day: 'pool_rollup_day', rollup_session_day: 'pool_rollup_session_day', session_bindings: 'pool_bindings',
};

export interface ExportRow { table: string; row: Record<string, unknown> }
export interface ExportPage {
  machineId: string;
  generationId: string;
  /** When this database was imported from a snapshot (0 = never): the holder drops pooled rows from here on a generation change. */
  snapshotAt: number;
  rows: ExportRow[];
  lastSeq: number;
  more: boolean;
}
interface PeerCursor {
  machine_id: string; generation_id: string | null; last_seq: number; last_pull_at: number | null;
  warming: number; invalid_rows: number; generation_changes: number;
}
export type AggregateDim = 'machine' | 'framework' | 'model' | 'session_kind' | 'topic' | 'job' | 'run' | 'feature' | 'session_id';
export interface AggregateRow {
  bucket: number;
  model: string | null;
  dims: Record<string, string | null>;
  calls: number;
  input: number; cacheRead: number; cacheWrite: number; output: number; reasoning: number;
  /** Calls that did not report input or output (a total over them is partial). */
  missingAny: number;
  reportedActualUsd: number;
  reportedPlanRateUsd: number;
}
export interface SnapshotRules {
  /** Is this id a predecessor of THIS machine in the identity-change ledger? */
  isPredecessor?: (machineId: string) => boolean;
  /** Is this id a live pool member right now (mesh state at open)? */
  isLivePoolMember?: (machineId: string) => boolean;
  /** Does a pool holder already hold pooled rows for this id? */
  poolHasRowsFor?: (machineId: string) => boolean;
}
export type SnapshotImport = {
  outcome: 'none' | 'ignored-live-authoritative' | 'unreadable' | 'refused-other-agent' | 'refused-live-member' | 'imported' | 'imported-frozen';
  fromMachine?: string;
  snapshotAt?: number;
  detail?: string;
};

export class UsageLedger {
  private readonly db: BetterSqliteDatabase;
  private readonly opts: Required<Omit<UsageLedgerOptions, 'databaseFactory' | 'otherAgentHomes'>> & { otherAgentHomes: string[] };
  private readonly roots: { root: string; origin: string }[] = [];
  private rootCursor = 0;
  private readonly coverage = new Map<string, CoverageRoot>();
  private readonly upsertStmts: Record<'hour' | 'day' | 'sessionDay', Database.Statement>;
  private closed = false;

  constructor(opts: UsageLedgerOptions) {
    this.opts = {
      maxDepth: 3,
      filesPerTick: 500,
      maxFileAgeMs: 30 * DAY_MS,
      maxRawRows: 4_000_000,
      rawRetentionMs: 90 * DAY_MS,
      rollupRetentionMs: 400 * DAY_MS,
      invocationQueueMax: 10_000,
      settleWindowMs: 2 * 60_000,
      now: () => Date.now(),
      ...opts,
      otherAgentHomes: opts.otherAgentHomes ?? [],
    } as UsageLedger['opts'];
    if (opts.dbPath !== ':memory:') fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = NativeModuleHealer.openWithHealSync(
      'UsageLedger',
      () => opts.databaseFactory?.(opts.dbPath) ?? new Database(opts.dbPath),
    );
    // auto_vacuum must be set before the first table exists to take effect.
    try { this.db.pragma('auto_vacuum = INCREMENTAL'); } catch { /* @silent-fallback-ok: pragma failure must not break ledger init; retention just reclaims no disk. */ }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    registerSqliteHandle(() => { try { this.db.close(); } catch { /* @silent-fallback-ok: filesystem race: the file is re-examined on the next tick */ /* already closed */ } });
    for (const ddl of SCHEMA) this.db.exec(ddl);
    const cpCols = (this.db.prepare('PRAGMA table_info(checkpoints)').all() as { name: string }[]).map(c => c.name);
    if (!cpCols.includes('extra')) this.db.exec('ALTER TABLE checkpoints ADD COLUMN extra TEXT');
    this.initMeta();
    this.upsertStmts = {
      hour: this.prepareUpsert('rollup_hour', HOUR_KEY),
      day: this.prepareUpsert('rollup_day', DAY_KEY),
      sessionDay: this.prepareUpsert('rollup_session_day', SESSION_DAY_KEY),
    };
  }

  // ── meta ────────────────────────────────────────────────────────────

  private initMeta(): void {
    const get = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    const set = this.db.prepare('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)');
    set.run('generation_id', crypto.randomUUID());
    set.run('machine_id', this.opts.machineId);
    set.run('agent_id', this.opts.agentId);
    set.run('change_seq', '0');
    set.run('raw_rows', String((this.db.prepare('SELECT COUNT(*) AS n FROM usage_events').get() as { n: number }).n));
    void get;
  }

  private metaGet(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  private metaSet(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  private nextSeq(): number {
    const n = Number(this.metaGet('change_seq') ?? '0') + 1;
    this.metaSet('change_seq', String(n));
    return n;
  }

  get generationId(): string { return this.metaGet('generation_id') ?? ''; }
  get rawRowCount(): number { return Number(this.metaGet('raw_rows') ?? '0'); }

  // ── roots ───────────────────────────────────────────────────────────

  /** Register a framework root (a Claude config dir). Idempotent. `origin` says where it came from. */
  addClaudeRoot(configDir: string, origin: string): void {
    const root = path.resolve(configDir);
    if (this.roots.some(r => r.root === root)) return;
    this.roots.push({ root, origin });
    this.coverage.set(root, { root, origin, filesScanned: 0, filesSkippedDirs: 0, filesOutOfWindow: 0, filesTooDeep: 0, filesPending: 0 });
  }

  listRoots(): CoverageRoot[] { return [...this.coverage.values()].map(c => ({ ...c })); }

  // ── bindings (spawn records) ────────────────────────────────────────

  /**
   * Open a binding for a session id: a spawn record plus its attribution. Closes the
   * previous open binding for the same session id at `validFrom` (a rebind).
   */
  recordBinding(b: Omit<SessionBinding, 'validTo' | 'machineId'> & { machineId?: string }): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE session_bindings SET valid_to = ?, change_seq = ? WHERE session_id = ? AND valid_to IS NULL AND valid_from < ?')
        .run(b.validFrom, this.nextSeq(), b.sessionId, b.validFrom);
      this.db.prepare(`INSERT OR REPLACE INTO session_bindings
        (session_id, framework, session_kind, cwd, topic_id, job_slug, run_id, account_id, machine_id, valid_from, valid_to, change_seq)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
        .run(b.sessionId, b.framework, b.sessionKind, clip(b.cwd), clip(b.topicId), clip(b.jobSlug), clip(b.runId),
          clip(b.accountId), b.machineId ?? this.opts.machineId, b.validFrom, this.nextSeq());
    });
    tx();
  }

  /** Close every open binding for a session (session ended). */
  closeBinding(sessionId: string, at: number): void {
    this.db.prepare('UPDATE session_bindings SET valid_to = ?, change_seq = ? WHERE session_id = ? AND valid_to IS NULL')
      .run(at, this.nextSeq(), sessionId);
  }

  private bindingAt(sessionId: string, ts: number): SessionBinding | null {
    const row = this.db.prepare(`SELECT * FROM session_bindings
      WHERE session_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
      ORDER BY valid_from DESC LIMIT 1`).get(sessionId, ts, ts) as Record<string, unknown> | undefined;
    return row ? UsageLedger.toBinding(row) : null;
  }

  private anyBinding(sessionId: string): SessionBinding | null {
    const row = this.db.prepare('SELECT * FROM session_bindings WHERE session_id = ? ORDER BY valid_from ASC LIMIT 1')
      .get(sessionId) as Record<string, unknown> | undefined;
    return row ? UsageLedger.toBinding(row) : null;
  }

  private static toBinding(r: Record<string, unknown>): SessionBinding {
    return {
      sessionId: r.session_id as string, framework: r.framework as UsageFramework, sessionKind: r.session_kind as SessionKind,
      cwd: (r.cwd as string) ?? null, topicId: (r.topic_id as string) ?? null, jobSlug: (r.job_slug as string) ?? null,
      runId: (r.run_id as string) ?? null, accountId: (r.account_id as string) ?? null, machineId: r.machine_id as string,
      validFrom: r.valid_from as number, validTo: (r.valid_to as number) ?? null,
    };
  }

  // ── membership ──────────────────────────────────────────────────────

  /**
   * Spec: Membership. A spawn record decides (when the transcript's own cwd matches the
   * binding's cwd); otherwise the transcript's own cwd under a registered agent path,
   * not under a nested other-agent home (longest path wins); otherwise not a member.
   */
  membership(sessionId: string, cwd: string | null): ScopeBasis | null {
    const binding = this.anyBinding(sessionId);
    if (binding && (!binding.cwd || !cwd || path.resolve(binding.cwd) === path.resolve(cwd))) return 'spawn-record';
    if (!cwd) return null;
    const abs = path.resolve(cwd);
    let best: { len: number; ours: boolean } | null = null;
    for (const h of this.opts.agentHomes) {
      const hp = path.resolve(h);
      if (isUnder(abs, hp) && (!best || hp.length > best.len)) best = { len: hp.length, ours: true };
    }
    for (const h of this.opts.otherAgentHomes) {
      const hp = path.resolve(h);
      if (isUnder(abs, hp) && (!best || hp.length > best.len)) best = { len: hp.length, ours: false };
    }
    return best?.ours ? 'cwd' : null;
  }

  /** May a project directory (by its encoded name) hold members? Rules a directory IN only. */
  private dirMayHoldMembers(dirName: string, dirPath: string): boolean {
    for (const h of this.opts.agentHomes) {
      if (dirName.startsWith(encodeClaudeProjectDir(path.resolve(h)))) return true;
    }
    // A spawn-record session file anywhere rules the directory in, wherever its cwd is.
    let entries: string[];
    try { entries = fs.readdirSync(dirPath); } catch { /* @silent-fallback-ok: an unreadable directory holds no readable usage; the scan continues */ return false; }
    const stmt = this.db.prepare('SELECT 1 FROM session_bindings WHERE session_id = ? LIMIT 1');
    return entries.some(e => e.endsWith('.jsonl') && stmt.get(e.slice(0, -'.jsonl'.length)) !== undefined);
  }

  // ── scan ────────────────────────────────────────────────────────────

  /** Enumerate candidate transcript files under one root, honoring depth, symlink and window limits. */
  private listRootFiles(root: string): string[] {
    const cov = this.coverage.get(root)!;
    const projects = path.join(root, 'projects');
    const out: string[] = [];
    let dirs: fs.Dirent[];
    try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { /* @silent-fallback-ok: an unreadable directory holds no readable usage; the scan continues */ return out; }
    const cutoff = this.opts.now() - this.opts.maxFileAgeMs;
    let skippedDirs = 0, outOfWindow = 0, tooDeep = 0;
    const walk = (dir: string, depth: number): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* @silent-fallback-ok: an unreadable directory holds no readable usage; the scan continues */ return; }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth + 1 > this.opts.maxDepth) { tooDeep++; continue; }
          walk(p, depth + 1);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try { if (fs.statSync(p).mtimeMs < cutoff) { outOfWindow++; continue; } } catch { /* @silent-fallback-ok: a file that vanished mid-scan has nothing to ingest */ continue; }
          out.push(p);
        }
      }
    };
    for (const d of dirs) {
      if (!d.isDirectory() || d.isSymbolicLink()) continue;
      const dp = path.join(projects, d.name);
      if (!this.dirMayHoldMembers(d.name, dp)) { skippedDirs++; continue; }
      walk(dp, 1);
    }
    cov.filesSkippedDirs = skippedDirs;
    cov.filesOutOfWindow = outOfWindow;
    cov.filesTooDeep = tooDeep;
    return out.sort();
  }

  /**
   * One scan tick: a shared file budget consumed round-robin across roots (spec: Slice 1).
   * Unchanged files (same inode, size equal to the checkpoint offset) cost nothing.
   */
  scanTick(): ScanReport {
    const report: ScanReport = { filesRead: 0, rowsInserted: 0, rowsCounted: 0, pending: 0 };
    // Bindings from queued one-shots must exist before their transcripts are scanned.
    try { this.flushInvocations(); } catch (err) { /* @silent-fallback-ok: usage recording is observational; the next tick retries */ console.warn('[UsageLedger] invocation flush failed:', err); }
    if (this.pendingDetailRescan) {
      this.pendingDetailRescan = false;
      // After a snapshot import: content before each checkpoint is re-read for detail only (never counted).
      for (const { path: p, root } of this.db.prepare(`SELECT path, root FROM checkpoints WHERE extra IS NULL`).all() as { path: string; root: string }[]) {
        try { this.ingestClaudeFile(root, p, { rescanForDetail: true }); } catch { /* @silent-fallback-ok: a detail rescan miss leaves totals intact; only per-request detail is absent */ }
      }
    }
    if (this.roots.length === 0 && this.codexRoots.length === 0) return report;
    const queues = [
      ...this.roots.map(r => ({ r, kind: 'claude' as const, files: this.listRootFiles(r.root).filter(f => this.fileChanged(f)) })),
      ...this.codexRoots.map(r => ({ r, kind: 'codex' as const, files: this.listCodexFiles(r.root).filter(f => this.fileChanged(f)) })),
    ];
    let budget = this.opts.filesPerTick;
    let progressed = true;
    while (budget > 0 && progressed) {
      progressed = false;
      for (let i = 0; i < queues.length && budget > 0; i++) {
        const q = queues[(this.rootCursor + i) % queues.length];
        const f = q.files.shift();
        if (!f) continue;
        const r = q.kind === 'codex' ? this.ingestCodexFile(q.r.root, f) : this.ingestClaudeFile(q.r.root, f);
        report.filesRead++;
        report.rowsInserted += r.inserted;
        report.rowsCounted += r.counted;
        this.coverage.get(q.r.root)!.filesScanned++;
        budget--;
        progressed = true;
      }
      this.rootCursor = (this.rootCursor + 1) % queues.length;
    }
    for (const q of queues) {
      this.coverage.get(q.r.root)!.filesPending = q.files.length;
      report.pending += q.files.length;
    }
    try { this.settlePairs(); } catch (err) { /* @silent-fallback-ok: usage recording is observational; the next tick retries */ console.warn('[UsageLedger] pair settlement failed:', err); }
    return report;
  }

  private fileChanged(file: string): boolean {
    const cp = this.db.prepare('SELECT inode, offset FROM checkpoints WHERE path = ?').get(file) as { inode: number; offset: number } | undefined;
    if (!cp) return true;
    try {
      const st = fs.statSync(file);
      return st.ino !== cp.inode || st.size !== cp.offset;
    } catch { /* @silent-fallback-ok: filesystem race: the file is re-examined on the next tick */ return false; }
  }

  /**
   * Ingest one Claude transcript from its checkpoint. Rows, rollup deltas and the
   * checkpoint advance commit in one transaction (spec: Replay safety).
   * `rescanForDetail` re-reads from 0 and stores missing rows before the checkpoint as
   * `replay` (detail only, never counted) — used after a snapshot import.
   */
  ingestClaudeFile(root: string, file: string, opts: { rescanForDetail?: boolean } = {}): { inserted: number; counted: number } {
    let st: fs.Stats;
    try {
      const lst = fs.lstatSync(file);
      if (lst.isSymbolicLink()) return { inserted: 0, counted: 0 };
      st = lst;
    } catch { /* @silent-fallback-ok: filesystem race: the file is re-examined on the next tick */ return { inserted: 0, counted: 0 }; }
    const head = UsageLedger.readHead(file);
    const cp = this.db.prepare('SELECT * FROM checkpoints WHERE path = ?').get(file) as
      { inode: number; head_hash: string; birth_ms: number; offset: number } | undefined;
    const sameFile = !!cp && cp.inode === st.ino && cp.head_hash === head && st.size >= cp.offset;
    const checkpointOffset = sameFile ? cp!.offset : 0;
    const birthMs = sameFile ? cp!.birth_ms : (st.birthtimeMs > 0 ? Math.floor(st.birthtimeMs) : 0);
    const startAt = opts.rescanForDetail ? 0 : checkpointOffset;
    if (st.size <= startAt) return { inserted: 0, counted: 0 };

    const buf = UsageLedger.readFrom(file, startAt, st.size);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { inserted: 0, counted: 0 };
    const text = buf.subarray(0, lastNl + 1).toString('utf8');
    const isSubagent = file.split(path.sep).includes('subagents');
    const parentSessionId = isSubagent ? path.basename(path.dirname(path.dirname(file))) : null;

    const insert = this.db.prepare(`INSERT OR IGNORE INTO usage_events
      (observation_id, correlation_key, grain, ts, source, framework, model, machine_id, account_id, session_id, session_kind,
       parent_session_id, scope_basis, topic_id, job_slug, run_id, feature, tok_input, tok_cache_read, tok_cache_write,
       tok_output, tok_reasoning, status, reported_usd, reported_basis, source_path, source_pos)
      VALUES (@observation_id, @correlation_key, 'request', @ts, 'claude-transcript', 'claude-code', @model, @machine_id,
       @account_id, @session_id, @session_kind, @parent_session_id, @scope_basis, @topic_id, @job_slug, @run_id, NULL,
       @tok_input, @tok_cache_read, @tok_cache_write, @tok_output, NULL, @status, NULL, NULL, @source_path, @source_pos)`);
    const exists = this.db.prepare('SELECT 1 FROM usage_events WHERE observation_id = ?');

    const memberCache = new Map<string, ScopeBasis | null>();
    const batch = new DeltaBatch();
    let inserted = 0, counted = 0, pairHeld = 0;
    const newOffset = startAt + lastNl + 1;

    const tx = this.db.transaction(() => {
      let pos = startAt;
      for (const line of text.split('\n')) {
        const linePos = pos;
        pos += Buffer.byteLength(line, 'utf8') + 1;
        if (!line.trim()) continue;
        let obj: Record<string, any>;
        try { obj = JSON.parse(line); } catch { /* @silent-fallback-ok: a malformed transcript line is skipped; the row count is unaffected for valid lines */ continue; }
        if (obj.type !== 'assistant' || !obj.message?.usage || !obj.requestId || !obj.sessionId || !obj.timestamp) continue;
        const ts = Date.parse(obj.timestamp);
        if (Number.isNaN(ts)) continue;
        const sessionId = clip(obj.sessionId)!;
        const cwd = clip(obj.cwd);
        let scope = memberCache.get(sessionId);
        if (scope === undefined) {
          scope = this.membership(isSubagent && parentSessionId ? parentSessionId : sessionId, cwd);
          if (!scope) scope = this.membership(sessionId, cwd);
          memberCache.set(sessionId, scope);
        }
        if (!scope) continue;
        const observationId = UsageLedger.observationId('claude-transcript', String(obj.requestId));
        const already = exists.get(observationId) !== undefined;
        if (already) continue;
        let status: RowStatus = 'counted';
        if (linePos < checkpointOffset) status = 'replay';
        else if (birthMs > 0 && ts < birthMs) status = 'copied-history';
        const binding = this.bindingAt(isSubagent && parentSessionId ? parentSessionId : sessionId, ts);
        const sessionKind: SessionKind = isSubagent ? 'subagent' : binding?.sessionKind ?? 'interactive';
        const parts = claudeUsageToParts(obj.message.usage);
        const model = clip(obj.message.model);
        const res = insert.run({
          observation_id: observationId,
          correlation_key: `claude-code:${sessionId}`,
          ts, model, machine_id: this.opts.machineId,
          account_id: binding?.accountId ?? null,
          session_id: sessionId, session_kind: sessionKind, parent_session_id: parentSessionId,
          scope_basis: scope, topic_id: binding?.topicId ?? null, job_slug: binding?.jobSlug ?? null,
          run_id: binding?.runId ?? null,
          tok_input: parts.input, tok_cache_read: parts.cacheRead, tok_cache_write: parts.cacheWrite, tok_output: parts.output,
          status, source_path: file, source_pos: linePos,
        });
        if (res.changes !== 1) continue;
        inserted++;
        if (status !== 'counted') continue;
        const row: RowForRollup = {
          ts, machine: this.opts.machineId, framework: 'claude-code', model, sessionKind,
          topic: binding?.topicId ?? null, job: binding?.jobSlug ?? null, run: binding?.runId ?? null, feature: null,
          sessionId, parts, reportedUsd: null, reportedBasis: null,
        };
        if (this.routeFileRowThroughPair(`claude-code:${sessionId}`, observationId, row, file)) { pairHeld++; continue; }
        counted++;
        batch.add(row, 1);
      }
      this.applyBatch(batch);
      void pairHeld;
      this.metaSet('raw_rows', String(this.rawRowCount + inserted));
      this.db.prepare(`INSERT INTO checkpoints(path, root, inode, head_hash, birth_ms, offset, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET inode = excluded.inode, head_hash = excluded.head_hash,
        birth_ms = excluded.birth_ms, offset = excluded.offset, updated_at = excluded.updated_at`)
        .run(file, root, st.ino, head, birthMs, Math.max(newOffset, checkpointOffset), this.opts.now());
    });
    tx();
    return { inserted, counted };
  }

  private applyBatch(batch: DeltaBatch): void {
    if (batch.empty) return;
    const seq = this.nextSeq();
    for (const [name, map] of [['hour', batch.hour], ['day', batch.day], ['sessionDay', batch.sessionDay]] as const) {
      const stmt = this.upsertStmts[name];
      for (const d of map.values()) stmt.run({ ...d.key, ...Object.fromEntries(SUM_COLS.map((c, i) => [c, d.sums[i]])), change_seq: seq });
    }
  }

  private prepareUpsert(table: string, keyCols: readonly string[]): Database.Statement {
    const cols = [...keyCols, ...SUM_COLS, 'change_seq'];
    return this.db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})
      ON CONFLICT(${keyCols.join(', ')}) DO UPDATE SET
      ${SUM_COLS.map(c => `${c} = ${c} + excluded.${c}`).join(', ')}, change_seq = excluded.change_seq`);
  }

  private static observationId(source: string, nativeId: string): string {
    return crypto.createHash('sha256').update(`${source}\u0000${nativeId}`).digest('hex').slice(0, 32);
  }

  private static readHead(file: string): string {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, b, 0, HEAD_BYTES, 0);
      return crypto.createHash('sha256').update(b.subarray(0, n)).digest('hex').slice(0, 16);
    } finally { fs.closeSync(fd); }
  }

  private static readFrom(file: string, start: number, end: number): Buffer {
    const fd = fs.openSync(file, 'r');
    try {
      const b = Buffer.alloc(end - start);
      fs.readSync(fd, b, 0, end - start, start);
      return b;
    } finally { fs.closeSync(fd); }
  }

  // ── Slice 2: intelligence calls, dedupe pairs ───────────────────────

  private readonly invocationQueue: QueuedInvocation[] = [];
  private queueDropped = 0;

  /**
   * Bounded, non-blocking enqueue from the funnel (spec: Slice 2). Never throws:
   * the caller is a live decision and recording must never affect it.
   */
  enqueueInvocation(rec: InvocationInput): void {
    try {
      if (this.closed) return;
      if (this.invocationQueue.length >= this.opts.invocationQueueMax) {
        this.invocationQueue.shift();
        this.queueDropped++;
      }
      this.invocationQueue.push({ ...rec, callId: crypto.randomUUID() });
    } catch { /* @silent-fallback-ok: an enqueue failure loses one usage row, never the call it describes */ }
  }

  get queuedInvocations(): number { return this.invocationQueue.length; }
  get droppedInvocations(): number { return this.queueDropped; }

  /** Flush queued invocations in one transaction: rows, bindings, pairs and rollup deltas together. */
  flushInvocations(): number {
    if (this.invocationQueue.length === 0) return 0;
    const items = this.invocationQueue.splice(0, this.invocationQueue.length);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO usage_events
      (observation_id, correlation_key, grain, ts, source, framework, model, machine_id, account_id, session_id, session_kind,
       parent_session_id, scope_basis, topic_id, job_slug, run_id, feature, tok_input, tok_cache_read, tok_cache_write,
       tok_output, tok_reasoning, status, reported_usd, reported_basis, source_path, source_pos)
      VALUES (@observation_id, @correlation_key, 'invocation', @ts, 'intelligence-call', @framework, @model, @machine_id,
       NULL, @session_id, 'internal', NULL, 'spawn-record', NULL, @job_slug, @run_id, @feature,
       @tok_input, @tok_cache_read, @tok_cache_write, @tok_output, @tok_reasoning, 'counted', @reported_usd, @reported_basis, NULL, NULL)`);
    let n = 0;
    const tx = this.db.transaction(() => {
      const batch = new DeltaBatch();
      for (const it of items) {
        const framework = normalizeFramework(it.framework);
        const u = it.usage;
        const parts: TokenParts = {
          input: nonNegInt(u?.input), cacheRead: nonNegInt(u?.cacheRead), cacheWrite: nonNegInt(u?.cacheWrite),
          output: nonNegInt(u?.output), reasoning: nonNegInt(u?.reasoning),
        };
        const sessionId = clip(u?.sessionId ?? null);
        const correlationKey = sessionId ? `${framework}:${sessionId}` : null;
        const observationId = UsageLedger.observationId('intelligence-call', it.callId);
        const usd = typeof u?.reportedUsd === 'number' && Number.isFinite(u.reportedUsd) ? u.reportedUsd : null;
        const basis = usd != null ? (u?.reportedBasis ?? null) : null;
        const res = insert.run({
          observation_id: observationId, correlation_key: correlationKey, ts: it.startedAt, framework,
          model: clip(it.model), machine_id: this.opts.machineId, session_id: sessionId,
          job_slug: clip(it.jobSlug), run_id: clip(it.runId), feature: clip(it.feature),
          tok_input: parts.input, tok_cache_read: parts.cacheRead, tok_cache_write: parts.cacheWrite,
          tok_output: parts.output, tok_reasoning: parts.reasoning, reported_usd: usd, reported_basis: basis,
        });
        if (res.changes !== 1) continue;
        n++;
        if (!sessionId) this.bump('invocations_uncorrelated');
        if (parts.input == null && parts.output == null) this.bump('invocations_no_counts');
        const row: RowForRollup = {
          ts: it.startedAt, machine: this.opts.machineId, framework, model: clip(it.model), sessionKind: 'internal',
          topic: null, job: clip(it.jobSlug), run: clip(it.runId), feature: clip(it.feature),
          sessionId, parts, reportedUsd: usd, reportedBasis: basis,
        };
        batch.add(row, 1);
        if (sessionId) {
          // The provider session this call ran in is this agent's own (a spawn record).
          this.recordBindingInTx({
            sessionId, framework, sessionKind: 'internal', cwd: null, topicId: null,
            jobSlug: clip(it.jobSlug), runId: clip(it.runId), accountId: null, validFrom: it.startedAt,
          });
          this.openPair(correlationKey!, observationId, row, it.startedAt, it.endedAt, batch);
        }
      }
      this.applyBatch(batch);
      this.metaSet('raw_rows', String(this.rawRowCount + n));
    });
    tx();
    return n;
  }

  private bump(key: string, by = 1): void {
    this.metaSet(`cov:${key}`, String(Number(this.metaGet(`cov:${key}`) ?? '0') + by));
  }

  private counter(key: string): number { return Number(this.metaGet(`cov:${key}`) ?? '0'); }

  private recordBindingInTx(b: Omit<SessionBinding, 'validTo' | 'machineId'>): void {
    this.db.prepare(`INSERT OR IGNORE INTO session_bindings
      (session_id, framework, session_kind, cwd, topic_id, job_slug, run_id, account_id, machine_id, valid_from, valid_to, change_seq)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`)
      .run(b.sessionId, b.framework, b.sessionKind, b.cwd, b.topicId, b.jobSlug, b.runId, b.accountId, this.opts.machineId, b.validFrom, this.nextSeq());
  }

  /**
   * Open (or join) the dedupe pair for an invocation. File rows already counted under
   * this key are moved to the held side, so whichever arrives first the result is the same.
   */
  private openPair(key: string, invObs: string, inv: RowForRollup, start: number, end: number, batch: DeltaBatch): void {
    const existing = this.db.prepare('SELECT * FROM pairs WHERE correlation_key = ?').get(key) as PairRow | undefined;
    if (existing) {
      // More than one invocation on one provider session (not expected): both stay counted.
      this.db.prepare(`UPDATE pairs SET state = 'ambiguous', invocations = invocations + 1, updated_at = ? WHERE correlation_key = ?`)
        .run(this.opts.now(), key);
      return;
    }
    const counted = this.db.prepare(`SELECT * FROM usage_events WHERE correlation_key = ? AND status = 'counted' AND grain = 'request'`)
      .all(key) as Record<string, any>[];
    const held: RowForRollup[] = [];
    let filePath: string | null = null;
    let lastFileAt: number | null = null;
    for (const r of counted) {
      const row = UsageLedger.eventToRollupRow(r);
      batch.add(row, -1);
      held.push(UsageLedger.fillFromInvocation(row, inv));
      filePath = r.source_path ?? filePath;
      lastFileAt = Math.max(lastFileAt ?? 0, r.ts);
    }
    if (counted.length) {
      this.db.prepare(`UPDATE usage_events SET status = 'held' WHERE correlation_key = ? AND status = 'counted' AND grain = 'request'`).run(key);
    }
    this.db.prepare(`INSERT INTO pairs (correlation_key, inv_observation_id, inv_row, inv_start, inv_end, held, file_path, last_file_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(key, invObs, JSON.stringify(inv), start, end, JSON.stringify(UsageLedger.compactHeld(held)), filePath, lastFileAt, this.opts.now());
  }

  /**
   * A newly counted file row whose correlation key has an invocation pair: held while the
   * invocation side is counted (returns true); counted as a token-only row when the pair
   * settled on the file side (returns false after adjusting the row).
   */
  private routeFileRowThroughPair(key: string, obs: string, row: RowForRollup, file: string): boolean {
    const pair = this.db.prepare('SELECT * FROM pairs WHERE correlation_key = ?').get(key) as PairRow | undefined;
    if (!pair) return false;
    const inv = JSON.parse(pair.inv_row) as RowForRollup;
    const filled = UsageLedger.fillFromInvocation(row, inv);
    Object.assign(row, filled);
    if (pair.counted_side === 'file') {
      row.callsWeight = 0;
      return false;
    }
    const held = JSON.parse(pair.held) as RowForRollup[];
    held.push(filled);
    // A file row after a settlement that disagreed re-opens the comparison.
    const state = pair.state === 'disagreement' ? 'open' : pair.state;
    this.db.prepare(`UPDATE pairs SET held = ?, file_path = ?, last_file_at = ?, state = ?, updated_at = ? WHERE correlation_key = ?`)
      .run(JSON.stringify(UsageLedger.compactHeld(held)), file, Math.max(pair.last_file_at ?? 0, row.ts), state, this.opts.now(), key);
    this.db.prepare(`UPDATE usage_events SET status = 'held' WHERE observation_id = ?`).run(obs);
    return true;
  }

  /**
   * Settle open pairs (spec: Cross-source rule). A pair settles once its file is read to
   * the end, past the invocation's end, and quiet for the settle window. Agreeing totals
   * move the tokens to the file side (the invocation keeps its call and dollars);
   * disagreeing totals leave the invocation counted and the excess shown as disputed.
   */
  settlePairs(): { settled: number; disagreed: number } {
    const now = this.opts.now();
    const out = { settled: 0, disagreed: 0 };
    const open = this.db.prepare(`SELECT * FROM pairs WHERE state = 'open' AND counted_side = 'invocation'`).all() as PairRow[];
    const tx = this.db.transaction(() => {
      const batch = new DeltaBatch();
      for (const p of open) {
        const held = JSON.parse(p.held) as RowForRollup[];
        if (held.length === 0 || !p.file_path) continue;
        if (now - Math.max(p.inv_end, p.last_file_at ?? 0) < this.opts.settleWindowMs) continue;
        if (this.fileChanged(p.file_path)) continue;
        const inv = JSON.parse(p.inv_row) as RowForRollup;
        const invTotal = tokenTotal(inv.parts);
        const fileTotal = held.reduce((a, r) => a + tokenTotal(r.parts), 0);
        if (Math.abs(fileTotal - invTotal) <= Math.max(2, invTotal * 0.005)) {
          batch.add({ ...inv, tokensOnly: true }, -1);
          for (const r of held) batch.add({ ...r, tokensOnly: true }, 1);
          this.db.prepare(`UPDATE usage_events SET status = 'counted' WHERE correlation_key = ? AND status = 'held'`).run(p.correlation_key);
          this.db.prepare(`UPDATE usage_events SET status = 'paired' WHERE observation_id = ?`).run(p.inv_observation_id);
          this.db.prepare(`UPDATE pairs SET counted_side = 'file', state = 'settled', held = '[]', disputed = 0, updated_at = ? WHERE correlation_key = ?`)
            .run(now, p.correlation_key);
          out.settled++;
        } else {
          this.db.prepare(`UPDATE pairs SET state = 'disagreement', disputed = ?, updated_at = ? WHERE correlation_key = ?`)
            .run(Math.max(0, fileTotal - invTotal), now, p.correlation_key);
          out.disagreed++;
        }
      }
      this.applyBatch(batch);
    });
    tx();
    return out;
  }

  pairCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare('SELECT state, COUNT(*) AS n, COALESCE(SUM(disputed), 0) AS d FROM pairs GROUP BY state').all() as { state: string; n: number; d: number }[]) {
      out[r.state] = r.n;
      if (r.d) out.disputedTokens = (out.disputedTokens ?? 0) + r.d;
    }
    return out;
  }

  private static fillFromInvocation(row: RowForRollup, inv: RowForRollup): RowForRollup {
    return {
      ...row,
      sessionKind: 'internal',
      job: row.job ?? inv.job, run: row.run ?? inv.run, feature: row.feature ?? inv.feature, topic: row.topic ?? inv.topic,
      callsWeight: 0, reportedUsd: null, reportedBasis: null,
    };
  }

  /** Keep held aggregates small: one entry per rollup hour key. */
  private static compactHeld(rows: RowForRollup[]): RowForRollup[] {
    const m = new Map<string, RowForRollup>();
    for (const r of rows) {
      const k = [Math.floor(r.ts / HOUR_MS), r.framework, r.model, r.sessionKind, r.topic, r.job, r.run, r.feature, r.sessionId].join('\u0000');
      const cur = m.get(k);
      if (!cur) { m.set(k, { ...r, ts: Math.floor(r.ts / HOUR_MS) * HOUR_MS, parts: { ...r.parts } }); continue; }
      for (const f of ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const) {
        cur.parts[f] = cur.parts[f] == null && r.parts[f] == null ? null : (cur.parts[f] ?? 0) + (r.parts[f] ?? 0);
      }
    }
    return [...m.values()];
  }

  private static eventToRollupRow(r: Record<string, any>): RowForRollup {
    return {
      ts: r.ts, machine: r.machine_id, framework: r.framework, model: r.model ?? null, sessionKind: r.session_kind,
      topic: r.topic_id ?? null, job: r.job_slug ?? null, run: r.run_id ?? null, feature: r.feature ?? null,
      sessionId: r.session_id ?? null,
      parts: { input: r.tok_input, cacheRead: r.tok_cache_read, cacheWrite: r.tok_cache_write, output: r.tok_output, reasoning: r.tok_reasoning },
      reportedUsd: r.reported_usd ?? null, reportedBasis: r.reported_basis ?? null,
    };
  }

  // ── Slice 2: Codex rollouts ─────────────────────────────────────────

  private readonly codexRoots: { root: string; origin: string }[] = [];

  /** Register a Codex home (`$CODEX_HOME`, default `~/.codex`). Rollouts live under `sessions/`. */
  addCodexRoot(codexHome: string, origin: string): void {
    const root = path.resolve(codexHome);
    if (this.codexRoots.some(r => r.root === root)) return;
    this.codexRoots.push({ root, origin });
    this.coverage.set(root, { root, origin: `codex:${origin}`, filesScanned: 0, filesSkippedDirs: 0, filesOutOfWindow: 0, filesTooDeep: 0, filesPending: 0 });
  }

  private listCodexFiles(root: string): string[] {
    const cov = this.coverage.get(root)!;
    const base = path.join(root, 'sessions');
    const cutoff = this.opts.now() - this.opts.maxFileAgeMs;
    const out: string[] = [];
    let outOfWindow = 0;
    const walk = (dir: string, depth: number): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { /* @silent-fallback-ok: an unreadable directory holds no readable usage; the scan continues */ return; }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory() && depth < 3) walk(p, depth + 1);
        else if (e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl')) {
          try { if (fs.statSync(p).mtimeMs < cutoff) { outOfWindow++; continue; } } catch { /* @silent-fallback-ok: a file that vanished mid-scan has nothing to ingest */ continue; }
          out.push(p);
        }
      }
    };
    walk(base, 0);
    cov.filesOutOfWindow = outOfWindow;
    return out.sort();
  }

  /**
   * Ingest one Codex rollout from its checkpoint (spec: Slice 2). Per-request rows are
   * the deltas of the cumulative `total_token_usage` between consecutive `token_count`
   * events, skipping events whose total did not change. Input excludes cached input.
   */
  ingestCodexFile(root: string, file: string): { inserted: number; counted: number } {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(file);
      if (st.isSymbolicLink()) return { inserted: 0, counted: 0 };
    } catch { /* @silent-fallback-ok: filesystem race: the file is re-examined on the next tick */ return { inserted: 0, counted: 0 }; }
    const head = UsageLedger.readHead(file);
    const cp = this.db.prepare('SELECT * FROM checkpoints WHERE path = ?').get(file) as
      { inode: number; head_hash: string; birth_ms: number; offset: number; extra: string | null } | undefined;
    const same = !!cp && cp.inode === st.ino && cp.head_hash === head && st.size >= cp.offset;
    const startAt = same ? cp!.offset : 0;
    const birthMs = same ? cp!.birth_ms : (st.birthtimeMs > 0 ? Math.floor(st.birthtimeMs) : 0);
    const state: CodexCheckpointState = same && cp!.extra ? JSON.parse(cp!.extra) : { sessionId: null, cwd: null, model: null, last: null, baseline: null, resumed: false };
    if (st.size <= startAt) return { inserted: 0, counted: 0 };
    const buf = UsageLedger.readFrom(file, startAt, st.size);
    const lastNl = buf.lastIndexOf(0x0a);
    if (lastNl < 0) return { inserted: 0, counted: 0 };
    const text = buf.subarray(0, lastNl + 1).toString('utf8');
    const insert = this.db.prepare(`INSERT OR IGNORE INTO usage_events
      (observation_id, correlation_key, grain, ts, source, framework, model, machine_id, account_id, session_id, session_kind,
       parent_session_id, scope_basis, topic_id, job_slug, run_id, feature, tok_input, tok_cache_read, tok_cache_write,
       tok_output, tok_reasoning, status, reported_usd, reported_basis, source_path, source_pos)
      VALUES (@observation_id, @correlation_key, 'request', @ts, 'codex-rollout', 'codex-cli', @model, @machine_id,
       @account_id, @session_id, @session_kind, NULL, @scope_basis, @topic_id, @job_slug, @run_id, NULL,
       @tok_input, @tok_cache_read, NULL, @tok_output, @tok_reasoning, 'counted', NULL, NULL, @source_path, @source_pos)`);
    let inserted = 0, counted = 0;
    const batch = new DeltaBatch();
    let scope: ScopeBasis | null | undefined;
    const tx = this.db.transaction(() => {
      let pos = startAt;
      for (const line of text.split('\n')) {
        const linePos = pos;
        pos += Buffer.byteLength(line, 'utf8') + 1;
        if (!line.trim() || line[0] !== '{') continue;
        let d: Record<string, any>;
        try { d = JSON.parse(line); } catch { /* @silent-fallback-ok: a malformed transcript line is skipped; the row count is unaffected for valid lines */ continue; }
        const payload = d.payload && typeof d.payload === 'object' ? d.payload : null;
        if (!payload) continue;
        if (d.type === 'session_meta') {
          state.sessionId = clip(payload.id) ?? state.sessionId;
          state.cwd = clip(payload.cwd) ?? state.cwd;
          state.resumed = Object.keys(payload).some(k => /fork|resum|parent/i.test(k) && payload[k]);
          continue;
        }
        if (d.type === 'turn_context') { state.model = clip(payload.model) ?? state.model; continue; }
        if (payload.type !== 'token_count' || !payload.info?.total_token_usage) continue;
        const t = codexTotals(payload.info.total_token_usage);
        if (!state.sessionId) continue;
        if (!state.last) {
          if (state.resumed) {
            // A resumed or forked rollout starts from inherited usage: store it as the baseline.
            state.baseline = t; state.last = t;
            this.bump('codex_inherited_uncounted', t.input + t.output);
            continue;
          }
          state.last = { input: 0, cached: 0, output: 0, reasoning: 0 };
        }
        const delta = { input: t.input - state.last.input, cached: t.cached - state.last.cached, output: t.output - state.last.output, reasoning: t.reasoning - state.last.reasoning };
        if (delta.input === 0 && delta.cached === 0 && delta.output === 0) continue;
        if (delta.input < 0 || delta.output < 0 || delta.cached < 0) { this.bump('codex_delta_mismatch'); state.last = t; continue; }
        state.last = t;
        if (scope === undefined) scope = this.membership(state.sessionId, state.cwd);
        if (!scope) continue;
        const ts = Date.parse(d.timestamp ?? '') || st.mtimeMs;
        const binding = this.bindingAt(state.sessionId, ts);
        const parts: TokenParts = { input: Math.max(0, delta.input - delta.cached), cacheRead: delta.cached, cacheWrite: null, output: delta.output, reasoning: delta.reasoning };
        const obs = UsageLedger.observationId('codex-rollout', `${state.sessionId}:${linePos}`);
        const sessionKind: SessionKind = binding?.sessionKind ?? 'interactive';
        const res = insert.run({
          observation_id: obs, correlation_key: `codex-cli:${state.sessionId}`, ts, model: state.model,
          machine_id: this.opts.machineId, account_id: binding?.accountId ?? null, session_id: state.sessionId,
          session_kind: sessionKind, scope_basis: scope, topic_id: binding?.topicId ?? null, job_slug: binding?.jobSlug ?? null,
          run_id: binding?.runId ?? null, tok_input: parts.input, tok_cache_read: parts.cacheRead, tok_output: parts.output,
          tok_reasoning: parts.reasoning, source_path: file, source_pos: linePos,
        });
        if (res.changes !== 1) continue;
        inserted++;
        if (birthMs > 0 && ts < birthMs - 1000) {
          this.db.prepare(`UPDATE usage_events SET status = 'copied-history' WHERE observation_id = ?`).run(obs);
          continue;
        }
        const row: RowForRollup = {
          ts, machine: this.opts.machineId, framework: 'codex-cli', model: state.model, sessionKind,
          topic: binding?.topicId ?? null, job: binding?.jobSlug ?? null, run: binding?.runId ?? null, feature: null,
          sessionId: state.sessionId, parts, reportedUsd: null, reportedBasis: null,
        };
        if (this.routeFileRowThroughPair(`codex-cli:${state.sessionId}`, obs, row, file)) continue;
        counted++;
        batch.add(row, 1);
      }
      this.applyBatch(batch);
      this.metaSet('raw_rows', String(this.rawRowCount + inserted));
      this.db.prepare(`INSERT INTO checkpoints(path, root, inode, head_hash, birth_ms, offset, updated_at, extra)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET inode = excluded.inode, head_hash = excluded.head_hash,
        birth_ms = excluded.birth_ms, offset = excluded.offset, updated_at = excluded.updated_at, extra = excluded.extra`)
        .run(file, root, st.ino, head, birthMs, startAt + lastNl + 1, this.opts.now(), JSON.stringify(state));
    });
    tx();
    return { inserted, counted };
  }

  /** Coverage counters kept in meta (spec: /usage/coverage). */
  coverageCounters(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT key, value FROM meta WHERE key LIKE 'cov:%'`).all() as { key: string; value: string }[]) {
      out[r.key.slice(4)] = Number(r.value);
    }
    out.invocations_dropped = this.queueDropped;
    out.invocations_queued = this.invocationQueue.length;
    return out;
  }

  // ── Slice 4: replication stream (served by every machine) ───────────

  /**
   * One page of this machine's own rollup and binding rows changed after `afterSeq`, in
   * change_seq order (spec: Pool view). Pooled and frozen rows are never exported.
   */
  exportPage(afterSeq: number, limit = PAGE_ROWS): ExportPage {
    const cap = Math.max(1, Math.min(limit, PAGE_ROWS));
    // A batch shares one change_seq across many rows, so a page only ever ends on a seq
    // boundary: rows at or below `bound` are complete in every table.
    let bound = Number.POSITIVE_INFINITY;
    const fetched: ExportRow[] = [];
    for (const t of EXPORT_TABLES) {
      const rows = this.db.prepare(`SELECT * FROM ${t} WHERE change_seq > ? ORDER BY change_seq LIMIT ?`).all(afterSeq, cap) as Record<string, unknown>[];
      if (rows.length === cap) bound = Math.min(bound, (rows[rows.length - 1].change_seq as number) - 1);
      for (const row of rows) fetched.push({ table: t, row });
    }
    let candidates = fetched.filter(r => (r.row.change_seq as number) <= bound);
    if (candidates.length === 0 && fetched.length > 0) {
      // One batch larger than a page: send that whole seq, uncapped.
      const seq = Math.min(...fetched.map(r => r.row.change_seq as number));
      candidates = [];
      for (const t of EXPORT_TABLES) {
        for (const row of this.db.prepare(`SELECT * FROM ${t} WHERE change_seq = ?`).all(seq) as Record<string, unknown>[]) candidates.push({ table: t, row });
      }
    }
    candidates.sort((a, b) => (a.row.change_seq as number) - (b.row.change_seq as number));
    // Apply the row and byte caps, again only at seq boundaries.
    const page: ExportRow[] = [];
    let bytes = 0;
    let i = 0;
    while (i < candidates.length) {
      const seq = candidates[i].row.change_seq as number;
      let j = i;
      let groupBytes = 0;
      while (j < candidates.length && candidates[j].row.change_seq === seq) { groupBytes += JSON.stringify(candidates[j].row).length; j++; }
      if (page.length > 0 && (page.length + (j - i) > cap || bytes + groupBytes > PAGE_BYTES)) break;
      for (let k = i; k < j; k++) page.push(candidates[k]);
      bytes += groupBytes;
      i = j;
    }
    const lastSeq = page.length ? (page[page.length - 1].row.change_seq as number) : afterSeq;
    const maxSeq = Number(this.metaGet('change_seq') ?? '0');
    return {
      machineId: this.opts.machineId,
      generationId: this.generationId,
      snapshotAt: Number(this.metaGet('snapshot_imported_at') ?? '0'),
      rows: page,
      lastSeq,
      more: lastSeq < maxSeq && page.length > 0,
    };
  }

  /**
   * Apply one page pulled from a peer (lease holder only). Rows replace by key, so a
   * re-read page is idempotent; the cursor advances only after the page commits. A peer
   * may only write rows under its own machine id; invalid rows are skipped and counted,
   * and the cursor still advances past them.
   */
  applyPeerPage(peerMachineId: string, page: ExportPage): { applied: number; skipped: number; reset: boolean } {
    let applied = 0, skipped = 0, reset = false;
    const tx = this.db.transaction(() => {
      const cur = this.db.prepare('SELECT * FROM pool_peers WHERE machine_id = ?').get(peerMachineId) as PeerCursor | undefined;
      let after = cur?.last_seq ?? 0;
      if (cur && cur.generation_id && cur.generation_id !== page.generationId) {
        // The peer's database was recreated or imported: drop its pooled rows from its
        // snapshot time on (older hour/session detail survives) and re-pull from zero.
        const cut = page.snapshotAt || 0;
        for (const t of ['pool_rollup_hour', 'pool_rollup_day', 'pool_rollup_session_day']) {
          this.db.prepare(`DELETE FROM ${t} WHERE machine = ? AND bucket >= ?${t === 'pool_rollup_day' ? ' AND frozen = 0' : ''}`).run(peerMachineId, cut);
        }
        this.db.prepare('UPDATE pool_peers SET generation_id = ?, last_seq = 0, warming = 1, generation_changes = generation_changes + 1 WHERE machine_id = ?')
          .run(page.generationId, peerMachineId);
        after = 0;
        reset = true;
        return;
      }
      if (!cur) {
        this.db.prepare('INSERT INTO pool_peers (machine_id, generation_id, last_seq, warming) VALUES (?, ?, 0, 1)').run(peerMachineId, page.generationId);
      }
      for (const { table, row } of page.rows) {
        const ok = this.applyPeerRow(peerMachineId, table, row);
        if (ok) applied++; else skipped++;
      }
      const last = Math.max(after, Number.isFinite(page.lastSeq) ? page.lastSeq : after);
      this.db.prepare('UPDATE pool_peers SET last_seq = ?, last_pull_at = ?, warming = ?, invalid_rows = invalid_rows + ? WHERE machine_id = ?')
        .run(last, this.opts.now(), page.more ? 1 : 0, skipped, peerMachineId);
    });
    tx();
    return { applied, skipped, reset };
  }

  private applyPeerRow(peer: string, table: string, row: Record<string, unknown>): boolean {
    const target = POOL_TABLE[table];
    if (!target) return false;
    if (table === 'session_bindings') {
      if (row.machine_id !== peer || typeof row.session_id !== 'string' || row.session_id.length > MAX_STR) return false;
      if (!Number.isInteger(row.valid_from)) return false;
      const cwd = typeof row.cwd === 'string' ? row.cwd.slice(0, MAX_STR) : null;
      const s = (v: unknown) => (typeof v === 'string' ? v.slice(0, MAX_STR) : null);
      this.db.prepare(`INSERT OR REPLACE INTO pool_bindings
        (session_id, framework, session_kind, cwd, topic_id, job_slug, run_id, account_id, machine_id, valid_from, valid_to)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(row.session_id, s(row.framework) ?? 'api', s(row.session_kind) ?? 'interactive', cwd, s(row.topic_id), s(row.job_slug),
          s(row.run_id), s(row.account_id), peer, row.valid_from, Number.isInteger(row.valid_to) ? row.valid_to : null);
      return true;
    }
    const keyCols = table === 'rollup_hour' ? HOUR_KEY : table === 'rollup_day' ? DAY_KEY : SESSION_DAY_KEY;
    if (row.machine !== peer) return false;
    const vals: Record<string, unknown> = {};
    for (const c of keyCols) {
      const v = row[c];
      if (c === 'bucket') { if (!Number.isInteger(v) || (v as number) < 0) return false; vals[c] = v; continue; }
      if (typeof v !== 'string' || v.length > MAX_STR) return false;
      vals[c] = v;
    }
    for (const c of SUM_COLS) {
      const v = row[c];
      if (c.endsWith('usd')) { if (typeof v !== 'number' || !Number.isFinite(v)) return false; }
      else if (!Number.isInteger(v) || (v as number) < 0) return false;
      vals[c] = v;
    }
    vals.change_seq = Number.isInteger(row.change_seq) ? row.change_seq : 0;
    const cols = [...keyCols, ...SUM_COLS, 'change_seq'];
    this.db.prepare(`INSERT OR REPLACE INTO ${target} (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`).run(vals);
    return true;
  }

  /** The holder's view of each peer it has pulled. */
  peerCursors(): Array<{ machineId: string; generationId: string | null; lastSeq: number; lastPullAt: number | null; warming: boolean; invalidRows: number; generationChanges: number }> {
    return (this.db.prepare('SELECT * FROM pool_peers ORDER BY machine_id').all() as PeerCursor[]).map(r => ({
      machineId: r.machine_id, generationId: r.generation_id, lastSeq: r.last_seq, lastPullAt: r.last_pull_at,
      warming: r.warming === 1, invalidRows: r.invalid_rows, generationChanges: r.generation_changes,
    }));
  }

  // Pooled copies persist across lease tenures: a new holder serves them while it re-pulls (spec).

  // ── Slice 4: grouped reads over local + pooled rollups ──────────────

  /**
   * Aggregate rollup rows for buckets in [sinceMs, untilMs) grouped by `groupBy` (always
   * including the day bucket and model, which pricing needs). `includePool` adds peers'
   * pooled rows (holder view); local rows are always included.
   */
  aggregate(grain: 'hour' | 'day' | 'session-day', sinceMs: number, untilMs: number, groupBy: readonly AggregateDim[], filter: Partial<Record<AggregateDim, string>> = {}, includePool = true): AggregateRow[] {
    const local = grain === 'hour' ? 'rollup_hour' : grain === 'day' ? 'rollup_day' : 'rollup_session_day';
    const tables = includePool ? [local, `pool_${local}`] : [local];
    const allowed = grain === 'session-day' ? SESSION_DAY_KEY : grain === 'hour' ? HOUR_KEY : DAY_KEY;
    const dims = [...new Set(['bucket', 'model', ...groupBy])].filter(d => (allowed as readonly string[]).includes(d));
    const where: string[] = ['bucket >= @since', 'bucket < @until'];
    const params: Record<string, unknown> = { since: sinceMs, until: untilMs };
    for (const [k, v] of Object.entries(filter)) {
      if (v === undefined || !(allowed as readonly string[]).includes(k)) continue;
      where.push(`${k} = @f_${k}`);
      params[`f_${k}`] = v ?? NONE;
    }
    const union = tables.map(t => `SELECT ${[...allowed, ...SUM_COLS].join(', ')} FROM ${t} WHERE ${where.join(' AND ')}`).join(' UNION ALL ');
    const sql = `SELECT ${dims.join(', ')}, ${SUM_COLS.map(c => `SUM(${c}) AS ${c}`).join(', ')} FROM (${union}) GROUP BY ${dims.join(', ')}`;
    return (this.db.prepare(sql).all(params) as Record<string, any>[]).map(r => {
      const out: AggregateRow = {
        bucket: r.bucket, model: r.model || null,
        dims: Object.fromEntries(dims.filter(d => d !== 'bucket').map(d => [d, r[d] === NONE ? null : r[d]])) as Record<string, string | null>,
        calls: r.calls, input: r.tok_input, cacheRead: r.tok_cache_read, cacheWrite: r.tok_cache_write, output: r.tok_output,
        reasoning: r.tok_reasoning, missingAny: r.miss_input + r.miss_output, reportedActualUsd: r.reported_actual_usd,
        reportedPlanRateUsd: r.reported_plan_rate_usd,
      };
      return out;
    });
  }

  /** Raw request rows for one session on THIS machine, capped (spec: 500). */
  sessionEvents(sessionId: string, limit = 500): Record<string, unknown>[] {
    return this.db.prepare(`SELECT ts, source, framework, model, session_kind, topic_id, job_slug, run_id, feature, grain, status,
      tok_input, tok_cache_read, tok_cache_write, tok_output, tok_reasoning, reported_usd, reported_basis
      FROM usage_events WHERE session_id = ? ORDER BY ts DESC LIMIT ?`).all(sessionId, Math.min(500, Math.max(1, limit))) as Record<string, unknown>[];
  }

  /** Which machine holds a session's raw rows: this one, a peer (from pooled bindings), or unknown. */
  sessionOwner(sessionId: string): string | null {
    if (this.db.prepare('SELECT 1 FROM usage_events WHERE session_id = ? LIMIT 1').get(sessionId)) return this.opts.machineId;
    const b = this.db.prepare('SELECT machine_id FROM pool_bindings WHERE session_id = ? ORDER BY valid_from DESC LIMIT 1').get(sessionId) as { machine_id: string } | undefined;
    return b?.machine_id ?? null;
  }

  get machineId(): string { return this.opts.machineId; }

  // ── Slice 4: backed-up snapshot ─────────────────────────────────────

  /**
   * Write the slim snapshot (day rollups, bindings, checkpoints, open pairs, identity)
   * to `snapshotPath`, atomically. Never written while the live database is empty, so an
   * empty restart can never overwrite a good snapshot.
   */
  writeSnapshot(snapshotPath: string): { written: boolean; bytes: number; ms: number } {
    const t0 = Date.now();
    const empty = !(this.db.prepare('SELECT 1 FROM rollup_day LIMIT 1').get() || this.db.prepare('SELECT 1 FROM checkpoints LIMIT 1').get());
    if (empty) return { written: false, bytes: 0, ms: 0 };
    const tmp = `${snapshotPath}.tmp-${process.pid}`;
    try { SafeFsExecutor.safeRmSync(tmp, { force: true, operation: 'UsageLedger.writeSnapshot:stale-temp' }); } catch { /* @silent-fallback-ok: a stale temp file is overwritten below */ }
    fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
    const snap = new Database(tmp);
    try {
      snap.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
      for (const ddl of SCHEMA) {
        if (/CREATE TABLE IF NOT EXISTS (rollup_day|session_bindings|checkpoints|pairs) /.test(ddl)) snap.exec(ddl);
      }
      snap.exec('ALTER TABLE checkpoints ADD COLUMN extra TEXT');
      const copy = (table: string, where = ''): void => {
        const rows = this.db.prepare(`SELECT * FROM ${table} ${where}`).all() as Record<string, unknown>[];
        if (!rows.length) return;
        const cols = Object.keys(rows[0]);
        const ins = snap.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`);
        snap.transaction(() => { for (const r of rows) ins.run(r); })();
      };
      copy('rollup_day');
      copy('session_bindings');
      copy('checkpoints');
      copy('pairs', `WHERE state != 'settled'`);
      const m = snap.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      m.run('agent_id', this.opts.agentId);
      m.run('machine_id', this.opts.machineId);
      m.run('generation_id', this.generationId);
      m.run('snapshot_at', String(this.opts.now()));
    } finally { snap.close(); }
    fs.renameSync(tmp, snapshotPath);
    const bytes = fs.statSync(snapshotPath).size;
    const ms = Date.now() - t0;
    this.metaSet('snapshot_bytes', String(bytes));
    this.metaSet('snapshot_ms', String(ms));
    this.metaSet('snapshot_written_at', String(this.opts.now()));
    return { written: true, bytes, ms };
  }

  /**
   * At open, before ingest: import the snapshot only when the live database is empty
   * (spec: Restore rule). Same or predecessor machine → re-keyed import; a replaced
   * machine that is not a live pool member and has no pooled rows anywhere → frozen
   * local slice of its day rollups; anything else, or another agent's snapshot → refused.
   */
  importSnapshotIfEmpty(snapshotPath: string, rules: SnapshotRules = {}): SnapshotImport {
    if (!fs.existsSync(snapshotPath)) return { outcome: 'none' };
    const liveHasData = !!(this.db.prepare('SELECT 1 FROM rollup_day LIMIT 1').get() || this.db.prepare('SELECT 1 FROM checkpoints LIMIT 1').get());
    if (liveHasData) { this.recordImport('ignored-live-authoritative'); return { outcome: 'ignored-live-authoritative' }; }
    let snap: BetterSqliteDatabase;
    try { snap = new Database(snapshotPath, { readonly: true }); } catch (err) {
      this.recordImport('unreadable');
      return { outcome: 'unreadable', detail: err instanceof Error ? err.message : String(err) };
    }
    try {
      const meta = Object.fromEntries((snap.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
      if (meta.agent_id !== this.opts.agentId) { this.recordImport('refused-other-agent'); return { outcome: 'refused-other-agent' }; }
      const from = meta.machine_id;
      const snapAt = Number(meta.snapshot_at ?? '0');
      const same = from === this.opts.machineId || (rules.isPredecessor?.(from) ?? false);
      if (!same) {
        if ((rules.isLivePoolMember?.(from) ?? false) || (rules.poolHasRowsFor?.(from) ?? false)) {
          this.recordImport('refused-live-member'); return { outcome: 'refused-live-member', fromMachine: from };
        }
      }
      const tx = this.db.transaction(() => {
        const days = snap.prepare('SELECT * FROM rollup_day').all() as Record<string, unknown>[];
        if (same) {
          const cols = [...DAY_KEY, ...SUM_COLS, 'change_seq'];
          const ins = this.db.prepare(`INSERT OR REPLACE INTO rollup_day (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`);
          const seq = this.nextSeq();
          for (const r of days) ins.run({ ...r, machine: this.opts.machineId, change_seq: seq });
          const bcols = ['session_id', 'framework', 'session_kind', 'cwd', 'topic_id', 'job_slug', 'run_id', 'account_id', 'machine_id', 'valid_from', 'valid_to', 'change_seq'];
          const bins = this.db.prepare(`INSERT OR REPLACE INTO session_bindings (${bcols.join(', ')}) VALUES (${bcols.map(c => '@' + c).join(', ')})`);
          for (const r of snap.prepare('SELECT * FROM session_bindings').all() as Record<string, unknown>[]) {
            bins.run({ ...r, machine_id: r.machine_id === from ? this.opts.machineId : r.machine_id, change_seq: this.nextSeq() });
          }
          const ccols = ['path', 'root', 'inode', 'head_hash', 'birth_ms', 'offset', 'updated_at', 'extra'];
          const cins = this.db.prepare(`INSERT OR REPLACE INTO checkpoints (${ccols.join(', ')}) VALUES (${ccols.map(c => '@' + c).join(', ')})`);
          for (const r of snap.prepare('SELECT * FROM checkpoints').all() as Record<string, unknown>[]) cins.run({ extra: null, ...r });
          const pcols = ['correlation_key', 'inv_observation_id', 'inv_row', 'inv_start', 'inv_end', 'held', 'file_path', 'last_file_at', 'counted_side', 'state', 'disputed', 'invocations', 'updated_at'];
          const pins = this.db.prepare(`INSERT OR REPLACE INTO pairs (${pcols.join(', ')}) VALUES (${pcols.map(c => '@' + c).join(', ')})`);
          for (const r of snap.prepare('SELECT * FROM pairs').all() as Record<string, unknown>[]) pins.run(r);
          if (from !== this.opts.machineId) this.metaSet('snapshot_previous_machine_id', from);
        } else {
          const cols = [...DAY_KEY, ...SUM_COLS, 'change_seq', 'frozen'];
          const ins = this.db.prepare(`INSERT OR REPLACE INTO pool_rollup_day (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')})`);
          for (const r of days) ins.run({ ...r, machine: from, change_seq: 0, frozen: 1 });
        }
        this.metaSet('snapshot_imported_at', String(snapAt));
      });
      tx();
      const outcome = same ? 'imported' : 'imported-frozen';
      this.recordImport(outcome, from, snapAt);
      if (same) this.pendingDetailRescan = true;
      return { outcome, fromMachine: from, snapshotAt: snapAt };
    } finally { snap.close(); }
  }

  /** After a same-machine import, re-read checkpointed Claude files once for detail rows (never counted). */
  private pendingDetailRescan = false;

  private recordImport(outcome: string, from?: string, at?: number): void {
    this.metaSet('snapshot_import', JSON.stringify({ outcome, fromMachine: from ?? null, snapshotAt: at ?? null, decidedAt: this.opts.now() }));
  }

  snapshotStatus(): Record<string, unknown> {
    const imp = this.metaGet('snapshot_import');
    return {
      bytes: Number(this.metaGet('snapshot_bytes') ?? '0'),
      copyMs: Number(this.metaGet('snapshot_ms') ?? '0'),
      writtenAt: Number(this.metaGet('snapshot_written_at') ?? '0') || null,
      oversized: Number(this.metaGet('snapshot_bytes') ?? '0') > 500 * 1024 * 1024,
      lastImport: imp ? JSON.parse(imp) : null,
    };
  }

  /** Shares behind the coverage strip, over day rollups since `sinceMs` (local + pooled). */
  coverageShares(sinceMs: number): { unattributedTokens: number; totalTokens: number; nullTokenCalls: number; calls: number } {
    const r = this.db.prepare(`SELECT
        SUM(tok_input + tok_cache_read + tok_cache_write + tok_output) AS total,
        SUM(CASE WHEN topic = '' AND job = '' AND feature = '' THEN tok_input + tok_cache_read + tok_cache_write + tok_output ELSE 0 END) AS unattributed,
        SUM(miss_input) AS nullcalls, SUM(calls) AS calls
      FROM (SELECT * FROM rollup_day WHERE bucket >= @s UNION ALL SELECT ${[...DAY_KEY, ...SUM_COLS, 'change_seq'].join(', ')} FROM pool_rollup_day WHERE bucket >= @s)`)
      .get({ s: Math.floor(sinceMs / DAY_MS) * DAY_MS }) as Record<string, number | null>;
    return { unattributedTokens: r.unattributed ?? 0, totalTokens: r.total ?? 0, nullTokenCalls: r.nullcalls ?? 0, calls: r.calls ?? 0 };
  }

  // ── retention ───────────────────────────────────────────────────────

  /**
   * Bounded-batch pruning (spec: Retention and growth): raw rows past 90 days or above
   * the row ceiling (oldest first), hour and session-day rollups past 400 days, closed
   * bindings past 90 days. Day rollups and live checkpoints are kept. Returns rows deleted.
   */
  prune(batchSize = 5_000): number {
    const now = this.opts.now();
    let deleted = 0;
    const tx = this.db.transaction(() => {
      const rawCut = now - this.opts.rawRetentionMs;
      let r = this.db.prepare(`DELETE FROM usage_events WHERE rowid IN (SELECT rowid FROM usage_events WHERE ts < ? AND status != 'held' ORDER BY ts LIMIT ?)`).run(rawCut, batchSize);
      deleted += r.changes;
      const over = this.rawRowCount - r.changes - this.opts.maxRawRows;
      if (over > 0) {
        r = this.db.prepare(`DELETE FROM usage_events WHERE rowid IN (SELECT rowid FROM usage_events WHERE status != 'held' ORDER BY ts LIMIT ?)`).run(Math.min(over, batchSize));
        deleted += r.changes;
      }
      this.metaSet('raw_rows', String(Math.max(0, this.rawRowCount - deleted)));
      const rollCut = now - this.opts.rollupRetentionMs;
      this.db.prepare('DELETE FROM rollup_hour WHERE rowid IN (SELECT rowid FROM rollup_hour WHERE bucket < ? LIMIT ?)').run(rollCut, batchSize);
      this.db.prepare('DELETE FROM rollup_session_day WHERE rowid IN (SELECT rowid FROM rollup_session_day WHERE bucket < ? LIMIT ?)').run(rollCut, batchSize);
      this.db.prepare('DELETE FROM session_bindings WHERE rowid IN (SELECT rowid FROM session_bindings WHERE valid_to IS NOT NULL AND valid_to < ? LIMIT ?)').run(rawCut, batchSize);
    });
    tx();
    try { this.db.pragma('incremental_vacuum'); } catch { /* @silent-fallback-ok: disk reclaim is best-effort; rows are already pruned. */ }
    return deleted;
  }

  /** Drop checkpoints whose file no longer exists (the only way a checkpoint is dropped). */
  dropMissingCheckpoints(): number {
    const rows = this.db.prepare('SELECT path FROM checkpoints').all() as { path: string }[];
    const del = this.db.prepare('DELETE FROM checkpoints WHERE path = ?');
    let n = 0;
    for (const { path: p } of rows) if (!fs.existsSync(p)) { del.run(p); n++; }
    return n;
  }

  // ── reads ───────────────────────────────────────────────────────────

  /** Totals from the day rollups for buckets at or after `sinceMs` (day-aligned). */
  totals(sinceMs: number): UsageTotals {
    const r = this.db.prepare(`SELECT ${SUM_COLS.map(c => `COALESCE(SUM(${c}), 0) AS ${c}`).join(', ')}
      FROM rollup_day WHERE bucket >= ?`).get(Math.floor(sinceMs / DAY_MS) * DAY_MS) as Record<string, number>;
    return {
      calls: r.calls, input: r.tok_input, cacheRead: r.tok_cache_read, cacheWrite: r.tok_cache_write,
      output: r.tok_output, reasoning: r.tok_reasoning,
      missing: { input: r.miss_input, cacheRead: r.miss_cache_read, cacheWrite: r.miss_cache_write, output: r.miss_output, reasoning: r.miss_reasoning },
      reportedActualUsd: r.reported_actual_usd, reportedPlanRateUsd: r.reported_plan_rate_usd,
    };
  }

  /** Recompute day totals straight from counted raw rows (the rollup consistency check). */
  totalsFromEvents(sinceMs: number): Pick<UsageTotals, 'calls' | 'input' | 'cacheRead' | 'cacheWrite' | 'output'> {
    const since = Math.floor(sinceMs / DAY_MS) * DAY_MS;
    const r = this.db.prepare(`SELECT COALESCE(SUM(tok_input),0) AS i, COALESCE(SUM(tok_cache_read),0) AS cr,
      COALESCE(SUM(tok_cache_write),0) AS cw, COALESCE(SUM(tok_output),0) AS o
      FROM usage_events WHERE status = 'counted' AND ts >= ?`).get(since) as Record<string, number>;
    // Calls: every invocation (its call stays counted whichever side holds the tokens),
    // plus request rows that are not one side of a dedupe pair.
    const c = this.db.prepare(`SELECT COUNT(*) AS n FROM usage_events e WHERE e.ts >= ? AND (
        (e.grain = 'invocation' AND e.status IN ('counted', 'paired'))
        OR (e.grain != 'invocation' AND e.status = 'counted'
            AND (e.correlation_key IS NULL OR e.correlation_key NOT IN (SELECT correlation_key FROM pairs))))`).get(since) as { n: number };
    return { calls: c.n, input: r.i, cacheRead: r.cr, cacheWrite: r.cw, output: r.o };
  }

  /** Row counts by status and scope basis — the coverage numbers behind the shares. */
  statusCounts(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.db.prepare(`SELECT status, COALESCE(scope_basis, '') AS sb, COUNT(*) AS n FROM usage_events GROUP BY status, sb`).all() as { status: string; sb: string; n: number }[]) {
      out[`${r.status}${r.sb ? ':' + r.sb : ''}`] = r.n;
    }
    return out;
  }

  /** Rollup rows changed after `afterSeq` (the pool pull's source; spec: Slice 4). */
  rollupChangesAfter(afterSeq: number, limit: number): { table: string; row: Record<string, unknown> }[] {
    const out: { table: string; row: Record<string, unknown> }[] = [];
    for (const t of ['rollup_hour', 'rollup_day', 'rollup_session_day', 'session_bindings']) {
      for (const row of this.db.prepare(`SELECT * FROM ${t} WHERE change_seq > ? ORDER BY change_seq LIMIT ?`).all(afterSeq, limit) as Record<string, unknown>[]) {
        out.push({ table: t, row });
      }
    }
    out.sort((a, b) => (a.row.change_seq as number) - (b.row.change_seq as number));
    return out.slice(0, limit);
  }

  rollupRowCount(table: 'rollup_hour' | 'rollup_day' | 'rollup_session_day'): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } catch { /* @silent-fallback-ok: filesystem race: the file is re-examined on the next tick */ /* already closed */ }
  }
}
