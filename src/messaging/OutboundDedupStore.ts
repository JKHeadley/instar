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
 * FAIL-OPEN BY CONSTRUCTION. Every method swallows errors and degrades to "no
 * durable signal" (the caller then behaves exactly as the in-memory-only path did).
 * A dedup store must NEVER drop a legitimate message because its backing storage
 * hiccuped — suppressing a real reply is strictly worse than the duplicate it
 * prevents. So a missing/locked/corrupt/native-binding-broken db ⇒ silently no-op,
 * never throw. (better-sqlite3 binding fragility was itself a factor in this
 * incident, so the construct path is guarded too.)
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import path from 'node:path';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';

export interface OutboundDedupStore {
  /** True if `fingerprint` was recorded for `topicId` at or after `sinceMs`. */
  wasSentSince(topicId: number, fingerprint: string, sinceMs: number): boolean;
  /** Record that `fingerprint` was sent to `topicId` at `atMs`. Call after a successful send. */
  record(topicId: number, fingerprint: string, atMs: number): void;
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
      this.db.pragma('synchronous = NORMAL');
      this.db.pragma('busy_timeout = 5000');
      this.db.exec(
        `CREATE TABLE IF NOT EXISTS outbound_dedup (
           topic_id INTEGER NOT NULL,
           fingerprint TEXT NOT NULL,
           sent_at INTEGER NOT NULL,
           PRIMARY KEY (topic_id, fingerprint)
         )`,
      );
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

  wasSentSince(topicId: number, fingerprint: string, sinceMs: number): boolean {
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

  record(topicId: number, fingerprint: string, atMs: number): void {
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
  static defaultPath(stateDir: string): string {
    return path.join(stateDir, 'outbound-dedup.db');
  }
}
