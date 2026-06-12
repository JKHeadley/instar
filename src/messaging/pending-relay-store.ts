/**
 * PendingRelayStore — SQLite-backed durable queue of telegram-reply
 * delivery attempts that the script-side detector classified as
 * recoverable.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § Layer 2a.
 *
 * Path: `<stateDir>/state/pending-relay.<agentId>.sqlite` (mode 0600).
 *
 * The agentId infix exists because instar supports two install layouts:
 *   - per-agent: `~/.instar/agents/<id>/.instar/`
 *   - per-project (shared worktrees): `<project>/.instar/`
 * Two agents that share a project `.instar/` would otherwise collide
 * on a single queue file. The infix prevents that.
 *
 * Concurrency model:
 *   - WAL journaling — sentinel UPDATEs do not block script INSERTs.
 *   - synchronous=NORMAL — durable enough; we accept that the most
 *     recent few inserts MAY be lost on a power cut, which is fine
 *     because the sender's exit-1 keeps the agent-visible failure
 *     semantics (the agent can still see its send failed).
 *   - busy_timeout=5000 — handles transient contention without raising.
 *
 * Layer 2 owns ENQUEUE and lookup primitives. The actual claim/lease
 * lifecycle (Layer 3) layers on top of `transition()` — the store does
 * not opinion-ate on what counts as a legal state transition; it just
 * persists what its caller writes.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import {
  REAP_NOTIFY_DELIVERY_PREFIX,
  REAP_NOTIFY_DELIVERY_PREFIX_UPPER,
} from './reap-notice-delivery-id.js';

/**
 * Anomaly clamp for the restore-purge hold exemption (reap-notify spec R1.6):
 * a `next_attempt_at` more than this far in the future is treated as corrupt
 * at restore-purge time (purged + logged) — no legitimate writer holds that
 * long, and without the clamp a malformed row would live forever.
 */
const FAR_FUTURE_HOLD_CLAMP_MS = 7 * 24 * 60 * 60 * 1000;

// ── Types ─────────────────────────────────────────────────────────────

export type DeliveryState =
  | 'queued'
  | 'claimed'
  | 'delivered-recovered'
  | 'delivered-tone-gated'
  | 'delivered-ambiguous'
  | 'escalated'
  | 'dead-letter';

export interface PendingRelayRow {
  delivery_id: string;
  topic_id: number;
  text_hash: string;
  text: Buffer;
  format: string | null;
  http_code: number | null;
  error_body: string | null;
  attempted_port: number | null;
  attempted_at: string;
  attempts: number;
  next_attempt_at: string | null;
  state: DeliveryState;
  claimed_by: string | null;
  status_history: string;
  truncated: 0 | 1;
  /** Serialized kind metadata (messageKind/senderClass/jobSlug/advisoryAck/
   *  advisoryCodes) — the redrive forwards it whole so a queued automated
   *  send is never mis-kinded and an acked-then-queued send still lands its
   *  'acked' audit row (spec outbound-jargon-filepath-gap §2.5). Null on
   *  legacy rows (they ride the delivery-id breadcrumb exemption). */
  message_metadata: string | null;
}

export interface EnqueueInput {
  delivery_id: string;
  topic_id: number;
  text_hash: string;
  text: Buffer | string;
  format?: string | null;
  http_code?: number | null;
  error_body?: string | null;
  attempted_port?: number | null;
  attempted_at?: string;
  truncated?: boolean;
  message_metadata?: string | null;
  /**
   * Release hold (reap-notify spec R1.3): a row enqueued with a future
   * `next_attempt_at` is not claimable until that instant. The hold rides
   * the EXISTING column — the claim queries already honor it, so a
   * rolled-back binary keeps honoring holds. No schema change.
   */
  next_attempt_at?: string | null;
}

// ── Schema ────────────────────────────────────────────────────────────

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS entries (
     delivery_id    TEXT PRIMARY KEY,
     topic_id       INTEGER NOT NULL,
     text_hash      TEXT NOT NULL,
     text           BLOB NOT NULL,
     format         TEXT,
     http_code      INTEGER,
     error_body     TEXT,
     attempted_port INTEGER,
     attempted_at   TEXT NOT NULL,
     attempts       INTEGER NOT NULL DEFAULT 1,
     next_attempt_at TEXT,
     state          TEXT NOT NULL,
     claimed_by     TEXT,
     status_history TEXT NOT NULL DEFAULT '[]',
     truncated      INTEGER NOT NULL DEFAULT 0,
     message_metadata TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_state_next ON entries(state, next_attempt_at)`,
  `CREATE INDEX IF NOT EXISTS idx_text_hash_topic ON entries(text_hash, topic_id)`,
];

// Idempotent column adds — matches what the spec calls "if column missing,
// ALTER TABLE ADD COLUMN". better-sqlite3 raises on a duplicate column;
// we catch and continue.
const COLUMN_ADDS: Array<{ name: string; ddl: string }> = [
  // truncated was added in the same commit that introduced this file, but
  // the ALTER path exists so older databases (e.g. someone who hand-bootstrapped
  // an entries table from an earlier dev branch) still upgrade cleanly.
  { name: 'truncated', ddl: 'ALTER TABLE entries ADD COLUMN truncated INTEGER NOT NULL DEFAULT 0' },
  // message_metadata (outbound-jargon-filepath-gap §2.5) — the table already
  // exists on every deployed agent, so the column arrives ONLY via this
  // idempotent ALTER (and its parallel in telegram-reply.sh's two writers).
  { name: 'message_metadata', ddl: 'ALTER TABLE entries ADD COLUMN message_metadata TEXT' },
];

// ── Path resolution ───────────────────────────────────────────────────

/**
 * Resolve the SQLite path. `stateDir` is the agent's `.instar/` directory.
 * The store lives under `<stateDir>/state/`, alongside other per-agent
 * runtime files.
 */
export function resolvePendingRelayPath(stateDir: string, agentId: string): string {
  return path.join(stateDir, 'state', `pending-relay.${sanitizeAgentId(agentId)}.sqlite`);
}

export function resolvePendingRelayLockPath(stateDir: string, agentId: string): string {
  return path.join(stateDir, 'state', `pending-relay.${sanitizeAgentId(agentId)}.sqlite.lock`);
}

/**
 * Defensive — the agentId comes from config.json which is operator-controlled
 * but should not contain path separators; if it ever does, we'd land in a
 * directory traversal. Replace anything outside [A-Za-z0-9._-] with '_'.
 */
function sanitizeAgentId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_');
}

// ── Store ─────────────────────────────────────────────────────────────

export class PendingRelayStore {
  private db: BetterSqliteDatabase;
  private path: string;

  private constructor(db: BetterSqliteDatabase, dbPath: string) {
    this.db = db;
    this.path = dbPath;
    // Close-on-exit registry (SqliteRegistry.ts) — closed once at shutdown.
    registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
  }

  static open(agentId: string, stateDir: string): PendingRelayStore {
    const dbPath = resolvePendingRelayPath(stateDir, agentId);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    let db: BetterSqliteDatabase;
    try {
      db = new Database(dbPath);
    } catch (err) {
      throw new Error(
        `pending-relay-store: failed to open ${dbPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Mode 0600 — privacy & retention §3g. Only the owning user may read
    // queued message bodies. Race-free chmod after the file already exists.
    try {
      fs.chmodSync(dbPath, 0o600);
    } catch {
      // best-effort; some FS layouts (Windows, certain mounts) don't honor mode bits.
    }

    // Mandatory pragmas (spec § 2a). WAL + NORMAL + 5s busy timeout.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 5000');

    for (const ddl of SCHEMA) {
      db.exec(ddl);
    }
    // Idempotent column adds.
    for (const col of COLUMN_ADDS) {
      try {
        db.exec(col.ddl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!/duplicate column name/i.test(msg)) {
          throw err;
        }
      }
    }

    return new PendingRelayStore(db, dbPath);
  }

  /**
   * Enqueue a recoverable delivery failure.
   *
   * Idempotent on `delivery_id` — INSERT OR IGNORE so a script that
   * accidentally re-runs with the same delivery_id (e.g. a bash retry
   * loop in a misbehaving session) doesn't duplicate the row.
   *
   * Returns true if the row was newly inserted, false if it was already
   * present (idempotent no-op).
   */
  enqueue(input: EnqueueInput): boolean {
    const text = typeof input.text === 'string' ? Buffer.from(input.text, 'utf-8') : input.text;
    const attemptedAt = input.attempted_at ?? new Date().toISOString();
    const initialHistory = JSON.stringify([
      { state: 'queued', at: attemptedAt, http_code: input.http_code },
    ]);
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO entries (
         delivery_id, topic_id, text_hash, text, format,
         http_code, error_body, attempted_port,
         attempted_at, attempts, next_attempt_at,
         state, claimed_by, status_history, truncated, message_metadata
       ) VALUES (
         @delivery_id, @topic_id, @text_hash, @text, @format,
         @http_code, @error_body, @attempted_port,
         @attempted_at, 1, @next_attempt_at,
         'queued', NULL, @status_history, @truncated, @message_metadata
       )`,
    );
    const result = stmt.run({
      delivery_id: input.delivery_id,
      topic_id: input.topic_id,
      text_hash: input.text_hash,
      text,
      format: input.format ?? null,
      http_code: input.http_code ?? null,
      error_body: input.error_body ?? null,
      attempted_port: input.attempted_port ?? null,
      attempted_at: attemptedAt,
      next_attempt_at: input.next_attempt_at ?? null,
      status_history: initialHistory,
      truncated: input.truncated ? 1 : 0,
      message_metadata: input.message_metadata ?? null,
    });
    return result.changes === 1;
  }

  findByDeliveryId(deliveryId: string): PendingRelayRow | null {
    const stmt = this.db.prepare('SELECT * FROM entries WHERE delivery_id = ?');
    const row = stmt.get(deliveryId) as PendingRelayRow | undefined;
    return row ?? null;
  }

  /**
   * Dedup-window query (spec § 2b step 2). Returns the most-recently
   * inserted row whose (topic_id, text_hash) matches and whose
   * attempted_at is within `windowMs` of `now`. Used by the script to
   * suppress a tight-loop flood from a misbehaving session.
   */
  findByTopicAndHashWithin(
    topicId: number,
    textHash: string,
    windowMs: number,
    now: Date = new Date(),
  ): PendingRelayRow | null {
    const cutoff = new Date(now.getTime() - windowMs).toISOString();
    const stmt = this.db.prepare(
      `SELECT * FROM entries
         WHERE topic_id = ? AND text_hash = ? AND attempted_at >= ?
         ORDER BY attempted_at DESC LIMIT 1`,
    );
    const row = stmt.get(topicId, textHash, cutoff) as PendingRelayRow | undefined;
    return row ?? null;
  }

  /**
   * Update an entry's state and any additional fields. The spec calls
   * for "atomic state transitions" — we run the UPDATE in a single
   * statement and append a status-history row in the same transaction
   * so a sentinel crash mid-transition cannot leave a row in a torn
   * state.
   *
   * Returns true if a row was actually updated, false if no row matched
   * the delivery_id (caller race or stale id).
   */
  transition(
    deliveryId: string,
    newState: DeliveryState,
    additionalFields: Partial<{
      claimed_by: string | null;
      next_attempt_at: string | null;
      attempts: number;
      http_code: number | null;
      error_body: string | null;
    }> = {},
  ): boolean {
    const tx = this.db.transaction((id: string, state: DeliveryState, extra: typeof additionalFields) => {
      const current = this.db.prepare('SELECT status_history FROM entries WHERE delivery_id = ?').get(id) as
        | { status_history: string }
        | undefined;
      if (!current) return false;
      let history: unknown[];
      try {
        const parsed = JSON.parse(current.status_history);
        history = Array.isArray(parsed) ? parsed : [];
      } catch {
        history = [];
      }
      history.push({ state, at: new Date().toISOString() });

      const fields: string[] = ['state = @state', 'status_history = @status_history'];
      const params: Record<string, unknown> = {
        delivery_id: id,
        state,
        status_history: JSON.stringify(history),
      };
      for (const [k, v] of Object.entries(extra)) {
        if (v === undefined) continue;
        fields.push(`${k} = @${k}`);
        params[k] = v;
      }
      const sql = `UPDATE entries SET ${fields.join(', ')} WHERE delivery_id = @delivery_id`;
      const result = this.db.prepare(sql).run(params);
      return result.changes === 1;
    });
    return tx(deliveryId, newState, additionalFields) as boolean;
  }

  /** Diagnostic helper used by tests. */
  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM entries').get() as { n: number };
    return row.n;
  }

  /**
   * Layer 3 sentinel selector — returns rows whose `state` is in
   * (`queued`, `claimed`) and whose `next_attempt_at` (when set) is at
   * or before `nowIso`. Sorted by `attempted_at` ascending so the
   * sentinel can drain oldest-first within per-topic rate caps.
   *
   * Origin scoping (reap-notify spec R1.3): rows whose delivery_id carries
   * the `reap-notify:` prefix belong to ReapNoticeDrain and are EXCLUDED
   * here — the single-owner contract lives in the queries, not in drain
   * etiquette. The complement is `selectClaimableReapNotices`. Both filters
   * are index-compatible range predicates on the PK.
   *
   * The query is bounded at `limit` to prevent a runaway tick scan.
   * The sentinel handles its own batching above this layer.
   */
  selectClaimable(nowIso: string, limit = 100): PendingRelayRow[] {
    const stmt = this.db.prepare(
      `SELECT * FROM entries
         WHERE state IN ('queued', 'claimed')
           AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
           AND NOT (delivery_id >= @prefixLower AND delivery_id < @prefixUpper)
         ORDER BY attempted_at ASC
         LIMIT @limit`,
    );
    return stmt.all({
      now: nowIso,
      limit,
      prefixLower: REAP_NOTIFY_DELIVERY_PREFIX,
      prefixUpper: REAP_NOTIFY_DELIVERY_PREFIX_UPPER,
    }) as PendingRelayRow[];
  }

  /**
   * ReapNoticeDrain selector (reap-notify spec R1.3) — the complement of
   * `selectClaimable`: due rows INSIDE the `reap-notify:` PK range only.
   * Range predicate (`>= lower AND < upper`) so SQLite serves it from the
   * PK index — the 30s always-on drain must not be a latent table scan.
   * Idle cost on an empty store is one indexed probe.
   */
  selectClaimableReapNotices(nowIso: string, limit = 100): PendingRelayRow[] {
    const stmt = this.db.prepare(
      `SELECT * FROM entries
         WHERE delivery_id >= @prefixLower AND delivery_id < @prefixUpper
           AND state IN ('queued', 'claimed')
           AND (next_attempt_at IS NULL OR next_attempt_at <= @now)
         ORDER BY attempted_at ASC
         LIMIT @limit`,
    );
    return stmt.all({
      now: nowIso,
      limit,
      prefixLower: REAP_NOTIFY_DELIVERY_PREFIX,
      prefixUpper: REAP_NOTIFY_DELIVERY_PREFIX_UPPER,
    }) as PendingRelayRow[];
  }

  /**
   * Compare-and-swap claim (reap-notify spec R1.3): atomically move a row
   * to `claimed`/`claimed_by` ONLY if it still looks exactly like the row
   * the caller selected (same state + same claimed_by). Two drains racing
   * the same row can never both succeed — the loser's UPDATE matches zero
   * rows. Returns true when this caller won the claim.
   */
  claimCas(
    deliveryId: string,
    newClaimedBy: string,
    expected: { state: DeliveryState; claimed_by: string | null },
  ): boolean {
    const tx = this.db.transaction(() => {
      const result = this.db
        .prepare(
          `UPDATE entries
             SET state = 'claimed', claimed_by = @newClaimedBy
             WHERE delivery_id = @delivery_id
               AND state = @expectedState
               AND claimed_by IS @expectedClaimedBy`,
        )
        .run({
          delivery_id: deliveryId,
          newClaimedBy,
          expectedState: expected.state,
          expectedClaimedBy: expected.claimed_by,
        });
      if (result.changes !== 1) return false;
      // Append the status-history row in the same transaction (parity with
      // `transition()` so a crash mid-claim cannot tear the history).
      const current = this.db
        .prepare('SELECT status_history FROM entries WHERE delivery_id = ?')
        .get(deliveryId) as { status_history: string } | undefined;
      if (current) {
        let history: unknown[];
        try {
          const parsed = JSON.parse(current.status_history);
          history = Array.isArray(parsed) ? parsed : [];
        } catch {
          history = [];
        }
        history.push({ state: 'claimed', at: new Date().toISOString() });
        this.db
          .prepare('UPDATE entries SET status_history = @h WHERE delivery_id = @id')
          .run({ h: JSON.stringify(history), id: deliveryId });
      }
      return true;
    });
    return tx() as boolean;
  }

  /**
   * List the rows a restore-purge at `cutoffIso` WOULD delete — so the
   * caller can make the loss traceable (per-row log + degradation report)
   * before purging. A restore-purge deletes queued-undelivered outbound
   * messages; until 2026-06-05 it was the delivery stack's only silent
   * deletion path.
   *
   * Predicate matches `purgeStaleClaimable` exactly (the loud-loss logging
   * must cover exactly what the purge deletes). `farFutureClamp` marks rows
   * purged by the 7-day corruption clamp rather than ordinary staleness.
   */
  listStaleClaimable(
    cutoffIso: string,
    nowIso: string = new Date().toISOString(),
  ): Array<{
    delivery_id: string;
    topic_id: number;
    attempted_at: string;
    text: string;
    farFutureClamp: boolean;
  }> {
    const farFuture = farFutureClampIso(nowIso);
    const stmt = this.db.prepare(
      `SELECT delivery_id, topic_id, attempted_at, next_attempt_at, text
         FROM entries
         WHERE state IN ('queued', 'claimed')
           AND attempted_at < @cutoff
           AND (next_attempt_at IS NULL OR next_attempt_at < @cutoff OR next_attempt_at > @farFuture)
         ORDER BY attempted_at ASC`,
    );
    const rows = stmt.all({ cutoff: cutoffIso, farFuture }) as Array<{
      delivery_id: string;
      topic_id: number;
      attempted_at: string;
      next_attempt_at: string | null;
      text: Buffer | string;
    }>;
    return rows.map((r) => ({
      delivery_id: r.delivery_id,
      topic_id: r.topic_id,
      attempted_at: r.attempted_at,
      text: Buffer.isBuffer(r.text) ? r.text.toString('utf-8') : String(r.text ?? ''),
      farFutureClamp: r.next_attempt_at !== null && r.next_attempt_at > farFuture,
    }));
  }

  /**
   * Layer 3 restore-purge — drops queued/claimed rows that are genuinely
   * stale. Called once at sentinel startup (DFS spec §3h, semantics updated
   * by reap-notify spec R1.6).
   *
   * Staleness cutoff is `max(attempted_at, next_attempt_at)`: a row HELD
   * for future release (its `next_attempt_at` is still ahead of the cutoff)
   * is NOT stale — purging it was the mechanism behind the documented
   * 2026-06-05 silent-deletion incident (a quiet-hours-held notice crossing
   * a routine restart was eaten at boot). In SQL: a row is purged only when
   * `attempted_at < cutoff` AND its `next_attempt_at` is null, also past,
   * or beyond the 7-day corruption clamp (`farFutureClampIso`) — no
   * legitimate writer holds that long; without the clamp a malformed row
   * would live forever.
   *
   * Returns the number of rows deleted so the caller can emit a one-line
   * restore log.
   */
  purgeStaleClaimable(cutoffIso: string, nowIso: string = new Date().toISOString()): number {
    const farFuture = farFutureClampIso(nowIso);
    const stmt = this.db.prepare(
      `DELETE FROM entries
         WHERE state IN ('queued', 'claimed')
           AND attempted_at < @cutoff
           AND (next_attempt_at IS NULL OR next_attempt_at < @cutoff OR next_attempt_at > @farFuture)`,
    );
    const result = stmt.run({ cutoff: cutoffIso, farFuture });
    return result.changes ?? 0;
  }

  /**
   * Bounded cleanup for the reap-notify lane (P19 — the always-on drain must
   * not grow the store unboundedly when DFS's retention pass is off): deletes
   * TERMINAL-state rows inside the reap-notify PK range older than `beforeIso`.
   * Queued/claimed rows are never touched.
   */
  purgeTerminalReapNotices(beforeIso: string): number {
    const stmt = this.db.prepare(
      `DELETE FROM entries
         WHERE delivery_id >= @prefixLower AND delivery_id < @prefixUpper
           AND state NOT IN ('queued', 'claimed')
           AND attempted_at < @before`,
    );
    const result = stmt.run({
      before: beforeIso,
      prefixLower: REAP_NOTIFY_DELIVERY_PREFIX,
      prefixUpper: REAP_NOTIFY_DELIVERY_PREFIX_UPPER,
    });
    return result.changes ?? 0;
  }

  pathOnDisk(): string {
    return this.path;
  }

  /** Direct DB handle for contract tests only. */
  rawDb(): BetterSqliteDatabase {
    return this.db;
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // best-effort
    }
  }
}

/** ISO instant `FAR_FUTURE_HOLD_CLAMP_MS` past `nowIso` (R1.6 anomaly clamp). */
function farFutureClampIso(nowIso: string): string {
  const now = Date.parse(nowIso);
  const base = Number.isNaN(now) ? Date.now() : now;
  return new Date(base + FAR_FUTURE_HOLD_CLAMP_MS).toISOString();
}

// ── Boot self-check ───────────────────────────────────────────────────

/**
 * Verify the SQLite runtime substrate is usable.
 *
 * Spec § 2a "Runtime dependency": the `sqlite3` CLI is not universally
 * pre-installed (Alpine, minimal Debian). On boot, probe for it; if
 * absent, raise a `sqlite3-cli-missing` degradation event. The script
 * has a `node:sqlite` / `better-sqlite3` fallback path — this is purely
 * a "tell the operator" signal, not a fatal startup failure.
 *
 * We also confirm `better-sqlite3` itself can open an in-memory DB; if
 * that fails (e.g. node-gyp build was skipped on this platform), we
 * emit a `sqlite-runtime-broken` degradation. The server keeps running
 * — Layer 2 features are gracefully degraded; everything else continues
 * to work.
 *
 * Returns `{ok: true}` when the in-process driver works (independent of
 * CLI presence), so AgentServer can decide whether to stand up the
 * /events/delivery-failed endpoint at all.
 */
export function assertSqliteAvailable(): { ok: boolean; cliPresent: boolean; reason?: string } {
  let cliPresent = false;
  try {
    execFileSync('sqlite3', ['-version'], { stdio: 'ignore' });
    cliPresent = true;
  } catch {
    cliPresent = false;
    try {
      DegradationReporter.getInstance().report({
        feature: 'sqlite3-cli-missing',
        primary: 'sqlite3 CLI for shell-side queue operations',
        fallback: 'node:sqlite / better-sqlite3 in-process driver from script fallback path',
        reason: 'sqlite3 binary not found on PATH; the relay script will use its node-based fallback.',
        impact:
          'No user-visible impact under normal operation. The script-side ' +
          'queue path is slightly slower per insert (process startup cost) ' +
          'than with the CLI. Fix: install sqlite3 (apt install sqlite3 / apk add sqlite).',
      });
    } catch {
      // DegradationReporter is best-effort; never block boot on it.
    }
  }

  // Confirm the in-process driver works at all.
  try {
    const probe = new Database(':memory:');
    probe.exec('CREATE TABLE t (x INTEGER)');
    probe.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      DegradationReporter.getInstance().report({
        feature: 'sqlite-runtime-broken',
        primary: 'better-sqlite3 in-process driver',
        fallback: 'pending-relay queue disabled — recoverable failures will not be enqueued',
        reason: `better-sqlite3 failed to open an in-memory DB: ${reason}`,
        impact:
          'Layer 2 (durable queue + structured failure events) is disabled. ' +
          'Existing direct-send paths continue to work. Fix: rebuild ' +
          'better-sqlite3 for this platform (npm rebuild better-sqlite3).',
      });
    } catch {
      // best-effort
    }
    return { ok: false, cliPresent, reason };
  }

  return { ok: true, cliPresent };
}
