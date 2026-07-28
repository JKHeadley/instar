/**
 * CorrectionCaptureBacklog — a bounded, durable retry queue for captures the
 * Correction & Preference Learning Sentinel could NOT distill at capture time
 * because the LLM was rate-limited / capacity-throttled (spec §3.1 extension).
 *
 * THE PROBLEM IT FIXES: the capture→distill hop runs through a rate-limited
 * LlmQueue behind the account-global LLM circuit breaker. Under sustained
 * throttling EVERY distill throws (daily-cap / reserve-breach / aborted /
 * breaker-open) and the old hot path dropped the capture silently — so on a
 * throttled agent the correction ledger stayed permanently EMPTY even though
 * Layer-0 was detecting corrections. This store PERSISTS the (already
 * pre-scrubbed) capture instead of dropping it, so a later headroom window can
 * distill it into the CorrectionLedger.
 *
 * PRIVACY POSTURE (critical — a bounded extension of the ephemeral-ring model):
 *   - It persists ONLY the ALREADY-PRE-SCRUBBED turns. The §3.3 deterministic
 *     scrub (scrubSecrets) runs in buildDistillPrompt BEFORE anything reaches
 *     this store — the caller hands us the post-scrub turn text, never raw user
 *     text. We re-scrub defensively on enqueue (belt-and-suspenders), so even a
 *     mis-wired caller cannot leak a raw secret to disk.
 *   - Bounded retention TWO ways: a max-entries cap (evict oldest on overflow)
 *     AND a TTL (pruneExpired discards stale rows). Entries are DELETED the
 *     instant they distill (markDistilled) or exhaust their retries (bumpAttempt).
 *   - No API route exposes backlog row content. The scrubbed turn text never
 *     crosses HTTP — only counts are observable.
 *
 * DISCIPLINE (mirrors CorrectionLedger): SQLite WAL, prune-in-transaction, a
 * detected/age index, fail-open (every method swallows storage errors so a
 * backlog fault can NEVER throw into the fire-and-forget capture seam).
 */
import Database from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NativeModuleHealer } from '../memory/NativeModuleHealer.js';
import { scrubSecrets } from './scrubSecrets.js';
import type { CaptureTurn } from './CorrectionCaptureLoop.js';

// ── Types ─────────────────────────────────────────────────────────────

/** The pre-scrubbed capture payload persisted for a later distill attempt. */
export interface BacklogCaptureInput {
  topicId: number;
  /** PRE-SCRUBBED turns (oldest-first) — exactly the window buildDistillPrompt
   *  would scrub. Re-scrubbed defensively on enqueue. */
  turns: CaptureTurn[];
  /** Layer-0 code-determined provenance weight of the signal message. */
  deterministicWeight: number;
  sessionId?: string | null;
  capturedAt?: number;
}

/** A row claimed for a drain attempt. */
export interface BacklogEntry {
  id: string;
  topicId: number;
  turns: CaptureTurn[];
  deterministicWeight: number;
  sessionId: string | null;
  capturedAt: number;
  attempts: number;
  lastAttemptAt: number | null;
}

export interface CorrectionCaptureBacklogOptions {
  dbPath: string;
  /** Hard cap on stored entries; oldest evicted on overflow. Default 200. 0 disables (caller should not construct). */
  maxEntries?: number;
  /** Drop an entry once attempts EXCEEDS this (i.e. after maxRetries failed drains). Default 3. */
  maxRetries?: number;
  /** Min gap (ms) before a just-attempted entry can be re-claimed. Default 60_000. */
  minRetryGapMs?: number;
  onError?: (where: string, err: unknown) => void;
  now?: () => number;
}

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_RETRY_GAP_MS = 60_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS correction_capture_backlog (
     id                   TEXT PRIMARY KEY,
     topic_id             INTEGER NOT NULL,
     scrubbed_turns_json  TEXT NOT NULL,
     dedupe_hash          TEXT NOT NULL,
     deterministic_weight INTEGER NOT NULL DEFAULT 0,
     session_id           TEXT,
     captured_at          INTEGER NOT NULL,
     attempts             INTEGER NOT NULL DEFAULT 0,
     last_attempt_at      INTEGER
   )`,
  // Oldest-first claim/evict ordering + TTL prune scan.
  `CREATE INDEX IF NOT EXISTS idx_ccb_captured ON correction_capture_backlog(captured_at)`,
  // Near-identical dedupe lookup.
  `CREATE INDEX IF NOT EXISTS idx_ccb_dedupe ON correction_capture_backlog(dedupe_hash)`,
];

/**
 * Bounded durable backlog of pre-scrubbed captures awaiting an LLM headroom
 * window. Every method is fail-open — a storage fault returns a safe default and
 * never throws into the capture seam.
 */
export class CorrectionCaptureBacklog {
  private db: BetterSqliteDatabase;
  private readonly maxEntries: number;
  private readonly maxRetries: number;
  private readonly minRetryGapMs: number;
  private readonly onError: (where: string, err: unknown) => void;
  private readonly nowFn: () => number;

  constructor(opts: CorrectionCaptureBacklogOptions) {
    this.maxEntries = opts.maxEntries && opts.maxEntries > 0 ? opts.maxEntries : DEFAULT_MAX_ENTRIES;
    this.maxRetries =
      typeof opts.maxRetries === 'number' && opts.maxRetries >= 0 ? opts.maxRetries : DEFAULT_MAX_RETRIES;
    this.minRetryGapMs =
      typeof opts.minRetryGapMs === 'number' && opts.minRetryGapMs >= 0
        ? opts.minRetryGapMs
        : DEFAULT_MIN_RETRY_GAP_MS;
    this.nowFn = opts.now ?? (() => Date.now());
    this.onError =
      opts.onError ?? ((where, err) => console.error(`[CorrectionCaptureBacklog] ${where}:`, err));

    if (opts.dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    }
    this.db = NativeModuleHealer.openWithHealSync(
      'CorrectionCaptureBacklog',
      () => new Database(opts.dbPath),
    );
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    for (const ddl of SCHEMA) this.db.exec(ddl);
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
  }

  /**
   * Re-scrub turns defensively (belt-and-suspenders over the §3.3 pre-scrub) and
   * return ONLY {fromUser, text} — never the raw at-timestamp ring metadata.
   */
  private sanitizeTurns(turns: CaptureTurn[]): { fromUser: boolean; text: string }[] {
    return (Array.isArray(turns) ? turns : []).map((t) => ({
      fromUser: !!t.fromUser,
      text: scrubSecrets(String(t?.text ?? '')).slice(0, 1000),
    }));
  }

  /** A stable hash over (topicId + scrubbed turn text) for near-identical dedupe. */
  private dedupeHashOf(topicId: number, turns: { fromUser: boolean; text: string }[]): string {
    const canon = `${topicId}|` + turns.map((t) => `${t.fromUser ? 'u' : 'a'}:${t.text.trim()}`).join('\n');
    return crypto.createHash('sha256').update(canon).digest('hex');
  }

  /**
   * Persist a pre-scrubbed capture for a later distill. Dedupes against a
   * near-identical existing entry (same topic + same scrubbed turns) — a repeat
   * just bumps the existing row's captured_at forward rather than duplicating.
   * Evicts the oldest entry when at the max-entries cap. Fail-open: returns the
   * stored entry id, or null on any error (caller falls back to the old drop).
   */
  enqueue(input: BacklogCaptureInput): string | null {
    try {
      if (input.topicId == null) return null;
      const turns = this.sanitizeTurns(input.turns);
      if (turns.length === 0) return null;
      const dedupeHash = this.dedupeHashOf(input.topicId, turns);
      const capturedAt = input.capturedAt ?? this.nowFn();

      const txn = this.db.transaction(() => {
        // Near-identical dedupe: refresh the existing row's recency instead of
        // inserting a duplicate (so a rapid restate doesn't fill the cap).
        const existing = this.db
          .prepare(`SELECT id FROM correction_capture_backlog WHERE dedupe_hash = ? LIMIT 1`)
          .get(dedupeHash) as { id: string } | undefined;
        if (existing) {
          this.db
            .prepare(`UPDATE correction_capture_backlog SET captured_at = ? WHERE id = ?`)
            .run(capturedAt, existing.id);
          return existing.id;
        }

        // Evict oldest rows while at/over the cap (leave room for this insert).
        const count = (this.db
          .prepare(`SELECT COUNT(*) c FROM correction_capture_backlog`)
          .get() as { c: number }).c;
        const overflow = count - (this.maxEntries - 1);
        if (overflow > 0) {
          this.db
            .prepare(
              `DELETE FROM correction_capture_backlog
                WHERE id IN (
                  SELECT id FROM correction_capture_backlog
                  ORDER BY captured_at ASC, id ASC LIMIT @overflow)`,
            )
            .run({ overflow });
        }

        const id = `CCB-${crypto.randomBytes(6).toString('hex')}`;
        this.db
          .prepare(
            `INSERT INTO correction_capture_backlog
               (id, topic_id, scrubbed_turns_json, dedupe_hash, deterministic_weight,
                session_id, captured_at, attempts, last_attempt_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
          )
          .run(
            id,
            input.topicId,
            JSON.stringify(turns),
            dedupeHash,
            Math.max(0, Math.round(input.deterministicWeight || 0)),
            input.sessionId ?? null,
            capturedAt,
          );
        return id;
      });

      return txn();
    } catch (err) {
      this.onError('enqueue', err);
      return null;
    }
  }

  /**
   * Claim up to `n` oldest entries eligible for a drain attempt: not exhausted
   * (attempts <= maxRetries) and not attempted within minRetryGapMs. Read-only —
   * does NOT consume the row; the drainer markDistilled()s on success or
   * bumpAttempt()s on failure. Fail-open: returns [] on error.
   */
  claimBatch(n: number): BacklogEntry[] {
    try {
      const limit = Math.max(0, Math.min(Math.floor(n) || 0, 50));
      if (limit === 0) return [];
      const now = this.nowFn();
      const cutoff = now - this.minRetryGapMs;
      const rows = this.db
        .prepare(
          `SELECT * FROM correction_capture_backlog
            WHERE attempts <= @maxRetries
              AND (last_attempt_at IS NULL OR last_attempt_at <= @cutoff)
            ORDER BY captured_at ASC, id ASC
            LIMIT @limit`,
        )
        .all({ maxRetries: this.maxRetries, cutoff, limit }) as Record<string, unknown>[];
      return rows.map((r) => this.rowToEntry(r)).filter((e): e is BacklogEntry => e !== null);
    } catch (err) {
      this.onError('claimBatch', err);
      return [];
    }
  }

  /** Delete an entry once it has been distilled into the ledger. Fail-open. */
  markDistilled(id: string): void {
    try {
      this.db.prepare(`DELETE FROM correction_capture_backlog WHERE id = ?`).run(id);
    } catch (err) {
      this.onError('markDistilled', err);
    }
  }

  /**
   * Record a failed drain attempt. Increments attempts + stamps last_attempt_at;
   * DROPS the entry once attempts EXCEEDS maxRetries (give-up — bounded, no
   * infinite retry). Returns true if the entry was dropped. Fail-open.
   */
  bumpAttempt(id: string): boolean {
    try {
      const now = this.nowFn();
      const res = this.db
        .prepare(
          `UPDATE correction_capture_backlog
              SET attempts = attempts + 1, last_attempt_at = @now
            WHERE id = @id`,
        )
        .run({ id, now });
      if (res.changes === 0) return false;
      const row = this.db
        .prepare(`SELECT attempts FROM correction_capture_backlog WHERE id = ?`)
        .get(id) as { attempts: number } | undefined;
      if (row && row.attempts > this.maxRetries) {
        this.db.prepare(`DELETE FROM correction_capture_backlog WHERE id = ?`).run(id);
        return true;
      }
      return false;
    } catch (err) {
      this.onError('bumpAttempt', err);
      return false;
    }
  }

  /** Discard entries older than ttlMs (prune-in-transaction). Returns rows removed. Fail-open. */
  pruneExpired(ttlMs: number): number {
    try {
      if (!(ttlMs > 0)) return 0;
      const cutoff = this.nowFn() - ttlMs;
      const res = this.db
        .prepare(`DELETE FROM correction_capture_backlog WHERE captured_at < ?`)
        .run(cutoff);
      return res.changes ?? 0;
    } catch (err) {
      this.onError('pruneExpired', err);
      return 0;
    }
  }

  /** Current backlog depth (observability). Fail-open → 0. */
  count(): number {
    try {
      const row = this.db
        .prepare(`SELECT COUNT(*) c FROM correction_capture_backlog`)
        .get() as { c: number } | undefined;
      return row?.c ?? 0;
    } catch (err) {
      this.onError('count', err);
      return 0;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* ignore */ }
  }

  private rowToEntry(r: Record<string, unknown>): BacklogEntry | null {
    try {
      const parsed = JSON.parse(String(r.scrubbed_turns_json ?? '[]')) as {
        fromUser?: boolean; text?: string;
      }[];
      const turns: CaptureTurn[] = (Array.isArray(parsed) ? parsed : []).map((t) => ({
        fromUser: !!t.fromUser,
        text: String(t?.text ?? ''),
        at: 0, // ring metadata is not persisted; synthesized for the prompt builder.
      }));
      return {
        id: r.id as string,
        topicId: r.topic_id as number,
        turns,
        deterministicWeight: (r.deterministic_weight as number) ?? 0,
        sessionId: (r.session_id as string) ?? null,
        capturedAt: r.captured_at as number,
        attempts: (r.attempts as number) ?? 0,
        lastAttemptAt: (r.last_attempt_at as number) ?? null,
      };
    } catch {
      return null;
    }
  }
}
