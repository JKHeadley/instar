/**
 * Skill Learning Sentinel — the request ledger (spec §3.2, §4).
 *
 * Durable truth is a set of IMMUTABLE per-machine JSONL segments:
 *   `<stateDir>/skill-learning/ledger/<machineId>.<generation>.jsonl`
 * A segment is only ever appended to (fsync'd) by the machine that owns it; a new generation opens at
 * `segmentBytes` (4 MB) and the old one is never rewritten, so another machine's git sync can never
 * conflict with it and a cache never needs a "file shrank" check. Retention prunes WHOLE segments —
 * only this machine's, only when every row in them is older than 3 × windowDays — through
 * SafeFsExecutor. Rows are never rewritten: a later row revises (a classified request row repeats the
 * source; an outcome revision is a separate row ordered by (runId, revision)).
 *
 * The derived read model is a SQLite cache (`<stateDir>/state/skill-learning.db`, WAL) rebuilt from
 * EVERY machine's segments in the directory, incrementally by (segment, byteOffset). A corrupt or
 * schema-stale cache is treated as missing and rebuilt; `start()` runs the rebuild off the boot path.
 *
 *   - request rows dedupe by `source`; a later row for the same source replaces the cached one only
 *     when it advances state (pending → needs-full → classified), so a second machine's observation
 *     can never downgrade a verdict;
 *   - outcome rows keyed by (runId, revision); two rows for one key reduce by OUTCOME_PRECEDENCE and
 *     the kept row is marked `conflict`;
 *   - the cache keeps ≤ 200 request rows per procedure key (prune-in-cache; the segments keep all).
 *
 * Implements `LedgerReader` + `LedgerWriter` from ./types.ts. Message text is never stored here —
 * only `source` (the pointer back to TopicMemory) and the classifier's scrubbed paraphrase.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { registerSqliteHandle } from '../../core/SqliteRegistry.js';
import { newEventId } from './SeamFilter.js';
import {
  OUTCOME_PRECEDENCE,
  SKILL_LEARNING_PATHS,
  type EventRow,
  type LedgerReader,
  type LedgerRow,
  type LedgerWriter,
  type OutcomeLabel,
  type OutcomeRow,
  type RequestRow,
  type RowSource,
  type RowState,
  type VerdictRow,
} from './types.js';

export const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
export const MAX_REQUESTS_PER_KEY = 200;
const SCHEMA_VERSION = '1';
const SEGMENT_RE = /^(.+)\.(\d+)\.jsonl$/;

export interface LedgerOptions {
  stateDir: string;
  machineId: string;
  /** `defaultGate.windowDays`; retention is 3× this. Default 30. */
  windowDays?: number;
  /** Generation roll-over size. Default 4 MB. */
  segmentBytes?: number;
  now?: () => number;
  logger?: (message: string) => void;
}

export interface LedgerStatus {
  machineId: string;
  ledgerDir: string;
  cachePath: string;
  cacheReady: boolean;
  currentGeneration: number;
  segments: number;
  counters: LedgerCounters;
}

export interface LedgerCounters {
  appended: number;
  ingested: number;
  deduped: number;
  outcomeConflicts: number;
  tornLines: number;
  malformedRows: number;
  rebuilds: number;
  prunedSegments: number;
  appendErrors: number;
}

const STATE_RANK: Record<RowState, number> = { pending: 0, 'needs-full': 1, classified: 2 };

export function sourceKey(source: RowSource): string {
  return `${source.channel}:${source.chatId}:${source.messageId}`;
}

export function labelRank(label: OutcomeLabel): number {
  const i = OUTCOME_PRECEDENCE.indexOf(label);
  return i === -1 ? OUTCOME_PRECEDENCE.length : i;
}

/** The §3.6 reducer: of two outcome rows for one (runId, revision), keep the higher-ranked label. */
export function reduceOutcomes(a: OutcomeRow, b: OutcomeRow): OutcomeRow {
  if (a.runId !== b.runId || a.revision !== b.revision) throw new Error('reduceOutcomes: rows are not the same revision');
  if (a.label === b.label && a.eventId === b.eventId) return a;
  const winner = labelRank(a.label) <= labelRank(b.label) ? a : b;
  return { ...winner, conflict: true };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function validRow(v: unknown): v is LedgerRow {
  if (!isObject(v) || typeof v.eventId !== 'string' || typeof v.at !== 'string' || typeof v.machineId !== 'string') return false;
  switch (v.kind) {
    case 'request':
      return isObject(v.source) && typeof v.topicId === 'string' && typeof v.state === 'string' && v.state in STATE_RANK;
    case 'outcome':
      return typeof v.runId === 'string' && typeof v.revision === 'number' && typeof v.procedureKey === 'string'
        && typeof v.label === 'string' && typeof v.windowStart === 'string';
    case 'verdict':
      return typeof v.procedureKey === 'string' && typeof v.by === 'string' && typeof v.verdict === 'string';
    case 'event':
      return typeof v.runId === 'string' && typeof v.procedureKey === 'string' && typeof v.event === 'string';
    default:
      return false;
  }
}

export class Ledger implements LedgerReader, LedgerWriter {
  readonly ledgerDir: string;
  readonly cachePath: string;
  private readonly machineId: string;
  private readonly windowDays: number;
  private readonly segmentBytes: number;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private db: SqliteDatabase | null = null;
  private unregisterSqlite: (() => void) | null = null;
  private currentGeneration = 0;
  private readonly counters: LedgerCounters = {
    appended: 0, ingested: 0, deduped: 0, outcomeConflicts: 0, tornLines: 0, malformedRows: 0, rebuilds: 0, prunedSegments: 0, appendErrors: 0,
  };

  constructor(opts: LedgerOptions) {
    this.machineId = /^[\w.-]{1,96}$/.test(opts.machineId) ? opts.machineId : 'unknown';
    this.ledgerDir = path.join(opts.stateDir, SKILL_LEARNING_PATHS.ledgerDir);
    this.cachePath = path.join(opts.stateDir, SKILL_LEARNING_PATHS.cacheDb);
    this.windowDays = opts.windowDays && opts.windowDays > 0 ? opts.windowDays : 30;
    this.segmentBytes = opts.segmentBytes && opts.segmentBytes > 0 ? opts.segmentBytes : DEFAULT_SEGMENT_BYTES;
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.logger ?? (() => {});
    this.currentGeneration = this.latestOwnGeneration();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  /**
   * Open the cache and bring it up to date. Yields to the event loop between segments so a large
   * first rebuild never blocks boot; callers run it as `void ledger.start()`.
   */
  async start(): Promise<void> {
    this.openCache();
    await this.ingestNew(true);
  }

  /** Synchronous variant for tests and small ledgers. */
  startSync(): void {
    this.openCache();
    this.ingestSync();
  }

  close(): void {
    // Unregister BEFORE closing so a racing closeAllSqlite never double-closes this handle (SqliteRegistry contract).
    try { this.unregisterSqlite?.(); } catch { /* @silent-fallback-ok — unregister is idempotent; nothing to report */ }
    this.unregisterSqlite = null;
    try { this.db?.close(); } catch { /* already closed */ }
    this.db = null;
  }

  get cacheReady(): boolean {
    return this.db !== null;
  }

  status(): LedgerStatus {
    return {
      machineId: this.machineId,
      ledgerDir: this.ledgerDir,
      cachePath: this.cachePath,
      cacheReady: this.db !== null,
      currentGeneration: this.currentGeneration,
      segments: this.listSegments().length,
      counters: { ...this.counters },
    };
  }

  // ─── Segments (durable truth) ────────────────────────────────────────

  private listSegments(): Array<{ file: string; machineId: string; generation: number }> {
    let names: string[] = [];
    try { names = fs.readdirSync(this.ledgerDir); } catch { return []; }
    const out: Array<{ file: string; machineId: string; generation: number }> = [];
    for (const name of names) {
      const m = SEGMENT_RE.exec(name);
      if (!m) continue;
      out.push({ file: path.join(this.ledgerDir, name), machineId: m[1], generation: Number(m[2]) });
    }
    return out.sort((a, b) => a.machineId.localeCompare(b.machineId) || a.generation - b.generation);
  }

  private latestOwnGeneration(): number {
    let gen = 0;
    for (const s of this.listSegments()) if (s.machineId === this.machineId && s.generation > gen) gen = s.generation;
    return gen;
  }

  segmentPath(generation = this.currentGeneration): string {
    return path.join(this.ledgerDir, `${this.machineId}.${generation}.jsonl`);
  }

  /** fsync'd append to this machine's current segment; rolls the generation at `segmentBytes`. */
  append(row: LedgerRow): void {
    if (!validRow(row)) throw new Error(`Ledger.append: invalid ${String((row as { kind?: unknown })?.kind)} row`);
    if (row.machineId !== this.machineId) throw new Error(`Ledger.append: row.machineId '${row.machineId}' is not this machine ('${this.machineId}')`);
    fs.mkdirSync(this.ledgerDir, { recursive: true, mode: 0o700 });
    let file = this.segmentPath();
    try {
      if (fs.statSync(file).size >= this.segmentBytes) {
        this.currentGeneration += 1;
        file = this.segmentPath();
      }
    } catch { /* no segment yet — generation 0 opens now */ }
    const line = JSON.stringify(row) + '\n';
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'a', 0o600);
      fs.writeSync(fd, line);
      fs.fsyncSync(fd);
    } catch (err) {
      this.counters.appendErrors++;
      throw err;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    this.counters.appended++;
    if (this.db) this.ingestSegmentSync(file);
  }

  /**
   * Retention (§3.2): prune whole segments of THIS machine that are not the current generation and
   * whose every row is older than 3 × windowDays. Another machine's shard is never touched.
   */
  prune(nowMs = this.now()): string[] {
    const cutoff = nowMs - 3 * this.windowDays * 86_400_000;
    const pruned: string[] = [];
    for (const seg of this.listSegments()) {
      if (seg.machineId !== this.machineId || seg.generation === this.currentGeneration) continue;
      const newest = this.newestRowAt(seg.file);
      if (newest === null || newest >= cutoff) continue;
      SafeFsExecutor.safeRmSync(seg.file, { force: true, operation: 'src/monitoring/skillLearning/Ledger.ts:prune' });
      this.counters.prunedSegments++;
      pruned.push(seg.file);
      if (this.db) {
        const rel = path.basename(seg.file);
        this.db.prepare('DELETE FROM segments WHERE segment = ?').run(rel);
        for (const t of ['requests', 'outcomes', 'verdicts', 'events']) this.db.prepare(`DELETE FROM ${t} WHERE segment = ?`).run(rel);
      }
    }
    return pruned;
  }

  /** The newest `at` in a segment, ms; null for an empty/unreadable segment (never pruned). */
  private newestRowAt(file: string): number | null {
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf-8'); } catch { return null; }
    let newest: number | null = null;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { at?: unknown };
        const t = typeof r.at === 'string' ? Date.parse(r.at) : NaN;
        if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
      } catch { return null; /* a torn row: keep the segment */ }
    }
    return newest;
  }

  // ─── Cache (derived) ─────────────────────────────────────────────────

  private openCache(): void {
    if (this.db) return;
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true, mode: 0o700 });
    let db: SqliteDatabase | null = null;
    const open = (): SqliteDatabase => {
      const d = new Database(this.cachePath);
      d.pragma('journal_mode = WAL');
      d.pragma('busy_timeout = 5000');
      return d;
    };
    try {
      db = open();
      const integrity = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
      if (integrity[0]?.integrity_check !== 'ok') throw new Error(`integrity_check: ${integrity[0]?.integrity_check}`);
      this.createSchema(db);
      const v = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema') as { value: string } | undefined;
      if (v && v.value !== SCHEMA_VERSION) throw new Error(`schema ${v.value} ≠ ${SCHEMA_VERSION}`);
    } catch (err) {
      // Corrupt ≡ missing: drop and recreate — the segments are the truth.
      this.log(`[SkillLearning/Ledger] cache unusable (${(err as Error).message}) — rebuilding from segments`);
      try { db?.close(); } catch { /* ignore */ }
      for (const suffix of ['', '-wal', '-shm']) {
        try { SafeFsExecutor.safeRmSync(this.cachePath + suffix, { force: true, operation: 'src/monitoring/skillLearning/Ledger.ts:openCache' }); } catch { /* ignore */ }
      }
      db = open();
      this.createSchema(db);
      this.counters.rebuilds++;
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run('schema', SCHEMA_VERSION);
    this.db = db;
    this.unregisterSqlite?.();
    this.unregisterSqlite = registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
  }

  private createSchema(db: SqliteDatabase): void {
    this.createTables(db);
    // A cache built before `retry_after` existed gains the column in place (the cache is derived; a rebuild is the fallback).
    const cols = (db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name);
    if (cols.length > 0 && !cols.includes('retry_after')) db.exec('ALTER TABLE requests ADD COLUMN retry_after TEXT');
  }

  private createTables(db: SqliteDatabase): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS segments (segment TEXT PRIMARY KEY, offset INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (
        event_id TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE, topic_id TEXT NOT NULL, session_name TEXT,
        at TEXT NOT NULL, channel TEXT NOT NULL, identity TEXT NOT NULL, detector_category TEXT, state TEXT NOT NULL,
        procedure_key TEXT, paraphrase TEXT, repeatable INTEGER, run_id TEXT, machine_id TEXT NOT NULL, segment TEXT NOT NULL,
        seq INTEGER NOT NULL, retry_after TEXT
      );
      CREATE INDEX IF NOT EXISTS requests_key ON requests(procedure_key, at);
      CREATE INDEX IF NOT EXISTS requests_state ON requests(state, at);
      CREATE INDEX IF NOT EXISTS requests_topic ON requests(topic_id, at);
      CREATE TABLE IF NOT EXISTS outcomes (
        event_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, revision INTEGER NOT NULL, procedure_key TEXT NOT NULL,
        topic_id TEXT NOT NULL, session_name TEXT, label TEXT NOT NULL, provisional INTEGER NOT NULL, skill_used TEXT,
        misfire INTEGER, window_start TEXT NOT NULL, window_end TEXT, closed_by TEXT, conflict INTEGER, at TEXT NOT NULL,
        machine_id TEXT NOT NULL, segment TEXT NOT NULL, UNIQUE(run_id, revision)
      );
      CREATE INDEX IF NOT EXISTS outcomes_key ON outcomes(procedure_key, at);
      CREATE INDEX IF NOT EXISTS outcomes_closed_by ON outcomes(closed_by);
      CREATE TABLE IF NOT EXISTS verdicts (
        event_id TEXT PRIMARY KEY, procedure_key TEXT NOT NULL, by TEXT NOT NULL, verdict TEXT NOT NULL, reason TEXT,
        expires_at TEXT, at TEXT NOT NULL, machine_id TEXT NOT NULL, segment TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS verdicts_key ON verdicts(procedure_key, at);
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY, event TEXT NOT NULL, run_id TEXT NOT NULL, procedure_key TEXT NOT NULL, skill TEXT,
        reason TEXT, at TEXT NOT NULL, machine_id TEXT NOT NULL, segment TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_key ON events(procedure_key, at);
    `);
  }

  /** Drop the cache and re-ingest every segment from offset 0. */
  async rebuild(): Promise<void> {
    this.close();
    for (const suffix of ['', '-wal', '-shm']) {
      try { SafeFsExecutor.safeRmSync(this.cachePath + suffix, { force: true, operation: 'src/monitoring/skillLearning/Ledger.ts:rebuild' }); } catch { /* ignore */ }
    }
    this.counters.rebuilds++;
    this.openCache();
    await this.ingestNew(true);
  }

  /** Ingest bytes appended since the recorded (segment, offset) across ALL machines' segments. */
  async ingestNew(yieldBetweenSegments = false): Promise<number> {
    if (!this.db) this.openCache();
    let total = 0;
    for (const seg of this.listSegments()) {
      total += this.ingestSegmentSync(seg.file);
      if (yieldBetweenSegments) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return total;
  }

  ingestSync(): number {
    if (!this.db) this.openCache();
    let total = 0;
    for (const seg of this.listSegments()) total += this.ingestSegmentSync(seg.file);
    return total;
  }

  private ingestSegmentSync(file: string): number {
    const db = this.db;
    if (!db) return 0;
    const rel = path.basename(file);
    let size: number;
    try { size = fs.statSync(file).size; } catch { return 0; }
    const row = db.prepare('SELECT offset FROM segments WHERE segment = ?').get(rel) as { offset: number } | undefined;
    let offset = row?.offset ?? 0;
    if (offset > size) {
      // A segment is immutable; a shrink means it was replaced wholesale. Rescan it.
      for (const t of ['requests', 'outcomes', 'verdicts', 'events']) db.prepare(`DELETE FROM ${t} WHERE segment = ?`).run(rel);
      offset = 0;
    }
    if (offset === size) return 0;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size - offset);
    try { fs.readSync(fd, buf, 0, buf.length, offset); } finally { fs.closeSync(fd); }
    const text = buf.toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) { this.counters.tornLines++; return 0; }
    const complete = text.slice(0, lastNl);
    const consumed = Buffer.byteLength(complete, 'utf8') + 1;
    if (lastNl !== text.length - 1) this.counters.tornLines++;
    let count = 0;
    const apply = db.transaction(() => {
      let seq = (db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM requests').get() as { m: number }).m;
      for (const line of complete.split('\n')) {
        if (!line.trim()) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { this.counters.malformedRows++; continue; }
        if (!validRow(parsed)) { this.counters.malformedRows++; continue; }
        seq += 1;
        this.applyRow(db, parsed, rel, seq);
        count += 1;
      }
      db.prepare('INSERT OR REPLACE INTO segments(segment, offset) VALUES (?, ?)').run(rel, offset + consumed);
    });
    apply();
    this.counters.ingested += count;
    return count;
  }

  private applyRow(db: SqliteDatabase, row: LedgerRow, segment: string, seq: number): void {
    switch (row.kind) {
      case 'request': {
        const key = sourceKey(row.source);
        const existing = db.prepare('SELECT event_id, state, retry_after FROM requests WHERE source = ?').get(key) as { event_id: string; state: RowState; retry_after: string | null } | undefined;
        if (existing) {
          if (existing.event_id === row.eventId) return; // the same row seen twice (restart replay)
          if (STATE_RANK[row.state] < STATE_RANK[existing.state]) { this.counters.deduped++; return; }
          // Same rank: only a classified row, or a LATER retry hold on the same row, replaces the cached one.
          const laterHold = typeof row.retryAfter === 'string' && row.retryAfter > (existing.retry_after ?? '');
          if (STATE_RANK[row.state] === STATE_RANK[existing.state] && row.state !== 'classified' && !laterHold) { this.counters.deduped++; return; }
          db.prepare('DELETE FROM requests WHERE source = ?').run(key);
        }
        db.prepare(`INSERT INTO requests(event_id, source, topic_id, session_name, at, channel, identity, detector_category, state,
          procedure_key, paraphrase, repeatable, run_id, machine_id, segment, seq, retry_after) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          row.eventId, key, row.topicId, row.sessionName ?? null, row.at, row.channel, row.identity, row.detectorCategory ?? null,
          row.state, row.procedureKey ?? null, row.paraphrase ?? null, row.repeatable === undefined ? null : (row.repeatable ? 1 : 0),
          row.runId ?? null, row.machineId, segment, seq, row.retryAfter ?? null,
        );
        if (row.procedureKey) this.pruneKey(db, row.procedureKey);
        return;
      }
      case 'outcome': {
        const existing = db.prepare('SELECT * FROM outcomes WHERE run_id = ? AND revision = ?').get(row.runId, row.revision) as Record<string, unknown> | undefined;
        if (existing) {
          const prior = outcomeFromRow(existing);
          if (prior.eventId === row.eventId) return;
          const kept = reduceOutcomes(prior, row);
          this.counters.outcomeConflicts++;
          db.prepare('DELETE FROM outcomes WHERE run_id = ? AND revision = ?').run(row.runId, row.revision);
          this.insertOutcome(db, kept, kept.eventId === row.eventId ? segment : String(existing.segment));
          return;
        }
        this.insertOutcome(db, row, segment);
        return;
      }
      case 'verdict':
        db.prepare(`INSERT OR IGNORE INTO verdicts(event_id, procedure_key, by, verdict, reason, expires_at, at, machine_id, segment)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(row.eventId, row.procedureKey, row.by, row.verdict, row.reason ?? null, row.expiresAt ?? null, row.at, row.machineId, segment);
        return;
      case 'event':
        db.prepare(`INSERT OR IGNORE INTO events(event_id, event, run_id, procedure_key, skill, reason, at, machine_id, segment)
          VALUES (?,?,?,?,?,?,?,?,?)`).run(row.eventId, row.event, row.runId, row.procedureKey, row.skill ?? null, row.reason ?? null, row.at, row.machineId, segment);
        return;
    }
  }

  private insertOutcome(db: SqliteDatabase, row: OutcomeRow, segment: string): void {
    db.prepare(`INSERT INTO outcomes(event_id, run_id, revision, procedure_key, topic_id, session_name, label, provisional, skill_used,
      misfire, window_start, window_end, closed_by, conflict, at, machine_id, segment) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      row.eventId, row.runId, row.revision, row.procedureKey, row.topicId, row.sessionName ?? null, row.label, row.provisional ? 1 : 0,
      row.skillUsed ? JSON.stringify(row.skillUsed) : null, row.misfire === undefined ? null : (row.misfire ? 1 : 0), row.windowStart,
      row.windowEnd ?? null, row.closedBy ? sourceKey(row.closedBy) : null, row.conflict ? 1 : 0, row.at, row.machineId, segment,
    );
  }

  private pruneKey(db: SqliteDatabase, procedureKey: string): void {
    db.prepare(`DELETE FROM requests WHERE procedure_key = ? AND event_id NOT IN (
      SELECT event_id FROM requests WHERE procedure_key = ? ORDER BY at DESC, seq DESC LIMIT ?)`).run(procedureKey, procedureKey, MAX_REQUESTS_PER_KEY);
  }

  // ─── LedgerReader ────────────────────────────────────────────────────

  requestsForKey(procedureKey: string): RequestRow[] {
    if (!this.db) return [];
    return (this.db.prepare('SELECT * FROM requests WHERE procedure_key = ? ORDER BY at DESC, seq DESC LIMIT ?')
      .all(procedureKey, MAX_REQUESTS_PER_KEY) as Record<string, unknown>[]).map(requestFromRow);
  }

  outcomesForKey(procedureKey: string): OutcomeRow[] {
    if (!this.db) return [];
    const rows = (this.db.prepare('SELECT * FROM outcomes WHERE procedure_key = ? ORDER BY run_id, revision DESC')
      .all(procedureKey) as Record<string, unknown>[]).map(outcomeFromRow);
    const latest = new Map<string, OutcomeRow>();
    for (const r of rows) if (!latest.has(r.runId)) latest.set(r.runId, r);
    return [...latest.values()].sort((a, b) => b.windowStart.localeCompare(a.windowStart));
  }

  verdictsForKey(procedureKey: string): VerdictRow[] {
    if (!this.db) return [];
    const nowIso = new Date(this.now()).toISOString();
    const rows = (this.db.prepare('SELECT * FROM verdicts WHERE procedure_key = ? ORDER BY at DESC').all(procedureKey) as Record<string, unknown>[]).map(verdictFromRow);
    const latestBy = new Map<string, VerdictRow>();
    for (const v of rows) {
      if (v.expiresAt && v.expiresAt <= nowIso) continue;
      if (!latestBy.has(v.by)) latestBy.set(v.by, v);
    }
    return [...latestBy.values()];
  }

  keys(): Array<{ procedureKey: string; requests: number; verifiedRequests: number; lastAt: string }> {
    if (!this.db) return [];
    return this.db.prepare(`SELECT procedure_key AS procedureKey, COUNT(*) AS requests,
      SUM(CASE WHEN identity = 'verified' THEN 1 ELSE 0 END) AS verifiedRequests, MAX(at) AS lastAt
      FROM requests WHERE state = 'classified' AND procedure_key IS NOT NULL AND procedure_key <> '' GROUP BY procedure_key ORDER BY lastAt DESC`)
      .all() as Array<{ procedureKey: string; requests: number; verifiedRequests: number; lastAt: string }>;
  }

  pendingCount(): number {
    if (!this.db) return 0;
    return (this.db.prepare("SELECT COUNT(*) AS n FROM requests WHERE state IN ('pending', 'needs-full')").get() as { n: number }).n;
  }

  eventsForKey(procedureKey: string): EventRow[] {
    if (!this.db) return [];
    return (this.db.prepare('SELECT * FROM events WHERE procedure_key = ? ORDER BY at DESC').all(procedureKey) as Record<string, unknown>[]).map(eventFromRow);
  }

  // ─── Extra reads the classifier / outcomes need (not part of the shared reader contract) ──

  /** Pending rows oldest-first; `needs-full` rows are returned ahead so they run alone. A row held by `retryAfter` in the future is skipped. */
  pendingRows(limit: number, nowMs = this.now()): RequestRow[] {
    if (!this.db) return [];
    return (this.db.prepare(`SELECT * FROM requests WHERE state IN ('pending', 'needs-full') AND (retry_after IS NULL OR retry_after <= ?)
      ORDER BY CASE state WHEN 'needs-full' THEN 0 ELSE 1 END, at ASC, seq ASC LIMIT ?`).all(new Date(nowMs).toISOString(), Math.max(1, limit)) as Record<string, unknown>[]).map(requestFromRow);
  }

  requestBySource(source: RowSource): RequestRow | null {
    if (!this.db) return null;
    const r = this.db.prepare('SELECT * FROM requests WHERE source = ?').get(sourceKey(source)) as Record<string, unknown> | undefined;
    return r ? requestFromRow(r) : null;
  }

  requestByRunId(runId: string): RequestRow | null {
    if (!this.db) return null;
    const r = this.db.prepare('SELECT * FROM requests WHERE run_id = ? ORDER BY seq DESC LIMIT 1').get(runId) as Record<string, unknown> | undefined;
    return r ? requestFromRow(r) : null;
  }

  /** Keys seen on a topic (classified rows), most recent first — the classifier's fold-by-meaning list. */
  keysForTopic(topicId: string, limit = 40): string[] {
    if (!this.db) return [];
    return (this.db.prepare(`SELECT procedure_key AS k, MAX(at) AS lastAt FROM requests WHERE topic_id = ? AND state = 'classified'
      AND procedure_key IS NOT NULL AND procedure_key <> '' GROUP BY procedure_key ORDER BY lastAt DESC LIMIT ?`).all(topicId, limit) as Array<{ k: string }>).map((r) => r.k);
  }

  /** Request rows with a runId that have no outcome row yet (open runs), oldest first. */
  openRuns(): RequestRow[] {
    if (!this.db) return [];
    return (this.db.prepare(`SELECT r.* FROM requests r WHERE r.run_id IS NOT NULL AND r.identity <> 'unverified-catchup'
      AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.run_id = r.run_id) ORDER BY r.at ASC, r.seq ASC`).all() as Record<string, unknown>[]).map(requestFromRow);
  }

  /** Latest revision for a run, if any. */
  latestOutcome(runId: string): OutcomeRow | null {
    if (!this.db) return null;
    const r = this.db.prepare('SELECT * FROM outcomes WHERE run_id = ? ORDER BY revision DESC LIMIT 1').get(runId) as Record<string, unknown> | undefined;
    return r ? outcomeFromRow(r) : null;
  }

  /** The run whose window a given operator message closed. */
  outcomeClosedBy(source: RowSource): OutcomeRow | null {
    if (!this.db) return null;
    const r = this.db.prepare('SELECT * FROM outcomes WHERE closed_by = ? ORDER BY revision DESC LIMIT 1').get(sourceKey(source)) as Record<string, unknown> | undefined;
    return r ? outcomeFromRow(r) : null;
  }

  /** Latest-revision outcomes still provisional, oldest window first. */
  provisionalOutcomes(): OutcomeRow[] {
    if (!this.db) return [];
    const rows = (this.db.prepare('SELECT * FROM outcomes ORDER BY run_id, revision DESC').all() as Record<string, unknown>[]).map(outcomeFromRow);
    const latest = new Map<string, OutcomeRow>();
    for (const r of rows) if (!latest.has(r.runId)) latest.set(r.runId, r);
    return [...latest.values()].filter((r) => r.provisional).sort((a, b) => a.windowStart.localeCompare(b.windowStart));
  }

  /** All latest-revision outcomes (every key). */
  allOutcomes(): OutcomeRow[] {
    if (!this.db) return [];
    const rows = (this.db.prepare('SELECT * FROM outcomes ORDER BY run_id, revision DESC').all() as Record<string, unknown>[]).map(outcomeFromRow);
    const latest = new Map<string, OutcomeRow>();
    for (const r of rows) if (!latest.has(r.runId)) latest.set(r.runId, r);
    return [...latest.values()];
  }
}

function requestFromRow(r: Record<string, unknown>): RequestRow {
  const [channel, chatId, ...rest] = String(r.source).split(':');
  const row: RequestRow = {
    kind: 'request',
    eventId: String(r.event_id),
    source: { channel: channel as RowSource['channel'], chatId, messageId: rest.join(':') },
    topicId: String(r.topic_id),
    at: String(r.at),
    channel: String(r.channel) as RequestRow['channel'],
    identity: String(r.identity) as RequestRow['identity'],
    state: String(r.state) as RowState,
    machineId: String(r.machine_id),
  };
  if (r.session_name != null) row.sessionName = String(r.session_name);
  if (r.detector_category != null) row.detectorCategory = String(r.detector_category);
  if (r.procedure_key != null) row.procedureKey = String(r.procedure_key);
  if (r.paraphrase != null) row.paraphrase = String(r.paraphrase);
  if (r.repeatable != null) row.repeatable = Number(r.repeatable) === 1;
  if (r.run_id != null) row.runId = String(r.run_id);
  if (r.retry_after != null) row.retryAfter = String(r.retry_after);
  return row;
}

function outcomeFromRow(r: Record<string, unknown>): OutcomeRow {
  const row: OutcomeRow = {
    kind: 'outcome',
    eventId: String(r.event_id),
    runId: String(r.run_id),
    revision: Number(r.revision),
    procedureKey: String(r.procedure_key),
    topicId: String(r.topic_id),
    label: String(r.label) as OutcomeLabel,
    provisional: Number(r.provisional) === 1,
    windowStart: String(r.window_start),
    at: String(r.at),
    machineId: String(r.machine_id),
  };
  if (r.session_name != null) row.sessionName = String(r.session_name);
  if (r.skill_used != null) { try { row.skillUsed = JSON.parse(String(r.skill_used)); } catch { /* unreadable join: absent */ } }
  if (r.misfire != null) row.misfire = Number(r.misfire) === 1;
  if (r.window_end != null) row.windowEnd = String(r.window_end);
  if (r.closed_by != null) {
    const [channel, chatId, ...rest] = String(r.closed_by).split(':');
    row.closedBy = { channel: channel as RowSource['channel'], chatId, messageId: rest.join(':') };
  }
  if (Number(r.conflict) === 1) row.conflict = true;
  return row;
}

function verdictFromRow(r: Record<string, unknown>): VerdictRow {
  const row: VerdictRow = {
    kind: 'verdict',
    eventId: String(r.event_id),
    procedureKey: String(r.procedure_key),
    by: String(r.by) as VerdictRow['by'],
    verdict: String(r.verdict) as VerdictRow['verdict'],
    at: String(r.at),
    machineId: String(r.machine_id),
  };
  if (r.reason != null) row.reason = String(r.reason);
  if (r.expires_at != null) row.expiresAt = String(r.expires_at);
  return row;
}

function eventFromRow(r: Record<string, unknown>): EventRow {
  const row: EventRow = {
    kind: 'event',
    eventId: String(r.event_id),
    event: String(r.event) as EventRow['event'],
    runId: String(r.run_id),
    procedureKey: String(r.procedure_key),
    at: String(r.at),
    machineId: String(r.machine_id),
  };
  if (r.skill != null) row.skill = String(r.skill);
  if (r.reason != null) row.reason = String(r.reason);
  return row;
}
