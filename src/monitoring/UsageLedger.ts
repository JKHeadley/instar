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

export type UsageSource =
  | 'claude-transcript' | 'codex-rollout' | 'intelligence-call'
  | 'pi-session' | 'grok-session' | 'gemini-session';
export type UsageFramework = 'claude-code' | 'codex-cli' | 'pi-cli' | 'grok-build' | 'gemini-cli' | 'api';
export type SessionKind = 'interactive' | 'job' | 'internal' | 'subagent';
export type ScopeBasis = 'spawn-record' | 'cwd';
/** counted: contributes to totals. held: dedupe pair, other side counted. copied-history: predates its file, unresolved. replay: re-read before a checkpoint, detail only. */
export type RowStatus = 'counted' | 'held' | 'copied-history' | 'replay';

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
      r.reportedBasis === 'actual' ? r.reportedUsd ?? 0 : 0,
      r.reportedBasis === 'plan-rate' ? r.reportedUsd ?? 0 : 0,
      1,
    ].map(v => v * sign);
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
    registerSqliteHandle(() => { try { this.db.close(); } catch { /* already closed */ } });
    for (const ddl of SCHEMA) this.db.exec(ddl);
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
    try { entries = fs.readdirSync(dirPath); } catch { return false; }
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
    try { dirs = fs.readdirSync(projects, { withFileTypes: true }); } catch { return out; }
    const cutoff = this.opts.now() - this.opts.maxFileAgeMs;
    let skippedDirs = 0, outOfWindow = 0, tooDeep = 0;
    const walk = (dir: string, depth: number): void => {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (depth + 1 > this.opts.maxDepth) { tooDeep++; continue; }
          walk(p, depth + 1);
        } else if (e.isFile() && e.name.endsWith('.jsonl')) {
          try { if (fs.statSync(p).mtimeMs < cutoff) { outOfWindow++; continue; } } catch { continue; }
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
    if (this.roots.length === 0) return report;
    const queues = this.roots.map(r => ({ r, files: this.listRootFiles(r.root).filter(f => this.fileChanged(f)) }));
    let budget = this.opts.filesPerTick;
    let progressed = true;
    while (budget > 0 && progressed) {
      progressed = false;
      for (let i = 0; i < queues.length && budget > 0; i++) {
        const q = queues[(this.rootCursor + i) % queues.length];
        const f = q.files.shift();
        if (!f) continue;
        const r = this.ingestClaudeFile(q.r.root, f);
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
    return report;
  }

  private fileChanged(file: string): boolean {
    const cp = this.db.prepare('SELECT inode, offset FROM checkpoints WHERE path = ?').get(file) as { inode: number; offset: number } | undefined;
    if (!cp) return true;
    try {
      const st = fs.statSync(file);
      return st.ino !== cp.inode || st.size !== cp.offset;
    } catch { return false; }
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
    } catch { return { inserted: 0, counted: 0 }; }
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
    let inserted = 0, counted = 0;
    const newOffset = startAt + lastNl + 1;

    const tx = this.db.transaction(() => {
      let pos = startAt;
      for (const line of text.split('\n')) {
        const linePos = pos;
        pos += Buffer.byteLength(line, 'utf8') + 1;
        if (!line.trim()) continue;
        let obj: Record<string, any>;
        try { obj = JSON.parse(line); } catch { continue; }
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
        counted++;
        batch.add({
          ts, machine: this.opts.machineId, framework: 'claude-code', model, sessionKind,
          topic: binding?.topicId ?? null, job: binding?.jobSlug ?? null, run: binding?.runId ?? null, feature: null,
          sessionId, parts, reportedUsd: null, reportedBasis: null,
        }, 1);
      }
      this.applyBatch(batch);
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
    const r = this.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(tok_input),0) AS i, COALESCE(SUM(tok_cache_read),0) AS cr,
      COALESCE(SUM(tok_cache_write),0) AS cw, COALESCE(SUM(tok_output),0) AS o
      FROM usage_events WHERE status = 'counted' AND ts >= ?`).get(Math.floor(sinceMs / DAY_MS) * DAY_MS) as Record<string, number>;
    return { calls: r.calls, input: r.i, cacheRead: r.cr, cacheWrite: r.cw, output: r.o };
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
    try { this.db.close(); } catch { /* already closed */ }
  }
}
