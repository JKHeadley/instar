/**
 * InboundIdLedger — the receiver remembers which agent-to-agent message ids it
 * accepted, and whether one of an explicit list of hand-off outcomes happened
 * for each (docs/specs/a2a-inbound-id-ledger.md, ACT-053).
 *
 * Three rules carry the design:
 *   1. Only a LISTED outcome is a hand-off (OUTCOME_ALLOWLIST); anything else —
 *      including a return shape nobody anticipated — is `handoff-failed`.
 *   2. Only a DURABLE hand-off suppresses a resend. Today no hand-off path is
 *      durable, so the only terminal row is a verified `no-reply`. Every other
 *      resend is re-admitted and delivered with a fixed "resent copy" notice.
 *   3. Nothing another machine says can suppress a message.
 *
 * Every gap fails toward a LABELLED DUPLICATE, never a loss: a database error,
 * a cooldown, a full `unverified:` namespace and an unkeyed message all deliver
 * without a row.
 *
 * The transition table and the outcome allowlist are DATA (exported below) that
 * the code consults and the tests enumerate — one normative source.
 */

import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerSqliteHandle } from '../core/SqliteRegistry.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';
import { THREAD_ID_RE } from './ThreadLog.js';

// ── Normative data ─────────────────────────────────────────────────

export const INBOUND_DISPOSITIONS = ['admitted', 'handed-off', 'handoff-failed', 'refused', 'no-reply'] as const;
export type InboundDisposition = (typeof INBOUND_DISPOSITIONS)[number];

export const INBOUND_INGRESSES = ['relay', 'relay-unknown-sender', 'threadline-http', 'relay-agent'] as const;
export type InboundIngress = (typeof INBOUND_INGRESSES)[number];

/**
 * Outcome allowlist (spec §1 "Outcome table"). Every listed hand-off path and
 * whether it is DURABLE (would suppress a resend). Today none is durable —
 * making a path durable is ACT-055's per-path work.
 */
export type HandoffPath = 'listener' | 'warm' | 'approval' | 'store' | 'live' | 'pipe' | 'cold' | 'topic';
export const OUTCOME_ALLOWLIST: Readonly<Record<HandoffPath, { durable: boolean; note: string }>> = {
  listener: { durable: false, note: 'listener writeToInbox returned (an unacked entry is archived by rotate())' },
  warm: { durable: false, note: 'warm keep-alive spawn (PendingInjectStore write can fail silently; final inject is a keystroke)' },
  approval: { durable: false, note: 'autonomy queue-for-approval (500-char preview, pruned on expiry)' },
  store: { durable: false, note: '/messages/relay-agent with no router wired, relay() true (local namespaces only)' },
  live: { durable: false, note: 'live inject returned injected:true (a keystroke)' },
  pipe: { durable: false, note: 'pipe spawn returned spawned:true (a one-shot)' },
  cold: { durable: false, note: 'headless spawn for a new or resumed thread (the session must start)' },
  topic: { durable: false, note: 'topic linkage live-inject succeeded (a keystroke)' },
};
export const HANDOFF_PATHS = Object.keys(OUTCOME_ALLOWLIST) as HandoffPath[];

/** The paths ThreadlineRouter itself reports through its `path` discriminator. */
export const ROUTER_HANDOFF_PATHS: ReadonlySet<HandoffPath> = new Set(['live', 'cold', 'warm', 'topic', 'approval']);

export function isHandoffPath(p: unknown): p is HandoffPath {
  return typeof p === 'string' && Object.prototype.hasOwnProperty.call(OUTCOME_ALLOWLIST, p);
}
export function isDurablePath(p: string | null | undefined): boolean {
  return isHandoffPath(p) && OUTCOME_ALLOWLIST[p].durable === true;
}

/**
 * How an existing row is treated when the same id arrives again (spec §2).
 *  - `terminal`     — durable hand-off or `no-reply`: answered as a duplicate.
 *  - `in-flight`    — admitted by a live attempt still running: HTTP 409 / socket wait.
 *  - `readmit`      — not a duplicate: re-admitted and delivered.
 *  - `weak-readmit` — non-durable hand-off: re-admitted, delivered with the notice.
 *  - `local-readmit`— any local-namespace row not in flight: delivered again.
 */
export type ExistingRowClass = 'terminal' | 'in-flight' | 'readmit' | 'weak-readmit' | 'local-readmit';

/**
 * The transition table (spec §1) as data. `from` is the class of the existing
 * row (or `none`); `to` is the disposition written by the admission. Writes
 * after the commit (`admitted` → outcome) are listed with `from: 'admitted'`.
 */
export const TRANSITION_TABLE: ReadonlyArray<{ from: InboundDisposition | 'none'; to: InboundDisposition; when: string }> = [
  { from: 'none', to: 'admitted', when: 'the commit point' },
  { from: 'admitted', to: 'handed-off', when: 'the outcome is on the hand-off list' },
  { from: 'admitted', to: 'refused', when: 'a refusal decided after the commit (unverified: row removed + trace logged)' },
  { from: 'admitted', to: 'no-reply', when: 'a warrants-reply gate suppressed it' },
  { from: 'admitted', to: 'handoff-failed', when: 'any other outcome, a throw, or an exit with no recorded outcome' },
  { from: 'admitted', to: 'admitted', when: 're-admission: dead epoch, or live and not in flight, or the socket wait timed out / hit a ceiling' },
  { from: 'handoff-failed', to: 'admitted', when: 're-admission: a retry that passes the pre-commit gates' },
  { from: 'refused', to: 'admitted', when: 're-admission: a retry that passes the pre-commit gates' },
  { from: 'handed-off', to: 'admitted', when: 'a same-id resend over a NON-durable path (weakPathRedelivered)' },
];

/** Terminal dispositions — never re-admitted on a verified namespace. */
export function isTerminalRow(row: { disposition: string; path: string | null }): boolean {
  if (row.disposition === 'no-reply') return true;
  if (row.disposition === 'handed-off' && isDurablePath(row.path)) return true;
  return false;
}

export const LOCAL_NAMESPACE_PREFIXES = ['registry:', 'asserted:', 'local:'] as const;
export function isLocalNamespace(senderKey: string): boolean {
  return LOCAL_NAMESPACE_PREFIXES.some((p) => senderKey.startsWith(p));
}
export function isUnverifiedNamespace(senderKey: string): boolean {
  return senderKey.startsWith('unverified:');
}
export function isVerifiedNamespace(senderKey: string): boolean {
  return !isLocalNamespace(senderKey) && !isUnverifiedNamespace(senderKey);
}

/** Classify an existing row (pure; the single decision used by `admit`). */
export function classifyExistingRow(
  row: { disposition: string; path: string | null; process_epoch: string },
  ctx: { liveEpoch: string; inFlight: boolean; localNamespace: boolean },
): ExistingRowClass {
  const liveAdmittedInFlight = row.disposition === 'admitted' && row.process_epoch === ctx.liveEpoch && ctx.inFlight;
  if (liveAdmittedInFlight) return 'in-flight';
  if (ctx.localNamespace) return 'local-readmit';
  if (isTerminalRow(row)) return 'terminal';
  if (row.disposition === 'handed-off') return 'weak-readmit';
  return 'readmit';
}

/** Fixed server strings placed OUTSIDE the untrusted-message framing (spec §1). */
export const RESENT_COPY_NOTICE = "resent copy — check this thread's history before replying";
export const PEER_HANDOFF_NOTICE =
  'a peer machine reported, unverified, that it may already have handed this on; if this thread\'s history here does not show it, treat it as new';

export function buildResentNotice(peerReportedHandoff: boolean): string {
  return peerReportedHandoff ? `${RESENT_COPY_NOTICE}; ${PEER_HANDOFF_NOTICE}` : RESENT_COPY_NOTICE;
}

/** Fixed refusal reason codes for the unverified-namespace refusal log — never gate text. */
export type RefusalCode = 'autonomy-block' | 'loop-budget';

// ── Bounds ─────────────────────────────────────────────────────────

export const MESSAGE_ID_MAX = 128;
const PRINTABLE_ASCII_RE = /^[\x20-\x7e]+$/;
export const UNVERIFIED_TOTAL_CAP = 1000;
export const UNVERIFIED_PER_SENDER_CAP = 50;
export const WAIT_PER_SENDER_CAP = 8;
export const WAIT_PROCESS_CAP = 256;
export const WAIT_TIMEOUT_MS = 30_000;
export const COOLDOWN_START_MS = 30_000;
export const COOLDOWN_MAX_MS = 30 * 60_000;
export const PROBE_BREAKER_FAILURES = 10;
export const PRUNE_INTERVAL_MS = 5 * 60_000;
export const PRUNE_BATCH = 500;
export const PRUNE_MAX_BATCHES = 20;
export const PRUNE_BACKOFF_START_MS = 60 * 60_000;
export const PRUNE_BACKOFF_MAX_MS = 24 * 60 * 60_000;
export const PRUNE_BREAKER_TICKS = 10;
export const COUNTER_FLUSH_MS = 60_000;
export const RETENTION_DAYS_DEFAULT = 14;
export const RETENTION_DAYS_FLOOR = 2;
export const REFUSAL_LOG_MAX_BYTES = 5 * 1024 * 1024;

export function isValidMessageId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= MESSAGE_ID_MAX && PRINTABLE_ASCII_RE.test(id);
}
export function sanitizeThreadId(t: unknown): string | null {
  if (typeof t !== 'string' || t.length === 0) return null;
  if (THREAD_ID_RE.test(t)) return t;
  if (t.length <= MESSAGE_ID_MAX && PRINTABLE_ASCII_RE.test(t)) return t;
  return null;
}
export function clampRetentionDays(d: unknown): number {
  const n = typeof d === 'number' && Number.isFinite(d) ? d : RETENTION_DAYS_DEFAULT;
  return Math.max(RETENTION_DAYS_FLOOR, n);
}

// ── Schema ─────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbound_message_ids (
  sender_key    TEXT NOT NULL,
  message_id    TEXT NOT NULL,
  admitted_at   TEXT NOT NULL,
  attempt       TEXT NOT NULL,
  process_epoch TEXT NOT NULL,
  ingress       TEXT NOT NULL,
  thread_id     TEXT,
  disposition   TEXT NOT NULL,
  path          TEXT,
  readmissions  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (sender_key, message_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_ids_admitted ON inbound_message_ids(admitted_at);
CREATE INDEX IF NOT EXISTS idx_inbound_ids_unverified ON inbound_message_ids(disposition, admitted_at) WHERE sender_key LIKE 'unverified:%';
CREATE TABLE IF NOT EXISTS ledger_meta (key TEXT PRIMARY KEY, value TEXT);
`;

export interface InboundIdRow {
  sender_key: string;
  message_id: string;
  admitted_at: string;
  attempt: string;
  process_epoch: string;
  ingress: InboundIngress;
  thread_id: string | null;
  disposition: InboundDisposition;
  path: string | null;
  readmissions: number;
}

export function resolveInboundIdLedgerPath(stateDir: string, agentId: string): string {
  const safe = agentId.replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  return path.join(stateDir, 'state', `a2a-inbound-ids.${safe}.sqlite`);
}

// ── Counters ───────────────────────────────────────────────────────

/** Persistent counters (flushed to ledger_meta on their own timer). */
export const PERSISTENT_COUNTERS = [
  'dedupById', 'unkeyedInbound', 'staleAttemptWrite', 'waitDropped', 'waitCeilingReadmit',
  'unverifiedEvicted', 'unverifiedUnrecorded', 'unverifiedRefusedLogged', 'localRedelivered',
  'weakPathRedelivered', 'readmitted', 'handoffFailed', 'peerAnnotated',
] as const;
export type PersistentCounter = (typeof PERSISTENT_COUNTERS)[number];

export interface InboundIdLedgerCounters {
  [k: string]: unknown;
}

// ── Admission results ─────────────────────────────────────────────

export type AdmitResult =
  /** Deliver with no row (dark, unkeyed, cooldown, breaker, full unverified space, or a fail-open). */
  | { kind: 'unrecorded'; reason: 'unkeyed' | 'cooldown' | 'broken' | 'unverified-full' | 'closed'; ticket: AdmissionTicket }
  /** A single failed transaction outside a cooldown: HTTP 503; the socket fails open. */
  | { kind: 'error'; ticket: AdmissionTicket }
  /** A terminal row: drop / answer as a duplicate. `bare` = the local route's bare answer. */
  | { kind: 'duplicate'; row: InboundIdRow; bare: boolean }
  /** Admitted by a live attempt still in flight. */
  | { kind: 'in-flight'; row: InboundIdRow }
  | { kind: 'admitted'; ticket: AdmissionTicket; readmitted: boolean };

export interface AdmitRequest {
  senderKey: string | null;
  messageId: string | null | undefined;
  ingress: InboundIngress;
  threadId?: string | null;
  /**
   * Local route only: the verified fingerprint resolved from the AgentRegistry
   * (`registry:<fp>`). A TERMINAL verified row for it is answered bare.
   */
  verifiedKeyToConsult?: string | null;
  /** Re-admit over a live in-flight row (the socket wait timed out / hit a ceiling). */
  force?: boolean;
}

/** Settle information handed to a socket waiter. */
export interface SettleInfo { disposition: InboundDisposition | 'unknown'; path: string | null }

interface InFlightEntry {
  attempt: string;
  senderKey: string;
  waiting: boolean;
  settlers: Array<(s: SettleInfo) => void>;
}

export interface InboundIdLedgerOptions {
  /** Retention in days (floor 2). Read live per prune tick when a function. */
  retentionDays?: number | (() => number);
  /** logs/ directory for the unverified-namespace refusal trace. */
  logDir?: string | null;
  reportDegradation?: (d: { feature: string; primary: string; fallback: string; reason: string; impact: string }) => void;
  now?: () => number;
  /** Start the prune + counter-flush timers (default true; tests pass false). */
  startTimers?: boolean;
}

/**
 * A per-admission handle. The owning attempt records the outcome ONCE and calls
 * `finish()` in a `finally`; a superseded attempt finds a different token and
 * touches nothing.
 */
export class AdmissionTicket {
  private outcomeRecorded = false;
  private finished = false;
  private releasedHooks: Array<() => void> = [];
  /** Final disposition this attempt wrote (for the settle mapping). */
  private final: SettleInfo = { disposition: 'unknown', path: null };

  constructor(
    private readonly ledger: InboundIdLedger | null,
    readonly senderKey: string | null,
    readonly messageId: string | null,
    readonly attempt: string | null,
    readonly readmissions: number,
    readonly recorded: boolean,
  ) {}

  /** True when this admission wrote a row (a no-op ticket records nothing). */
  get hasRow(): boolean { return this.recorded; }

  /** Register a hook run only when a handoff-failed/refused write SUCCEEDED (relay-agent forget). */
  onReleased(fn: () => void): void { this.releasedHooks.push(fn); }

  recordHandoff(p: HandoffPath): void {
    if (!isHandoffPath(p)) { this.recordHandoffFailed(); return; }
    this.write('handed-off', p);
  }
  recordNoReply(): void { this.write('no-reply', null); }
  recordHandoffFailed(): void { this.write('handoff-failed', null); }
  recordRefused(code: RefusalCode): void { this.write('refused', null, code); }

  /**
   * Map a ThreadlineRouter result through the allowlist: an autonomy `block` is
   * a refusal; a result carrying a listed router `path` is a hand-off; ANYTHING
   * else is `handoff-failed`.
   */
  recordRouterResult(result: unknown): void {
    this.recordOutcome(outcomeFromRouterResult(result));
  }

  recordOutcome(o: InboundOutcome): void {
    switch (o.kind) {
      case 'handed-off': this.recordHandoff(o.path); return;
      case 'refused': this.recordRefused(o.code); return;
      case 'no-reply': this.recordNoReply(); return;
      default: this.recordHandoffFailed();
    }
  }

  /** Clear the in-flight entry; write `handoff-failed` if no outcome was recorded. */
  finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.outcomeRecorded) this.write('handoff-failed', null);
    if (this.ledger && this.senderKey && this.messageId && this.attempt) {
      this.ledger._release(this.senderKey, this.messageId, this.attempt, this.final);
    }
  }

  get outcome(): SettleInfo { return { ...this.final }; }

  private write(disposition: InboundDisposition, p: HandoffPath | null, code?: RefusalCode): void {
    if (this.outcomeRecorded) return;
    this.outcomeRecorded = true;
    this.final = { disposition, path: p };
    if (!this.ledger || !this.recorded || !this.senderKey || !this.messageId || !this.attempt) return;
    const ok = this.ledger._writeOutcome(this.senderKey, this.messageId, this.attempt, disposition, p, code);
    if (ok && (disposition === 'handoff-failed' || disposition === 'refused')) {
      for (const fn of this.releasedHooks) {
        try { fn(); } catch { /* @silent-fallback-ok — a release hook never breaks recording */ }
      }
    }
  }
}

export type InboundOutcome =
  | { kind: 'handed-off'; path: HandoffPath }
  | { kind: 'refused'; code: RefusalCode }
  | { kind: 'no-reply' }
  | { kind: 'handoff-failed' };

/** The allowlist applied to a router return (pure; exported for tests). */
export function outcomeFromRouterResult(result: unknown): InboundOutcome {
  if (!result || typeof result !== 'object') return { kind: 'handoff-failed' };
  const r = result as Record<string, unknown>;
  if (r.gateDecision === 'block') return { kind: 'refused', code: 'autonomy-block' };
  const p = r.path;
  if (isHandoffPath(p) && ROUTER_HANDOFF_PATHS.has(p)) return { kind: 'handed-off', path: p };
  return { kind: 'handoff-failed' };
}

// ── The ledger ─────────────────────────────────────────────────────

export class InboundIdLedger {
  readonly path: string;
  readonly processEpoch: string = crypto.randomUUID();
  private db: BetterSqliteDatabase | null;
  private unregister: (() => void) | undefined;
  private readonly opts: InboundIdLedgerOptions;
  private readonly now: () => number;

  private readonly inFlight = new Map<string, InFlightEntry>();
  private waitersTotal = 0;
  private readonly waitersBySender = new Map<string, number>();

  // DB-error cooldown + breaker (spec §1 "Fail direction").
  private cooldownUntil = 0;
  private cooldownMs = 0;
  private failedProbes = 0;
  private broken = false;

  // Prune scheduling.
  private pruneTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private pruneFailures = 0;
  private pruneBackoffMs = 0;
  private pruneBroken = false;

  // Counters: persistent ones are loaded from ledger_meta at open and flushed back.
  private readonly persistent: Record<PersistentCounter, number>;
  private readonly replayDroppedBySender = new Map<string, number>();
  private readonly peerCheckUnavailable = new Map<string, number>();
  /** In memory only — they record failures of the file they would be written to. */
  ledgerError = 0;
  postAcceptWriteFailed = 0;
  readonly deadEpochAdmittedAtBoot: number;

  private constructor(db: BetterSqliteDatabase, dbPath: string, opts: InboundIdLedgerOptions) {
    this.db = db;
    this.path = dbPath;
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.unregister = registerSqliteHandle(() => { try { this.db?.close(); } catch { /* already closed */ } });
    this.persistent = Object.fromEntries(PERSISTENT_COUNTERS.map((k) => [k, 0])) as Record<PersistentCounter, number>;
    try {
      const raw = (db.prepare(`SELECT value FROM ledger_meta WHERE key='counters'`).get() as { value?: string } | undefined)?.value;
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const k of PERSISTENT_COUNTERS) if (typeof parsed[k] === 'number') this.persistent[k] = parsed[k] as number;
      }
    } catch { /* @silent-fallback-ok — counters restart at zero on an unreadable meta row */ }
    // Rows left `admitted` by a process that died (every row predates this epoch).
    this.deadEpochAdmittedAtBoot = (db.prepare(`SELECT COUNT(*) AS n FROM inbound_message_ids WHERE disposition='admitted'`).get() as { n: number }).n;
    if (opts.startTimers !== false) this.startTimers();
  }

  static open(agentId: string, stateDir: string, opts: InboundIdLedgerOptions = {}): InboundIdLedger {
    const dbPath = resolveInboundIdLedgerPath(stateDir, agentId);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
      try { fs.chmodSync(dbPath, 0o600); } catch { /* best-effort */ }
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = NORMAL');
      db.pragma('busy_timeout = 1000');
      db.exec(SCHEMA);
    } catch (err) {
      try { db.close(); } catch { /* already closed */ }
      throw err;
    }
    return new InboundIdLedger(db, dbPath, { logDir: path.join(stateDir, '..', 'logs'), ...opts });
  }

  static openMemory(opts: InboundIdLedgerOptions = {}): InboundIdLedger {
    const db = new Database(':memory:');
    db.pragma('busy_timeout = 1000');
    db.exec(SCHEMA);
    return new InboundIdLedger(db, ':memory:', { startTimers: false, ...opts });
  }

  get isOpen(): boolean { return this.db !== null; }

  /** Operational = open, no DB-error cooldown in force, no breaker. Drives the capability. */
  isOperational(): boolean {
    return this.db !== null && !this.broken && this.now() >= this.cooldownUntil && this.cooldownMs === 0;
  }

  close(): void {
    if (!this.db) return;
    try { this.flushCounters(); } catch { /* @silent-fallback-ok — best-effort final flush */ }
    if (this.pruneTimer) { clearTimeout(this.pruneTimer); this.pruneTimer = null; }
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    try { this.unregister?.(); } catch { /* already unregistered */ }
    try { this.db.close(); } catch { /* already closed */ }
    this.db = null;
  }

  // ── Counters ────────────────────────────────────────────────────

  bump(k: PersistentCounter, n = 1): void { this.persistent[k] += n; }
  bumpReplayDropped(senderKey: string): void {
    this.replayDroppedBySender.set(senderKey, (this.replayDroppedBySender.get(senderKey) ?? 0) + 1);
  }
  bumpPeerCheckUnavailable(reason: string): void {
    this.peerCheckUnavailable.set(reason, (this.peerCheckUnavailable.get(reason) ?? 0) + 1);
  }

  counters(): InboundIdLedgerCounters {
    return {
      ...this.persistent,
      replayDropped: Object.fromEntries(this.replayDroppedBySender),
      peerCheckUnavailable: Object.fromEntries(this.peerCheckUnavailable),
      ledgerError: this.ledgerError,
      postAcceptWriteFailed: this.postAcceptWriteFailed,
      inFlight: this.inFlight.size,
      waiters: this.waitersTotal,
      deadEpochAdmittedAtBoot: this.deadEpochAdmittedAtBoot,
      operational: this.isOperational(),
      breaker: this.broken,
      pruneBreaker: this.pruneBroken,
    };
  }

  flushCounters(): void {
    if (!this.db) return;
    this.db.prepare(`INSERT INTO ledger_meta (key, value) VALUES ('counters', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(JSON.stringify(this.persistent));
  }

  // ── DB-error state machine ──────────────────────────────────────

  /** Returns the reason the ledger must be skipped right now, or null when usable. */
  private skipReason(): 'closed' | 'broken' | 'cooldown' | null {
    if (!this.db) return 'closed';
    if (this.broken) return 'broken';
    if (this.now() < this.cooldownUntil) return 'cooldown';
    return null;
  }

  /** A transaction succeeded: a pending probe resets the cooldown. */
  private onDbSuccess(): void {
    if (this.cooldownMs !== 0) { this.cooldownMs = 0; this.cooldownUntil = 0; this.failedProbes = 0; }
  }

  /**
   * A transaction failed. Returns true when this was a single failure OUTSIDE a
   * cooldown (the HTTP routes answer 503 once); false for a failed probe.
   */
  private onDbError(err: unknown): boolean {
    this.ledgerError++;
    const wasProbe = this.cooldownMs !== 0;
    if (!wasProbe) {
      this.cooldownMs = COOLDOWN_START_MS;
      this.cooldownUntil = this.now() + this.cooldownMs;
      return true;
    }
    this.failedProbes++;
    if (this.failedProbes >= PROBE_BREAKER_FAILURES) {
      this.broken = true;
      this.opts.reportDegradation?.({
        feature: 'threadline.inboundIdLedger',
        primary: 'durable inbound message-id ledger (dedup of agent-to-agent resends)',
        fallback: 'today\'s path: deliver with no row; the gate\'s in-memory replay map dedups',
        reason: `ledger database failed ${this.failedProbes} consecutive probes: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Resends are delivered again (labelled duplicates are not produced) until restart.',
      });
      return false;
    }
    this.cooldownMs = Math.min(this.cooldownMs * 2, COOLDOWN_MAX_MS);
    this.cooldownUntil = this.now() + this.cooldownMs;
    return false;
  }

  // ── Gate lookup (spec §1 "The gate consults the ledger") ────────

  lookup(senderKey: string, messageId: string | null | undefined): 'terminal' | 'retryable' | 'unavailable' {
    // Only an admission WRITE probes a cooling-down ledger: a read can succeed
    // while a lock still refuses writes, so a lookup never ends a cooldown.
    if (!this.isOperational()) return 'unavailable';
    if (!isValidMessageId(messageId)) return 'retryable';
    try {
      const row = this.db!.prepare(`SELECT disposition, path FROM inbound_message_ids WHERE sender_key=? AND message_id=?`)
        .get(senderKey, messageId) as { disposition: string; path: string | null } | undefined;
      if (!row) return 'retryable';
      return isTerminalRow(row) ? 'terminal' : 'retryable';
    } catch (err) {
      this.onDbError(err);
      return 'unavailable';
    }
  }

  /** Read one row (no state changes). Null when unknown or unreadable. */
  getRow(senderKey: string, messageId: string): InboundIdRow | null {
    if (this.skipReason()) return null;
    try {
      return (this.db!.prepare(`SELECT * FROM inbound_message_ids WHERE sender_key=? AND message_id=?`).get(senderKey, messageId) as InboundIdRow | undefined) ?? null;
    } catch { return null; }
  }

  /** Is the (key, id) in flight under ANY attempt of this process? */
  isInFlight(senderKey: string, messageId: string): boolean {
    return this.inFlight.has(this.keyOf(senderKey, messageId));
  }

  private keyOf(senderKey: string, messageId: string): string { return `${senderKey}\0${messageId}`; }

  // ── The commit point ────────────────────────────────────────────

  /**
   * The admission commit: one synchronous transaction that re-reads the row and
   * inserts or re-admits it, adding the in-flight entry in the same tick.
   */
  admit(req: AdmitRequest): AdmitResult {
    const noop = (reason: 'unkeyed' | 'cooldown' | 'broken' | 'unverified-full' | 'closed'): AdmitResult =>
      ({ kind: 'unrecorded', reason, ticket: new AdmissionTicket(null, null, null, null, 0, false) });

    if (!req.senderKey || !isValidMessageId(req.messageId)) {
      if (this.db) this.persistent.unkeyedInbound++;
      return noop('unkeyed');
    }
    const skip = this.skipReason();
    if (skip) return noop(skip);

    const senderKey = req.senderKey;
    const messageId = req.messageId;
    const threadId = sanitizeThreadId(req.threadId);
    const local = isLocalNamespace(senderKey);
    const key = this.keyOf(senderKey, messageId);
    const db = this.db!;

    type TxOut =
      | { t: 'duplicate'; row: InboundIdRow; bare: boolean }
      | { t: 'in-flight'; row: InboundIdRow }
      | { t: 'admitted'; attempt: string; readmissions: number; readmitted: boolean }
      | { t: 'full' };

    let out: TxOut;
    try {
      out = db.transaction((): TxOut => {
        // The local route: a TERMINAL verified row from the registry-resolved
        // fingerprint suppresses, bare. Never written or re-admitted here.
        if (local && req.verifiedKeyToConsult && senderKey.startsWith('registry:')) {
          const v = db.prepare(`SELECT * FROM inbound_message_ids WHERE sender_key=? AND message_id=?`)
            .get(req.verifiedKeyToConsult, messageId) as InboundIdRow | undefined;
          if (v && isVerifiedNamespace(v.sender_key) && isTerminalRow(v)) return { t: 'duplicate', row: v, bare: true };
        }
        const row = db.prepare(`SELECT * FROM inbound_message_ids WHERE sender_key=? AND message_id=?`)
          .get(senderKey, messageId) as InboundIdRow | undefined;
        const nowIso = new Date(this.now()).toISOString();
        const attempt = crypto.randomUUID();
        if (!row) {
          if (isUnverifiedNamespace(senderKey) && !this.makeUnverifiedRoom(senderKey)) return { t: 'full' };
          db.prepare(`INSERT INTO inbound_message_ids (sender_key, message_id, admitted_at, attempt, process_epoch, ingress, thread_id, disposition, path, readmissions)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 'admitted', NULL, 0) ON CONFLICT DO NOTHING`)
            .run(senderKey, messageId, nowIso, attempt, this.processEpoch, req.ingress, threadId);
          return { t: 'admitted', attempt, readmissions: 0, readmitted: false };
        }
        const cls = classifyExistingRow(row, { liveEpoch: this.processEpoch, inFlight: this.inFlight.has(key), localNamespace: local });
        if (cls === 'in-flight' && !req.force) return { t: 'in-flight', row };
        if (cls === 'terminal') return { t: 'duplicate', row, bare: false };
        db.prepare(`UPDATE inbound_message_ids SET attempt=?, process_epoch=?, readmissions=readmissions+1, disposition='admitted', path=NULL
                    WHERE sender_key=? AND message_id=?`)
          .run(attempt, this.processEpoch, senderKey, messageId);
        if (cls === 'local-readmit') this.persistent.localRedelivered++;
        else if (cls === 'weak-readmit') this.persistent.weakPathRedelivered++;
        this.persistent.readmitted++;
        return { t: 'admitted', attempt, readmissions: row.readmissions + 1, readmitted: true };
      }).immediate();
      this.onDbSuccess();
    } catch (err) {
      const single = this.onDbError(err);
      const ticket = new AdmissionTicket(null, null, null, null, 0, false);
      return single ? { kind: 'error', ticket } : { kind: 'unrecorded', reason: 'cooldown', ticket };
    }

    if (out.t === 'full') {
      this.persistent.unverifiedUnrecorded++;
      return noop('unverified-full');
    }
    if (out.t === 'duplicate') return { kind: 'duplicate', row: out.row, bare: out.bare };
    if (out.t === 'in-flight') return { kind: 'in-flight', row: out.row };

    // In-flight entry, added in the same synchronous tick, owned by this attempt.
    // A forced re-admission replaces the prior attempt's entry; the prior
    // attempt's later `finish()` finds a different token and touches nothing.
    const superseded = this.inFlight.get(key);
    this.inFlight.set(key, { attempt: out.attempt, senderKey, waiting: false, settlers: [] });
    // Release any waiter parked on the superseded attempt at once (it re-runs
    // admission and fails toward delivery) instead of letting it sit out 30 s.
    if (superseded) {
      for (const st of superseded.settlers) { try { st({ disposition: 'unknown', path: null }); } catch { /* never propagates */ } }
    }
    const ticket = new AdmissionTicket(this, senderKey, messageId, out.attempt, out.readmissions, true);
    return { kind: 'admitted', ticket, readmitted: out.readmitted };
  }

  /**
   * Make room for a new `unverified:` row (caps: 1,000 namespace-wide, 50 per
   * sender). Eviction order: handoff-failed, then admitted dead-epoch / not in
   * flight, then the oldest terminal row. False when nothing is evictable.
   * Runs inside the admission transaction.
   */
  private makeUnverifiedRoom(senderKey: string): boolean {
    const db = this.db!;
    const per = (db.prepare(`SELECT COUNT(*) AS n FROM inbound_message_ids WHERE sender_key=?`).get(senderKey) as { n: number }).n;
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM inbound_message_ids WHERE sender_key LIKE 'unverified:%'`).get() as { n: number }).n;
    if (per < UNVERIFIED_PER_SENDER_CAP && total < UNVERIFIED_TOTAL_CAP) return true;
    const scopeSql = per >= UNVERIFIED_PER_SENDER_CAP ? `sender_key = ?` : `sender_key LIKE 'unverified:%'`;
    const params = per >= UNVERIFIED_PER_SENDER_CAP ? [senderKey] : [];
    const tiers: Array<(r: InboundIdRow) => boolean> = [
      (r) => r.disposition === 'handoff-failed',
      (r) => r.disposition === 'admitted' && (r.process_epoch !== this.processEpoch || !this.inFlight.has(this.keyOf(r.sender_key, r.message_id))),
      (r) => r.disposition === 'no-reply' || r.disposition === 'handed-off' || r.disposition === 'refused',
    ];
    const candidates = db.prepare(`SELECT * FROM inbound_message_ids WHERE ${scopeSql} AND sender_key LIKE 'unverified:%' ORDER BY admitted_at ASC`).all(...params) as InboundIdRow[];
    for (const tier of tiers) {
      const victim = candidates.find(tier);
      if (victim) {
        db.prepare(`DELETE FROM inbound_message_ids WHERE sender_key=? AND message_id=?`).run(victim.sender_key, victim.message_id);
        this.persistent.unverifiedEvicted++;
        return true;
      }
    }
    return false;
  }

  // ── Post-commit writes (all conditional on the attempt) ─────────

  /** @internal — called by AdmissionTicket. Returns true when the row changed. */
  _writeOutcome(senderKey: string, messageId: string, attempt: string, disposition: InboundDisposition, p: HandoffPath | null, code?: RefusalCode): boolean {
    if (!this.db) { this.postAcceptWriteFailed++; return false; }
    try {
      let changes: number;
      if (disposition === 'refused' && isUnverifiedNamespace(senderKey)) {
        // Refusals never fill the unverified cap: remove the row, trace instead.
        changes = this.db.prepare(`DELETE FROM inbound_message_ids WHERE sender_key=? AND message_id=? AND attempt=?`)
          .run(senderKey, messageId, attempt).changes;
        if (changes > 0) this.traceUnverifiedRefusal(senderKey, messageId, code ?? 'autonomy-block');
      } else {
        changes = this.db.prepare(`UPDATE inbound_message_ids SET disposition=?, path=? WHERE sender_key=? AND message_id=? AND attempt=?`)
          .run(disposition, p, senderKey, messageId, attempt).changes;
      }
      if (changes === 0) { this.persistent.staleAttemptWrite++; return false; }
      if (disposition === 'handoff-failed') this.persistent.handoffFailed++;
      return true;
    } catch {
      this.postAcceptWriteFailed++;
      return false;
    }
  }

  /** @internal — clear the in-flight entry iff this attempt owns it, then settle waiters. */
  _release(senderKey: string, messageId: string, attempt: string, final: SettleInfo): void {
    const key = this.keyOf(senderKey, messageId);
    const entry = this.inFlight.get(key);
    if (!entry || entry.attempt !== attempt) return; // superseded: touch nothing
    this.inFlight.delete(key);
    for (const s of entry.settlers) { try { s(final); } catch { /* waiter errors never propagate */ } }
  }

  // ── The relay-socket in-flight wait ─────────────────────────────

  /**
   * Wait for the in-flight original of (key, id) to settle. Bounded: one waiter
   * per key (a second is dropped — the first covers the loss case), 8 per
   * sender, 256 process-wide (above either ceiling the duplicate is re-admitted
   * at once), 30 s.
   */
  async waitForSettle(senderKey: string, messageId: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<'settled' | 'timeout' | 'ceiling' | 'dropped'> {
    const key = this.keyOf(senderKey, messageId);
    const entry = this.inFlight.get(key);
    if (!entry) return 'settled';
    if (entry.waiting) { this.persistent.waitDropped++; return 'dropped'; }
    const perSender = this.waitersBySender.get(senderKey) ?? 0;
    if (perSender >= WAIT_PER_SENDER_CAP || this.waitersTotal >= WAIT_PROCESS_CAP) {
      this.persistent.waitCeilingReadmit++;
      return 'ceiling';
    }
    entry.waiting = true;
    this.waitersTotal++;
    this.waitersBySender.set(senderKey, perSender + 1);
    try {
      return await new Promise<'settled' | 'timeout'>((resolve) => {
        const timer = setTimeout(() => resolve('timeout'), timeoutMs);
        timer.unref?.();
        entry.settlers.push(() => { clearTimeout(timer); resolve('settled'); });
      });
    } finally {
      this.waitersTotal--;
      const n = (this.waitersBySender.get(senderKey) ?? 1) - 1;
      if (n <= 0) this.waitersBySender.delete(senderKey); else this.waitersBySender.set(senderKey, n);
      const cur = this.inFlight.get(key);
      if (cur) cur.waiting = false;
    }
  }

  // ── Refusal trace (unverified namespace) ────────────────────────

  private refusalLogPath(): string | null {
    return this.opts.logDir ? path.join(this.opts.logDir, 'a2a-inbound-refusals.jsonl') : null;
  }

  private traceUnverifiedRefusal(senderKey: string, messageId: string, code: RefusalCode): void {
    this.persistent.unverifiedRefusedLogged++;
    const p = this.refusalLogPath();
    if (!p) return;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      try {
        if (fs.statSync(p).size >= REFUSAL_LOG_MAX_BYTES) rotateFile(p);
      } catch { /* no file yet */ }
      fs.appendFileSync(p, JSON.stringify({
        at: new Date(this.now()).toISOString(),
        sender_key: JSON.stringify(senderKey),
        message_id: JSON.stringify(messageId),
        reason: code,
      }) + '\n', { mode: 0o600 });
    } catch { /* @silent-fallback-ok — the trace is observability; the counter still records it */ }
  }

  /** Age-prune the refusal log files (rotated + active) past retention. */
  private pruneRefusalLogs(retentionMs: number): void {
    const p = this.refusalLogPath();
    if (!p) return;
    for (const f of [p, `${p}.1`, `${p}.2`]) {
      try {
        const st = fs.statSync(f);
        if (this.now() - st.mtimeMs > retentionMs) SafeFsExecutor.safeUnlinkSync(f, { operation: 'InboundIdLedger.pruneRefusalLogs' });
      } catch { /* absent */ }
    }
  }

  // ── Retention prune ─────────────────────────────────────────────

  retentionDays(): number {
    const r = this.opts.retentionDays;
    return clampRetentionDays(typeof r === 'function' ? r() : r);
  }

  /** One prune tick: batches of 500 until a short batch, at most 20 per tick. Throws on a DB error. */
  pruneOnce(): number {
    if (!this.db) return 0;
    const retentionMs = this.retentionDays() * 24 * 60 * 60_000;
    const cutoff = new Date(this.now() - retentionMs).toISOString();
    const stmt = this.db.prepare(`DELETE FROM inbound_message_ids WHERE rowid IN (SELECT rowid FROM inbound_message_ids WHERE admitted_at < ? LIMIT ${PRUNE_BATCH})`);
    let total = 0;
    for (let i = 0; i < PRUNE_MAX_BATCHES; i++) {
      const n = stmt.run(cutoff).changes;
      total += n;
      if (n < PRUNE_BATCH) break;
    }
    this.pruneRefusalLogs(retentionMs);
    return total;
  }

  /** Run one scheduled tick with backoff + breaker accounting (exported for tests). */
  runPruneTick(): number {
    try {
      const n = this.pruneOnce();
      this.pruneFailures = 0;
      this.pruneBackoffMs = 0;
      return n;
    } catch (err) {
      this.pruneFailures++;
      this.pruneBackoffMs = this.pruneBackoffMs === 0 ? PRUNE_BACKOFF_START_MS : Math.min(this.pruneBackoffMs * 2, PRUNE_BACKOFF_MAX_MS);
      if (this.pruneFailures >= PRUNE_BREAKER_TICKS) {
        this.pruneBroken = true;
        this.opts.reportDegradation?.({
          feature: 'threadline.inboundIdLedger.prune',
          primary: 'bounded retention prune of the inbound message-id ledger',
          fallback: 'prune stopped until restart; the table simply grows',
          reason: err instanceof Error ? err.message : String(err),
          impact: 'Nothing else depends on the prune; disk use grows until restart.',
        });
      }
      return -1;
    }
  }

  get pruneState(): { failures: number; backoffMs: number; broken: boolean } {
    return { failures: this.pruneFailures, backoffMs: this.pruneBackoffMs, broken: this.pruneBroken };
  }

  private startTimers(): void {
    const schedule = (delay: number) => {
      if (!this.db || this.pruneBroken) return;
      this.pruneTimer = setTimeout(() => {
        this.runPruneTick();
        if (this.pruneBroken) return;
        schedule(this.pruneBackoffMs || PRUNE_INTERVAL_MS);
      }, delay);
      this.pruneTimer.unref?.();
    };
    schedule(PRUNE_INTERVAL_MS);
    // Counters flush on their OWN timer — never on the hot path, never only on prune.
    this.flushTimer = setInterval(() => { try { this.flushCounters(); } catch { /* @silent-fallback-ok — next tick retries */ } }, COUNTER_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  // ── Read route ──────────────────────────────────────────────────

  read(senderKey: string | null, messageId: string, limit = 20): InboundIdRow[] {
    if (!this.db) return [];
    if (senderKey) {
      const r = this.db.prepare(`SELECT * FROM inbound_message_ids WHERE sender_key=? AND message_id=?`).get(senderKey, messageId) as InboundIdRow | undefined;
      return r ? [r] : [];
    }
    return this.db.prepare(`SELECT * FROM inbound_message_ids WHERE message_id=? ORDER BY admitted_at ASC LIMIT ?`).all(messageId, limit) as InboundIdRow[];
  }

  /** Test helper: inject a DB failure on the next N transactions. */
  _testBreakDb(): void {
    if (this.db) { try { this.db.close(); } catch { /* */ } }
    // Replace with a closed handle so every statement throws.
    const dead = new Database(':memory:');
    dead.close();
    this.db = dead;
  }
}

function rotateFile(p: string): void {
  try { fs.renameSync(`${p}.1`, `${p}.2`); } catch { /* absent */ }
  try { fs.renameSync(p, `${p}.1`); } catch { /* absent */ }
}

// ── Controller (live flips) ───────────────────────────────────────

/**
 * Owns the ledger's lifetime against a LIVE enabled flag: opened at boot when
 * the feature resolves on, opened lazily on the first ingress after a live
 * false→true flip, closed (timers stopped) on a live true→false flip. A file
 * that cannot be opened leaves the ledger dark with one degradation.
 */
export class InboundIdLedgerController {
  private ledger: InboundIdLedger | null = null;
  private openFailed = false;

  constructor(private readonly deps: {
    isEnabled: () => boolean;
    open: () => InboundIdLedger;
    reportDegradation?: InboundIdLedgerOptions['reportDegradation'];
  }) {}

  /** The live ledger, or null when dark (flips handled here). */
  current(): InboundIdLedger | null {
    let enabled = false;
    try { enabled = this.deps.isEnabled(); } catch { enabled = false; }
    if (!enabled) {
      if (this.ledger) { this.ledger.close(); this.ledger = null; }
      this.openFailed = false;
      return null;
    }
    if (this.ledger) return this.ledger;
    if (this.openFailed) return null;
    try {
      this.ledger = this.deps.open();
    } catch (err) {
      this.openFailed = true;
      this.deps.reportDegradation?.({
        feature: 'threadline.inboundIdLedger',
        primary: 'durable inbound message-id ledger',
        fallback: 'ledger dark — today\'s in-memory replay dedup',
        reason: `could not open the ledger file: ${err instanceof Error ? err.message : String(err)}`,
        impact: 'Resends are not recognised durably; behaviour is unchanged from before the ledger.',
      });
      return null;
    }
    return this.ledger;
  }

  /** The ledger if already open, without triggering a lazy open. */
  peek(): InboundIdLedger | null { return this.ledger; }

  close(): void { if (this.ledger) { this.ledger.close(); this.ledger = null; } }
}

// ── Config resolution ─────────────────────────────────────────────

export interface InboundIdLedgerConfigBlock { enabled?: boolean; retentionDays?: number }

/**
 * `threadline.inboundIdLedger.enabled` omitted ⇒ the development-agent gate
 * (live on a dev agent, dark on the fleet). Mirrors resolveDevAgentGate.
 */
export function resolveInboundIdLedgerEnabled(block: InboundIdLedgerConfigBlock | undefined | null, developmentAgent: boolean | undefined): boolean {
  return block?.enabled ?? !!developmentAgent;
}

/**
 * Build the production controller. `readBlock` is read LIVE on every ingress so
 * a config flip opens lazily / closes cleanly without a restart.
 */
export function buildInboundIdLedgerController(deps: {
  stateDir: string;
  agentId: string;
  developmentAgent: boolean | undefined;
  readBlock: () => InboundIdLedgerConfigBlock | undefined | null;
  reportDegradation?: InboundIdLedgerOptions['reportDegradation'];
}): InboundIdLedgerController {
  return new InboundIdLedgerController({
    isEnabled: () => resolveInboundIdLedgerEnabled(deps.readBlock(), deps.developmentAgent),
    open: () => InboundIdLedger.open(deps.agentId, deps.stateDir, {
      retentionDays: () => clampRetentionDays(deps.readBlock()?.retentionDays),
      reportDegradation: deps.reportDegradation,
    }),
    reportDegradation: deps.reportDegradation,
  });
}
