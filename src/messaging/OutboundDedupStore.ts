/**
 * OutboundDedupStore — durable backing for OutboundContentDedup so an identical
 * reply is suppressed even ACROSS a server restart or across overlapping server
 * processes.
 *
 * Earned 2026-06-07 (topic 21816, finding_cross_restart_duplicate_replies): during
 * the "server temporarily down" restart instability a byte-identical refusal went
 * out 5× to the same topic within 19s. The in-memory OutboundContentDedup couldn't
 * catch it because its Map is per-process and resets on restart — exactly the
 * window the restart churn opened. A durable fingerprint store closes that window.
 *
 * Legacy fingerprint reads/writes fail open to the caller's in-memory layer,
 * and an unavailable database does not prevent startup. Origin reservations
 * have a different contract: read errors return null, reservation errors return
 * unavailable so origin execution holds, and completion errors return false
 * without releasing the reservation or changing an accepted transport receipt.
 * Origin database exceptions report degradation without exposing content,
 * credentials, destination identifiers or raw SQLite errors.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import path from 'node:path';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';

export interface OutboundDedupStore {
  /** True if `fingerprint` was recorded for `topicId` at or after `sinceMs`. */
  wasSentSince(topicId: number | string, fingerprint: string, sinceMs: number): boolean;
  /** Record that `fingerprint` was sent to `topicId` at `atMs`. Call after a successful send. */
  record(topicId: number | string, fingerprint: string, atMs: number): void;
  hasOriginReservation?(topicId: number | string, fingerprint: string, now: number): boolean | null;
  reserveOrigin?(input: { topicId: number | string; fingerprint: string; operationId: string; now: number; expiresAt: number; sentSince: number }): 'reserved' | 'duplicate' | 'unavailable';
  completeOrigin?(input: { topicId: number | string; fingerprint: string; operationId: string; now: number; expiresAt: number }): boolean;
}

/** A no-op store — the explicit "no durable layer" fallback. */
export const NULL_OUTBOUND_DEDUP_STORE: OutboundDedupStore = {
  wasSentSince: () => false,
  record: () => {},
};

export class SqliteOutboundDedupStore implements OutboundDedupStore {
  private db: BetterSqliteDatabase | null = null;
  private lastPruneAt = 0;

  /** @param dbPath absolute path, or ':memory:' for tests. */
  constructor(dbPath: string) {
    try {
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = FULL');
      this.db.pragma('busy_timeout = 50');
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS outbound_dedup (
           topic_id INTEGER NOT NULL,
           fingerprint TEXT NOT NULL,
           sent_at INTEGER NOT NULL,
           PRIMARY KEY (topic_id, fingerprint)
         )`,
      );
      this.db.exec(`CREATE TABLE IF NOT EXISTS outbound_origin_reservations (
        slot INTEGER PRIMARY KEY CHECK(slot >= 0 AND slot < 4096), topic_key TEXT NOT NULL,
        fingerprint TEXT NOT NULL, operation_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
        UNIQUE(topic_key, fingerprint))`);
      // Close-on-exit registry (SqliteRegistry.ts) — closed once at shutdown so
      // the handle never leaks (db-leak hygiene; relevant to the topic-21816
      // resource theme). Registered only after the db is successfully open.
      registerSqliteHandle(() => {
        try { this.db?.close(); } catch { /* already closed */ }
      });
    } catch {
      // @silent-fallback-ok — fail-open by design: no durable layer (e.g. native
      // binding broken / fs unwritable). A dedup store must never block startup.
      this.db = null;
    }
  }

  wasSentSince(topicId: number | string, fingerprint: string, sinceMs: number): boolean {
    if (!this.db) return false;
    try {
      const row = this.db
        .prepare('SELECT sent_at FROM outbound_dedup WHERE topic_id = ? AND fingerprint = ?')
        .get(topicId, fingerprint) as { sent_at: number } | undefined;
      return row !== undefined && row.sent_at >= sinceMs;
    } catch {
      // @silent-fallback-ok — fail-open: no durable signal ⇒ caller falls back to
      // in-memory; never suppress a legitimate message because of a read error.
      return false;
    }
  }

  record(topicId: number | string, fingerprint: string, atMs: number): void {
    if (!this.db) return;
    try {
      this.db
        .prepare(
          `INSERT INTO outbound_dedup (topic_id, fingerprint, sent_at) VALUES (?, ?, ?)
           ON CONFLICT(topic_id, fingerprint) DO UPDATE SET sent_at = excluded.sent_at`,
        )
        .run(topicId, fingerprint, atMs);
      // Opportunistic prune (~hourly) so the table can't grow without bound.
      if (atMs - this.lastPruneAt > 3_600_000) {
        this.lastPruneAt = atMs;
        // Keep a generous 24h tail (well past any dedup window) — cheap insurance.
        this.db.prepare('DELETE FROM outbound_dedup WHERE sent_at < ?').run(atMs - 86_400_000);
      }
    } catch {
      // @silent-fallback-ok — fail-open: a record/prune failure must not break the send path.
    }
  }

  /** Resolve the default db path for an agent's state dir. */
  hasOriginReservation(topicId: number | string, fingerprint: string, now: number): boolean | null {
    if (!this.db) return null;
    try { return !!this.db.prepare('SELECT 1 FROM outbound_origin_reservations WHERE topic_key=? AND fingerprint=? AND expires_at>?').get(String(topicId), fingerprint, now); }
    catch {
      DegradationReporter.getInstance().report({
        feature: 'OutboundDedupStore.origin-reservation-read',
        primary: 'Read durable origin content reservations',
        fallback: 'Return an unavailable durable signal to the caller',
        reason: 'Origin reservation database read failed',
        impact: 'Legacy content checks use memory only; origin execution still requires a durable reservation',
      });
      return null;
    }
  }

  /** Fixed 4096-slot reservation table; expired slots are reused in place.
   * This is content suppression state, never a transport claim or retry queue. */
  reserveOrigin(input: { topicId: number | string; fingerprint: string; operationId: string; now: number; expiresAt: number; sentSince: number }): 'reserved' | 'duplicate' | 'unavailable' {
    if (!this.db) return 'unavailable';
    try {
      return this.db.transaction(() => {
        const db = this.db!, key = String(input.topicId);
        const existing = db.prepare('SELECT slot,operation_id,expires_at FROM outbound_origin_reservations WHERE topic_key=? AND fingerprint=?').get(key, input.fingerprint) as { slot: number; operation_id: string; expires_at: number } | undefined;
        if (existing && existing.expires_at > input.now) return existing.operation_id === input.operationId ? 'reserved' : 'duplicate';
        if (db.prepare('SELECT 1 FROM outbound_dedup WHERE topic_id=? AND fingerprint=? AND sent_at>=?').get(input.topicId, input.fingerprint, input.sentSince)) return 'duplicate';
        const reusable = existing ?? db.prepare('SELECT slot FROM outbound_origin_reservations WHERE expires_at<=? ORDER BY slot LIMIT 1').get(input.now) as { slot: number } | undefined;
        if (reusable) db.prepare('UPDATE outbound_origin_reservations SET topic_key=?,fingerprint=?,operation_id=?,expires_at=? WHERE slot=?').run(key, input.fingerprint, input.operationId, input.expiresAt, reusable.slot);
        else {
          const count = (db.prepare('SELECT count(*) AS n FROM outbound_origin_reservations').get() as { n: number }).n;
          if (count >= 4096) return 'unavailable';
          db.prepare('INSERT INTO outbound_origin_reservations VALUES (?,?,?,?,?)').run(count, key, input.fingerprint, input.operationId, input.expiresAt);
        }
        return 'reserved';
      }).immediate();
    } catch {
      DegradationReporter.getInstance().report({
        feature: 'OutboundDedupStore.origin-reservation-write',
        primary: 'Atomically reserve content for its origin operation',
        fallback: 'Return unavailable and hold origin execution',
        reason: 'Origin reservation database transaction failed',
        impact: 'The send remains held without replacing or releasing existing reservations',
      });
      return 'unavailable';
    }
  }

  completeOrigin(input: { topicId: number | string; fingerprint: string; operationId: string; now: number; expiresAt: number }): boolean {
    if (!this.db) return false;
    try {
      const completed = this.db.transaction(() => {
        const db = this.db!;
        if (!db.prepare('SELECT 1 FROM outbound_origin_reservations WHERE topic_key=? AND fingerprint=? AND operation_id=?').get(String(input.topicId), input.fingerprint, input.operationId)) return false;
        db.prepare('INSERT INTO outbound_dedup (topic_id,fingerprint,sent_at) VALUES (?,?,?) ON CONFLICT(topic_id,fingerprint) DO UPDATE SET sent_at=excluded.sent_at').run(input.topicId, input.fingerprint, input.now);
        db.prepare('UPDATE outbound_origin_reservations SET expires_at=? WHERE topic_key=? AND fingerprint=? AND operation_id=?').run(input.expiresAt, String(input.topicId), input.fingerprint, input.operationId);
        return true;
      }).immediate();
      // Keep the owner-fenced acceptance atomic, then reuse the ordinary
      // record path so origin-only traffic also performs its hourly retention.
      if (completed) this.record(input.topicId, input.fingerprint, input.now);
      return completed;
    } catch {
      DegradationReporter.getInstance().report({
        feature: 'OutboundDedupStore.origin-reservation-completion',
        primary: 'Record accepted content and settle its owner reservation',
        fallback: 'Retain the existing reservation and return incomplete',
        reason: 'Origin completion database transaction failed',
        impact: 'Content suppression may last until the original deadline; accepted transport receipts remain unchanged',
      });
      return false;
    }
  }

  static defaultPath(stateDir: string): string {
    return path.join(stateDir, 'outbound-dedup.db');
  }
}
