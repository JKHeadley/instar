/**
 * ResourceLedger — per-agent resource-usage observability (Phase A: rate-limit events).
 *
 * Durable, read-only. Mirrors TokenLedger / FeatureMetricsLedger: SQLite opened
 * through NativeModuleHealer, WAL, registered for close-on-exit via
 * SqliteRegistry, schema applied idempotently. Like FeatureMetricsLedger, every
 * write swallows its error so observability can NEVER break the path it
 * observes. It never gates, throttles, or mutates any runtime flow.
 *
 * Phase A persists the one resource signal that is ephemeral today: rate-limit
 * events. LlmCircuitBreaker counts trips in process-local memory (lost on
 * restart) and RateLimitSentinel emits transient events — so "how many times was
 * the account throttled today" is currently unanswerable. This store makes it
 * durable. Each event is written event-driven by ResourceLedgerPoller (from the
 * breaker's trip/recover emitter and the sentinel's events), one row per
 * emission, with a real per-event identity (not a content hash) so legitimate
 * same-millisecond events don't collapse and a restart can't replay-double-count.
 *
 * CPU/memory sampling (resource_samples) + retention is Phase B; the table and
 * its methods are not in this file yet.
 *
 * Spec: docs/specs/per-agent-resource-ledger.md.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';

/** Canonical event kinds. `circuit-open`/`circuit-recover` come from the breaker
 *  (the primary, account-level signal); the throttle/quota/529 kinds come from
 *  RateLimitSentinel (session-scoped, secondary — tagged `source`). */
export type RateLimitEventKind =
  | 'circuit-open'
  | 'circuit-recover'
  | 'throttle'
  | 'quota'
  | '529';

export type RateLimitEventSource = 'circuit-breaker' | 'session-sentinel';

export interface RateLimitEventInput {
  ts: number;
  kind: RateLimitEventKind;
  source: RateLimitEventSource;
  /** Stable per-event sequence within this process — together with ts+source it
   *  forms the row id, so same-ms events are distinct and restarts don't replay. */
  seq: number;
  accountKey?: string;
  sessionName?: string;
  reason?: string;
  detail?: string;
}

export interface RateLimitSummaryRow {
  /** Headline: breaker trips (the account-level signal). */
  circuitOpenCount: number;
  circuitRecoverCount: number;
  /** Session-sentinel detections, reported separately (different semantics). */
  sentinelCount: number;
  totalEvents: number;
  /** Breaker trips per hour over the window — the "rate" asked for. */
  tripsPerHour: number;
  oldestEventTs: number | null;
  newestEventTs: number | null;
  windowMs: number;
}

export interface RateLimitKindRow {
  kind: RateLimitEventKind;
  source: RateLimitEventSource;
  count: number;
  firstTs: number;
  lastTs: number;
}

export interface RateLimitEventRow {
  id: string;
  ts: number;
  kind: RateLimitEventKind;
  source: RateLimitEventSource;
  accountKey: string;
  sessionName: string | null;
  reason: string | null;
  detail: string | null;
}

export interface ResourceLedgerOptions {
  /** SQLite db path, or ':memory:' for tests. */
  dbPath: string;
  /** Test seam — inject a Database instance. */
  databaseFactory?: (dbPath: string) => BetterSqliteDatabase;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS rate_limit_events (
     id           TEXT PRIMARY KEY,
     ts           INTEGER NOT NULL,
     kind         TEXT NOT NULL,
     source       TEXT NOT NULL,
     account_key  TEXT NOT NULL DEFAULT 'default',
     session_name TEXT,
     reason       TEXT,
     detail       TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_rle_ts ON rate_limit_events (ts)`,
  `CREATE INDEX IF NOT EXISTS idx_rle_kind_ts ON rate_limit_events (kind, ts)`,
  `CREATE INDEX IF NOT EXISTS idx_rle_source_ts ON rate_limit_events (source, ts)`,
];

export class ResourceLedger {
  private db: BetterSqliteDatabase;
  private insertEvent!: ReturnType<BetterSqliteDatabase['prepare']>;
  private closed = false;

  constructor(opts: ResourceLedgerOptions) {
    if (opts.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    }
    // Open through the native-module healer — identical ABI-resilience to
    // TokenLedger/FeatureMetricsLedger, so a Node upgrade can't brick /resources.
    this.db = NativeModuleHealer.openWithHealSync(
      'ResourceLedger',
      () => opts.databaseFactory?.(opts.dbPath) ?? new Database(opts.dbPath),
    );
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    for (const ddl of SCHEMA) {
      try {
        this.db.exec(ddl);
      } catch (err) {
        const msg = (err as Error).message || '';
        if (!/duplicate column name/i.test(msg)) throw err;
      }
    }
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
    this.insertEvent = this.db.prepare(
      `INSERT OR IGNORE INTO rate_limit_events
         (id, ts, kind, source, account_key, session_name, reason, detail)
       VALUES (@id, @ts, @kind, @source, @accountKey, @sessionName, @reason, @detail)`,
    );
  }

  /** Per-event identity: ts + source + seq is unique within a process; the source
   *  prefix keeps breaker and sentinel rows from ever colliding. NOT a content
   *  hash, so two genuine same-ms events stay distinct. */
  private static eventId(e: RateLimitEventInput): string {
    return `${e.source}:${e.ts}:${e.seq}`;
  }

  /** Record one rate-limit event. Idempotent on (source,ts,seq). Never throws —
   *  observability must not break the observed path. */
  recordRateLimitEvent(e: RateLimitEventInput): void {
    if (this.closed) return;
    try {
      this.insertEvent.run({
        id: ResourceLedger.eventId(e),
        ts: e.ts,
        kind: e.kind,
        source: e.source,
        accountKey: e.accountKey && e.accountKey.trim() ? e.accountKey.trim() : 'default',
        sessionName: e.sessionName ?? null,
        reason: e.reason ?? null,
        detail: e.detail ?? null,
      });
    } catch {
      /* swallow — never break the observed path (Close the Loop applied to self) */
    }
  }

  /** Count + rate of rate-limit events over the trailing window. */
  rateLimitSummary(nowMs: number, windowMs: number): RateLimitSummaryRow {
    const since = nowMs - windowMs;
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN kind='circuit-open'    THEN 1 ELSE 0 END) AS circuitOpenCount,
           SUM(CASE WHEN kind='circuit-recover' THEN 1 ELSE 0 END) AS circuitRecoverCount,
           SUM(CASE WHEN source='session-sentinel' THEN 1 ELSE 0 END) AS sentinelCount,
           COUNT(*) AS totalEvents,
           MIN(ts)  AS oldestEventTs,
           MAX(ts)  AS newestEventTs
         FROM rate_limit_events
         WHERE ts >= ?`,
      )
      .get(since) as Record<string, number | null>;
    const trips = Number(row.circuitOpenCount ?? 0);
    const hours = windowMs / 3_600_000;
    return {
      circuitOpenCount: trips,
      circuitRecoverCount: Number(row.circuitRecoverCount ?? 0),
      sentinelCount: Number(row.sentinelCount ?? 0),
      totalEvents: Number(row.totalEvents ?? 0),
      tripsPerHour: hours > 0 ? +(trips / hours).toFixed(2) : 0,
      oldestEventTs: row.oldestEventTs ?? null,
      newestEventTs: row.newestEventTs ?? null,
      windowMs,
    };
  }

  /** Per-kind breakdown over the window. */
  rateLimitByKind(nowMs: number, windowMs: number): RateLimitKindRow[] {
    const since = nowMs - windowMs;
    return this.db
      .prepare(
        `SELECT kind, source, COUNT(*) AS count, MIN(ts) AS firstTs, MAX(ts) AS lastTs
         FROM rate_limit_events
         WHERE ts >= ?
         GROUP BY kind, source
         ORDER BY count DESC`,
      )
      .all(since) as RateLimitKindRow[];
  }

  /** Recent event rows, newest first. */
  rateLimitEvents(opts: { sinceMs?: number; limit?: number } = {}): RateLimitEventRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 1000);
    const since = opts.sinceMs ?? 0;
    return this.db
      .prepare(
        `SELECT id, ts, kind, source, account_key AS accountKey,
                session_name AS sessionName, reason, detail
         FROM rate_limit_events
         WHERE ts >= ?
         ORDER BY ts DESC
         LIMIT ?`,
      )
      .all(since, limit) as RateLimitEventRow[];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } catch { /* ignore */ }
  }
}
