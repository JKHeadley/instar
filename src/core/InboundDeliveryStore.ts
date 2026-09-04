/**
 * Crash-durable evidence for physical tmux input effects.
 *
 * This store deliberately records what is known, not what a successful API
 * return is hoped to mean. `*-started` is committed with FULL durability
 * immediately before mutation; a process restart converts unterminated starts
 * to `effect-unknown`, which is never automatically replayable.
 */
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { registerSqliteHandle } from './SqliteRegistry.js';
import {
  decryptFromSync,
  encryptForSync,
  type EncryptedSecretPayload,
} from './SecretStore.js';
import { DEFAULT_INBOUND_QUEUE_CONFIG, type InboundQueueConfig } from './inboundQueueConfig.js';

export type DeliveryTransportState =
  | 'prepared' | 'dispatch-armed' | 'dispatch-started'
  | 'dispatched' | 'consumed' | 'dispatch-failed' | 'effect-unknown';
export type AttemptState = 'attempt-armed' | 'attempt-started' | 'attempted' | 'effect-unknown';
export type DeliveryComposerState = 'unobserved' | 'present' | 'cleared' | 'unknown';
export type DeliveryTranscriptState = 'unseen' | 'consumed' | 'responded' | 'unknown';
export type DeliveryEligibilityState = 'open' | 'keypress-exhausted' | 'superseded' | 'continuity-lost' | 'unknown';

export interface DeliveryEvidence {
  schemaVersion: number;
  conversationId: string;
  deliveryId: string;
  ordinal: number;
  incarnation: string;
  framework: string;
  envelopeHmac: string;
  envelopeBytes: number;
  ownerMachineId: string;
  ownerEpoch: number;
  transferState: 'local' | 'exported' | 'imported';
  transportState: DeliveryTransportState;
  composerState: DeliveryComposerState;
  transcriptState: DeliveryTranscriptState;
  eligibilityState: DeliveryEligibilityState;
  rolloutPath: string | null;
  rolloutId: string | null;
  baselineOffset: number;
  observedOffset: number;
  scanTurnId: string | null;
  turnId: string | null;
  observationDeadline: number;
  composerClearedAt: number | null;
  consumedAt: number | null;
  respondedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface InboundDeliveryStoreOptions {
  maxLiveRows?: number;
  maxLiveRowsPerConversation?: number;
  maxLiveBytes?: number;
  maxPayloadBytes?: number;
  terminalRowsPerConversation?: number;
  terminalTtlMs?: number;
  maxLogicalRows?: number;
  maxDatabaseBytes?: number;
  gcBatchRows?: number;
  gcBudgetMs?: number;
  now?: () => number;
  /** Includes SQLite main + WAL bytes. Injectable for deterministic tests. */
  sizeProbe?: () => number;
}

export type InboundBackpressureReason = 'conversation-busy' | 'live-row-limit' | 'live-byte-limit' | 'storage-breaker';

export class InboundDeliveryBackpressureError extends Error {
  readonly code = 'INBOUND_DELIVERY_BACKPRESSURE';
  constructor(readonly reason: InboundBackpressureReason) {
    super(`Inbound delivery admission refused: ${reason}`);
    this.name = 'InboundDeliveryBackpressureError';
  }
}

export class InboundDeliveryStoreUnavailableError extends Error {
  readonly code = 'INBOUND_DELIVERY_STORE_UNAVAILABLE';
  constructor(readonly reason: 'startup-schema-failed' | 'startup-full-failed', detail: string) {
    super(`Inbound delivery store unavailable (${reason}): ${detail}`);
    this.name = 'InboundDeliveryStoreUnavailableError';
  }
}

export interface InboundDeliveryStoreStatus {
  deliveriesByState: Record<string, number>;
  attemptsByState: Record<string, number>;
  uncertainEffects: number;
  liveRows: number;
  liveBytes: number;
  logicalRows: number;
  databaseBytes: number;
  breaker: { open: boolean; epoch: number; reason: string | null };
  verification: {
    dispatched: number; composerCleared: number; consumed: number; responded: number;
    avgDispatchToClearMs: number | null; avgDispatchToConsumeMs: number | null; avgDispatchToRespondMs: number | null;
  };
  lastGc: { at: number; deletedRows: number; elapsedMs: number } | null;
}

export interface RolloutWork {
  rolloutId: string;
  rolloutPath: string;
  observedOffset: number;
  activeTurnId: string | null;
  eventSequence: number;
  oldestDeadline: number;
}

export type RolloutEvent =
  | { kind: 'task-started'; turnId: string; through: number }
  | { kind: 'user-message'; turnId: string; envelopeHmac: string; through: number }
  | { kind: 'assistant-message'; turnId: string; through: number }
  | { kind: 'task-complete'; turnId: string; through: number };

export interface InboundDeliveryNotice {
  conversationId: string;
  deliveryId: string;
  kind: 'superseded';
  createdAt: number;
}

export interface DeliveryRecoverySnapshot {
  conversationId: string;
  deliveryId: string;
  ownerEpoch: number;
  latestOrdinal: number;
  deliveryOrdinal: number;
  incarnation: string;
  deliveryExhausted: boolean;
  breakerOpen: boolean;
}

interface DeliveryTransferRow {
  schemaVersion: 2;
  deliveryId: string;
  ordinal: number;
  incarnation: string;
  framework: string;
  envelope: string;
  envelopeHmac: string;
  transportState: DeliveryTransportState;
  composerState: DeliveryComposerState;
  transcriptState: DeliveryTranscriptState;
  eligibilityState: DeliveryEligibilityState;
  rolloutId: string | null;
  baselineOffset: number;
  observedOffset: number;
  scanTurnId: string | null;
  turnId: string | null;
  observationDeadline: number;
  composerClearedAt: number | null;
  consumedAt: number | null;
  respondedAt: number | null;
  createdAt: number;
  updatedAt: number;
  attempts: Array<{ attemptIndex: number; state: AttemptState; createdAt: number; updatedAt: number }>;
}

export interface DeliveryTransferSnapshot {
  schemaVersion: 1;
  conversationId: string;
  sourceMachineId: string;
  sourceEpoch: number;
  targetMachineId: string;
  transferEpoch: number;
  activeEpoch: number;
  rows: DeliveryTransferRow[];
}

export interface EncryptedDeliveryTransfer {
  schemaVersion: 1;
  encrypted: EncryptedSecretPayload;
  rowCount: number;
}

const DEFAULT_OPTIONS: Required<Omit<InboundDeliveryStoreOptions, 'sizeProbe'>> = {
  maxLiveRows: 100,
  maxLiveRowsPerConversation: 10,
  maxLiveBytes: 100 * (256 * 1024 + 512),
  maxPayloadBytes: 256 * 1024,
  terminalRowsPerConversation: 20,
  terminalTtlMs: 24 * 60 * 60 * 1_000,
  maxLogicalRows: 100_000,
  maxDatabaseBytes: 256 * 1024 * 1024,
  gcBatchRows: 500,
  gcBudgetMs: 25,
  now: Date.now,
};

export function inboundDeliveryStoreOptionsFromQueue(
  queue: Partial<InboundQueueConfig> | null | undefined,
): Pick<InboundDeliveryStoreOptions, 'maxLiveRows' | 'maxLiveRowsPerConversation' | 'maxLiveBytes' | 'maxPayloadBytes'> {
  if (queue?.enabled !== true) return {
    maxLiveRows: 100, maxLiveRowsPerConversation: 10,
    maxPayloadBytes: 256 * 1024, maxLiveBytes: 100 * (256 * 1024 + 512),
  };
  const resolved = { ...DEFAULT_INBOUND_QUEUE_CONFIG, ...queue };
  const global = Math.max(1, Math.min(resolved.maxTotal, resolved.hardMaxTotal));
  const payload = Math.max(1, resolved.maxPayloadBytes);
  return {
    maxLiveRows: global,
    maxLiveRowsPerConversation: Math.max(1, resolved.maxPerSession),
    maxPayloadBytes: payload,
    maxLiveBytes: global * (payload + 512),
  };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS inbound_delivery (
  schema_version INTEGER NOT NULL DEFAULT 2,
  conversation_id TEXT NOT NULL, delivery_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
  incarnation TEXT NOT NULL, framework TEXT NOT NULL, envelope_hmac TEXT NOT NULL,
  envelope_bytes INTEGER NOT NULL, replay_envelope TEXT,
  owner_machine_id TEXT NOT NULL DEFAULT 'local', owner_epoch INTEGER NOT NULL DEFAULT 0,
  transfer_state TEXT NOT NULL DEFAULT 'local', transport_state TEXT NOT NULL,
  composer_state TEXT NOT NULL DEFAULT 'unobserved', transcript_state TEXT NOT NULL DEFAULT 'unseen',
  eligibility_state TEXT NOT NULL DEFAULT 'open', rollout_path TEXT, rollout_id TEXT,
  baseline_offset INTEGER NOT NULL DEFAULT -1, observed_offset INTEGER NOT NULL DEFAULT -1, scan_turn_id TEXT,
  turn_id TEXT, assistant_seen INTEGER NOT NULL DEFAULT 0, observation_deadline INTEGER NOT NULL DEFAULT 0,
  composer_cleared_at INTEGER, consumed_at INTEGER, responded_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, delivery_id), UNIQUE (conversation_id, ordinal)
);
CREATE TABLE IF NOT EXISTS inbound_attempt (
  conversation_id TEXT NOT NULL, delivery_id TEXT NOT NULL, attempt_index INTEGER NOT NULL,
  state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, delivery_id, attempt_index),
  FOREIGN KEY (conversation_id, delivery_id)
    REFERENCES inbound_delivery(conversation_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_inbound_delivery_live
  ON inbound_delivery(conversation_id, transport_state, ordinal);
CREATE TABLE IF NOT EXISTS inbound_delivery_control (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), breaker_epoch INTEGER NOT NULL DEFAULT 0,
  breaker_open INTEGER NOT NULL DEFAULT 0, breaker_reason TEXT, updated_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO inbound_delivery_control(singleton, updated_at) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS inbound_rollout_cursor (
  rollout_id TEXT NOT NULL, rollout_path TEXT NOT NULL, observed_offset INTEGER NOT NULL,
  active_turn_id TEXT, event_sequence INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (rollout_id, rollout_path)
);
CREATE TABLE IF NOT EXISTS inbound_rollout_successor_authority (
  conversation_id TEXT NOT NULL, delivery_id TEXT NOT NULL, predecessor_rollout_id TEXT NOT NULL,
  target_machine_id TEXT NOT NULL, owner_epoch INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, used_at INTEGER,
  PRIMARY KEY (conversation_id, delivery_id)
);
CREATE TABLE IF NOT EXISTS inbound_delivery_notice (
  conversation_id TEXT NOT NULL, delivery_id TEXT NOT NULL, kind TEXT NOT NULL,
  created_at INTEGER NOT NULL, delivered_at INTEGER,
  PRIMARY KEY (conversation_id, delivery_id, kind)
);
CREATE TABLE IF NOT EXISTS inbound_observer_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1), consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0, episode_id TEXT, notified INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO inbound_observer_state(singleton) VALUES (1);
CREATE TABLE IF NOT EXISTS inbound_observer_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, outcome TEXT NOT NULL, started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL, rows_examined INTEGER NOT NULL, bytes_read INTEGER NOT NULL,
  error_class TEXT
);
CREATE TABLE IF NOT EXISTS inbound_observer_notice (
  episode_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, delivered_at INTEGER
);
`;

export class InboundDeliveryStore {
  private readonly db: BetterSqliteDatabase;
  private readonly options: Required<Omit<InboundDeliveryStoreOptions, 'sizeProbe'>>;
  private readonly sizeProbe: () => number;
  private lastGc: InboundDeliveryStoreStatus['lastGc'] = null;

  private constructor(db: BetterSqliteDatabase, options: InboundDeliveryStoreOptions, dbPath?: string) {
    this.db = db;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.sizeProbe = options.sizeProbe ?? (() => {
      if (!dbPath) return 0;
      const size = (file: string) => { try { return fs.statSync(file).size; } catch { /* @silent-fallback-ok: absent SQLite sidecar is zero bytes */ return 0; } };
      return size(dbPath) + size(`${dbPath}-wal`);
    });
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 1000');
    db.exec(SCHEMA);
    ensureDeliveryColumns(db);
    registerSqliteHandle(() => { try { db.close(); } catch { /* already closed */ } });
  }

  static open(stateDir: string, options: InboundDeliveryStoreOptions = {}): InboundDeliveryStore {
    const dbPath = path.join(stateDir, 'state', 'inbound-delivery.sqlite');
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    const db = new Database(dbPath);
    try { fs.chmodSync(dbPath, 0o600); } catch { /* best effort on non-POSIX */ }
    try {
      db.pragma('journal_mode = WAL');
      db.pragma('synchronous = FULL');
      const store = new InboundDeliveryStore(db, options, dbPath);
      const readiness = store.startupReadiness();
      if (!readiness.schema || readiness.journalMode.toLowerCase() !== 'wal') {
        store.close();
        throw new InboundDeliveryStoreUnavailableError('startup-schema-failed',
          `schema=${readiness.schema} journal=${readiness.journalMode}`);
      }
      if (readiness.synchronous !== 2) {
        store.close();
        throw new InboundDeliveryStoreUnavailableError('startup-full-failed',
          `synchronous=${readiness.synchronous}`);
      }
      return store;
    } catch (error) {
      try { if (db.open) db.close(); } catch { /* already closed */ }
      if (error instanceof InboundDeliveryStoreUnavailableError) throw error;
      throw new InboundDeliveryStoreUnavailableError('startup-schema-failed',
        error instanceof Error ? error.message : String(error));
    }
  }

  static openMemory(options: InboundDeliveryStoreOptions = {}): InboundDeliveryStore {
    const db = new Database(':memory:');
    db.pragma('synchronous = FULL');
    return new InboundDeliveryStore(db, options);
  }

  prepare(input: {
    conversationId: string; deliveryId?: string; incarnation: string;
    framework: string; envelope: string; hmacKey: string;
    ownerMachineId?: string; ownerEpoch?: number;
  }): DeliveryEvidence {
    const deliveryId = input.deliveryId ?? crypto.randomUUID();
    const normalized = input.envelope.normalize('NFC').replace(/\r\n?/g, '\n').replace(/\n$/, '');
    const hmac = crypto.createHmac('sha256', input.hmacKey).update(normalized).digest('hex');
    const now = this.options.now();
    let refusal: InboundBackpressureReason | null = null;
    const tx = this.db.transaction(() => {
      const control = this.db.prepare('SELECT breaker_open FROM inbound_delivery_control WHERE singleton = 1').get() as { breaker_open: number };
      if (control.breaker_open === 1) { refusal = 'storage-breaker'; return; }
      const logical = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM inbound_delivery) + (SELECT COUNT(*) FROM inbound_attempt) AS rows`).get() as { rows: number };
      const databaseBytes = this.safeSizeProbe();
      const breakerReason = Number(logical.rows) >= this.options.maxLogicalRows ? 'logical-row-limit'
        : databaseBytes >= this.options.maxDatabaseBytes ? 'database-byte-limit' : null;
      if (breakerReason) {
        this.db.prepare(`UPDATE inbound_delivery_control SET breaker_open = 1,
          breaker_epoch = breaker_epoch + 1, breaker_reason = ?, updated_at = ? WHERE singleton = 1`)
          .run(breakerReason, now);
        refusal = 'storage-breaker';
        return;
      }
      const live = this.db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(envelope_bytes), 0) AS bytes
        FROM inbound_delivery WHERE transport_state NOT IN ('consumed','dispatch-failed','effect-unknown')`)
        .get() as { rows: number; bytes: number };
      const incomingBytes = Buffer.byteLength(normalized);
      const conversationLive = this.db.prepare(`SELECT COUNT(*) AS rows FROM inbound_delivery
        WHERE conversation_id = ? AND transport_state NOT IN ('consumed','dispatch-failed','effect-unknown')`)
        .get(input.conversationId) as { rows: number };
      if (Number(conversationLive.rows) >= this.options.maxLiveRowsPerConversation) {
        refusal = 'conversation-busy';
        return;
      }
      if (Number(live.rows) >= this.options.maxLiveRows) {
        refusal = 'live-row-limit';
        return;
      }
      if (incomingBytes > this.options.maxPayloadBytes || Number(live.bytes) + incomingBytes > this.options.maxLiveBytes) {
        refusal = 'live-byte-limit';
        return;
      }
      const next = this.db.prepare(
        'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM inbound_delivery WHERE conversation_id = ?',
      ).get(input.conversationId) as { ordinal: number };
      this.db.prepare(`INSERT INTO inbound_delivery
        (schema_version, conversation_id, delivery_id, ordinal, incarnation, framework, envelope_hmac,
         envelope_bytes, replay_envelope, owner_machine_id, owner_epoch, transfer_state,
         transport_state, composer_state, transcript_state, eligibility_state,
         observation_deadline, created_at, updated_at)
        VALUES (2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local', 'prepared', 'unobserved', 'unseen', 'open', ?, ?, ?)`)
        .run(input.conversationId, deliveryId, next.ordinal, input.incarnation,
          input.framework, hmac, incomingBytes, sealEnvelope(normalized, input.hmacKey),
          input.ownerMachineId ?? 'local', normalizeOwnerEpoch(input.ownerEpoch), now + 15 * 60_000, now, now);
    });
    tx.immediate();
    if (refusal) throw new InboundDeliveryBackpressureError(refusal);
    return this.get(input.conversationId, deliveryId)!;
  }

  transition(conversationId: string, deliveryId: string, from: DeliveryTransportState, to: DeliveryTransportState): boolean {
    const allowed: Record<DeliveryTransportState, DeliveryTransportState[]> = {
      prepared: ['dispatch-armed', 'dispatch-failed'],
      'dispatch-armed': ['dispatch-started', 'dispatch-failed'],
      'dispatch-started': ['dispatched', 'effect-unknown'],
      dispatched: ['consumed', 'effect-unknown'],
      consumed: [], 'dispatch-failed': [], 'effect-unknown': [],
    };
    if (!allowed[from].includes(to)) return false;
    const now = this.options.now();
    const tx = this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE inbound_delivery SET transport_state = ?, updated_at = ?
        WHERE conversation_id = ? AND delivery_id = ? AND transport_state = ?`)
        .run(to, now, conversationId, deliveryId, from).changes === 1;
      if (!changed || to !== 'dispatched') return changed;
      const current = this.db.prepare(`SELECT ordinal FROM inbound_delivery
        WHERE conversation_id = ? AND delivery_id = ?`).get(conversationId, deliveryId) as { ordinal: number } | undefined;
      if (!current) throw new Error('dispatched delivery lost inside transition transaction');
      // A newer dispatched ordinal permanently wins over an older exhausted
      // draft. This is the sole FIFO supersession authority; immutable attempt
      // evidence remains attached to the superseded row.
      const superseded = this.db.prepare(`SELECT delivery_id FROM inbound_delivery
        WHERE conversation_id = ? AND ordinal < ? AND eligibility_state = 'keypress-exhausted'`)
        .all(conversationId, current.ordinal) as Array<{ delivery_id: string }>;
      this.db.prepare(`UPDATE inbound_delivery SET eligibility_state = 'superseded', updated_at = ?
        WHERE conversation_id = ? AND ordinal < ? AND eligibility_state = 'keypress-exhausted'`)
        .run(now, conversationId, current.ordinal);
      const notice = this.db.prepare(`INSERT OR IGNORE INTO inbound_delivery_notice
        (conversation_id, delivery_id, kind, created_at) VALUES (?, ?, 'superseded', ?)`);
      for (const row of superseded) notice.run(conversationId, row.delivery_id, now);
      return true;
    });
    return tx.immediate();
  }

  armAttempt(conversationId: string, deliveryId: string, attemptIndex: number): boolean {
    if (!Number.isInteger(attemptIndex) || attemptIndex < 0 || attemptIndex > 3) return false;
    const now = this.options.now();
    let armed = false;
    const tx = this.db.transaction(() => {
      const row = this.get(conversationId, deliveryId);
      if (!row || row.transportState !== 'dispatched') return;
      const control = this.db.prepare('SELECT breaker_open FROM inbound_delivery_control WHERE singleton = 1').get() as { breaker_open: number };
      if (control.breaker_open === 1) return;
      const logical = this.db.prepare(`SELECT
        (SELECT COUNT(*) FROM inbound_delivery) + (SELECT COUNT(*) FROM inbound_attempt) AS rows`).get() as { rows: number };
      const breakerReason = Number(logical.rows) >= this.options.maxLogicalRows ? 'logical-row-limit'
        : this.safeSizeProbe() >= this.options.maxDatabaseBytes ? 'database-byte-limit' : null;
      if (breakerReason) {
        this.db.prepare(`UPDATE inbound_delivery_control SET breaker_open = 1,
          breaker_epoch = breaker_epoch + 1, breaker_reason = ?, updated_at = ? WHERE singleton = 1`)
          .run(breakerReason, now);
        return;
      }
      armed = this.db.prepare(`INSERT OR IGNORE INTO inbound_attempt
        (conversation_id, delivery_id, attempt_index, state, created_at, updated_at)
        VALUES (?, ?, ?, 'attempt-armed', ?, ?)`)
        .run(conversationId, deliveryId, attemptIndex, now, now).changes === 1;
    });
    tx.immediate();
    return armed;
  }

  transitionAttempt(conversationId: string, deliveryId: string, attemptIndex: number, from: AttemptState, to: AttemptState): boolean {
    const allowed = (from === 'attempt-armed' && to === 'attempt-started')
      || (from === 'attempt-started' && (to === 'attempted' || to === 'effect-unknown'));
    if (!allowed) return false;
    return this.db.prepare(`UPDATE inbound_attempt SET state = ?, updated_at = ?
      WHERE conversation_id = ? AND delivery_id = ? AND attempt_index = ? AND state = ?`)
      .run(to, this.options.now(), conversationId, deliveryId, attemptIndex, from).changes === 1;
  }

  reconcileInterruptedEffects(): { deliveries: number; attempts: number } {
    const now = this.options.now();
    const tx = this.db.transaction(() => {
      const deliveries = this.db.prepare(`UPDATE inbound_delivery SET transport_state = 'effect-unknown', updated_at = ?
        WHERE transport_state = 'dispatch-started'`).run(now).changes;
      const attempts = this.db.prepare(`UPDATE inbound_attempt SET state = 'effect-unknown', updated_at = ?
        WHERE state = 'attempt-started'`).run(now).changes;
      return { deliveries, attempts };
    });
    return tx.immediate();
  }

  hasUnreconciledEffects(conversationId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM inbound_delivery d
      WHERE d.conversation_id = ? AND (
        d.transport_state = 'dispatch-started' OR EXISTS (
          SELECT 1 FROM inbound_attempt a WHERE a.conversation_id = d.conversation_id
            AND a.delivery_id = d.delivery_id AND a.state = 'attempt-started'
        )
      ) LIMIT 1`).get(conversationId);
    return row !== undefined;
  }

  get(conversationId: string, deliveryId: string): DeliveryEvidence | null {
    const row = this.db.prepare(`SELECT * FROM inbound_delivery
      WHERE conversation_id = ? AND delivery_id = ?`).get(conversationId, deliveryId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      schemaVersion: Number(row.schema_version),
      conversationId: String(row.conversation_id), deliveryId: String(row.delivery_id),
      ordinal: Number(row.ordinal), incarnation: String(row.incarnation), framework: String(row.framework),
      envelopeHmac: String(row.envelope_hmac), envelopeBytes: Number(row.envelope_bytes),
      ownerMachineId: String(row.owner_machine_id), ownerEpoch: Number(row.owner_epoch),
      transferState: row.transfer_state as DeliveryEvidence['transferState'],
      transportState: row.transport_state as DeliveryTransportState,
      composerState: row.composer_state as DeliveryComposerState,
      transcriptState: row.transcript_state as DeliveryTranscriptState,
      eligibilityState: row.eligibility_state as DeliveryEligibilityState,
      rolloutPath: row.rollout_path == null ? null : String(row.rollout_path),
      rolloutId: row.rollout_id == null ? null : String(row.rollout_id),
      baselineOffset: Number(row.baseline_offset), observedOffset: Number(row.observed_offset),
      scanTurnId: row.scan_turn_id == null ? null : String(row.scan_turn_id),
      turnId: row.turn_id == null ? null : String(row.turn_id),
      observationDeadline: Number(row.observation_deadline),
      composerClearedAt: row.composer_cleared_at == null ? null : Number(row.composer_cleared_at),
      consumedAt: row.consumed_at == null ? null : Number(row.consumed_at),
      respondedAt: row.responded_at == null ? null : Number(row.responded_at),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    };
  }

  hasOtherActiveDispatch(conversationId: string, deliveryId: string): boolean {
    return this.db.prepare(`SELECT 1 FROM inbound_delivery WHERE conversation_id = ? AND delivery_id != ?
      AND transport_state IN ('dispatch-armed','dispatch-started','dispatched')
      AND eligibility_state = 'open' AND transcript_state != 'responded' LIMIT 1`)
      .get(conversationId, deliveryId) !== undefined;
  }

  dispatchablePrepared(limit = 4): DeliveryEvidence[] {
    const safeLimit = Math.max(1, Math.min(this.options.maxLiveRows, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT d.conversation_id, d.delivery_id FROM inbound_delivery d
      WHERE d.transport_state = 'prepared' AND d.eligibility_state = 'open'
        AND d.framework = 'codex-cli'
        AND NOT EXISTS (SELECT 1 FROM inbound_delivery active
          WHERE active.conversation_id = d.conversation_id AND active.delivery_id != d.delivery_id
            AND active.transport_state IN ('dispatch-armed','dispatch-started','dispatched')
            AND active.eligibility_state = 'open' AND active.transcript_state != 'responded')
      ORDER BY d.created_at ASC, d.ordinal ASC LIMIT ?`)
      .all(safeLimit) as Array<{ conversation_id: string; delivery_id: string }>;
    return rows.map((row) => this.get(row.conversation_id, row.delivery_id)).filter((row): row is DeliveryEvidence => row !== null);
  }

  openReplayEnvelope(conversationId: string, deliveryId: string, localHmacKey: string): string | null {
    const row = this.db.prepare(`SELECT replay_envelope, envelope_hmac FROM inbound_delivery
      WHERE conversation_id = ? AND delivery_id = ? AND transport_state = 'prepared'`)
      .get(conversationId, deliveryId) as { replay_envelope: string | null; envelope_hmac: string } | undefined;
    if (!row?.replay_envelope) return null;
    const envelope = unsealEnvelope(row.replay_envelope, localHmacKey);
    const actual = crypto.createHmac('sha256', localHmacKey).update(envelope).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(row.envelope_hmac, 'hex'))) return null;
    return envelope;
  }

  bindRolloutBaseline(conversationId: string, deliveryId: string, rolloutPath: string, rolloutId: string, baselineOffset: number): boolean {
    if (!path.isAbsolute(rolloutPath) || !rolloutId || !Number.isSafeInteger(baselineOffset) || baselineOffset < 0) return false;
    const now = this.options.now();
    const tx = this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE inbound_delivery SET rollout_path = ?, rollout_id = ?, baseline_offset = ?, observed_offset = ?, updated_at = ?
        WHERE conversation_id = ? AND delivery_id = ? AND transport_state IN ('prepared','dispatch-armed')
          AND rollout_path IS NULL AND rollout_id IS NULL`).run(rolloutPath, rolloutId, baselineOffset, baselineOffset, now, conversationId, deliveryId).changes === 1;
      if (changed) this.db.prepare(`INSERT OR IGNORE INTO inbound_rollout_cursor
        (rollout_id, rollout_path, observed_offset, active_turn_id, event_sequence, updated_at)
        VALUES (?, ?, ?, NULL, 0, ?)`).run(rolloutId, rolloutPath, baselineOffset, now);
      return changed;
    });
    return tx.immediate();
  }

  /** Bind a fresh Codex incarnation whose first tracked bootstrap created the
   * rollout itself. Offset zero is safe only for a local, already-dispatched
   * row that was explicitly recorded without any pre-existing rollout. */
  bindBootstrapRollout(conversationId: string, deliveryId: string, rolloutPath: string, rolloutId: string): boolean {
    if (!path.isAbsolute(rolloutPath) || !rolloutId) return false;
    const now = this.options.now();
    const tx = this.db.transaction(() => {
      const changed = this.db.prepare(`UPDATE inbound_delivery
        SET rollout_path = ?, rollout_id = ?, baseline_offset = 0, observed_offset = 0, updated_at = ?
        WHERE conversation_id = ? AND delivery_id = ? AND framework = 'codex-cli'
          AND transfer_state = 'local' AND transport_state = 'dispatched'
          AND rollout_path IS NULL AND rollout_id IS NULL AND baseline_offset = -1 AND observed_offset = -1`)
        .run(rolloutPath, rolloutId, now, conversationId, deliveryId).changes === 1;
      if (changed) this.db.prepare(`INSERT OR IGNORE INTO inbound_rollout_cursor
        (rollout_id, rollout_path, observed_offset, active_turn_id, event_sequence, updated_at)
        VALUES (?, ?, 0, NULL, 0, ?)`).run(rolloutId, rolloutPath, now);
      return changed;
    });
    return tx.immediate();
  }

  bindImportedRolloutPath(conversationId: string, deliveryId: string, rolloutPath: string): boolean {
    if (!path.isAbsolute(rolloutPath)) return false;
    return this.db.prepare(`UPDATE inbound_delivery SET rollout_path = ?, updated_at = ?
      WHERE conversation_id = ? AND delivery_id = ? AND rollout_path IS NULL AND baseline_offset >= 0`)
      .run(rolloutPath, this.options.now(), conversationId, deliveryId).changes === 1;
  }

  /** Consume source-authenticated transfer authority to bind the target's
   * incarnation-pinned successor. No untransferred/local row can mint this. */
  bindImportedRolloutSuccessor(input: {
    conversationId: string; deliveryId: string; targetMachineId: string; ownerEpoch: number;
    incarnation: string; rolloutPath: string; rolloutId: string; baselineOffset: number;
  }): boolean {
    if (!path.isAbsolute(input.rolloutPath) || !input.rolloutId || !input.incarnation
      || !Number.isSafeInteger(input.ownerEpoch) || !Number.isSafeInteger(input.baselineOffset)
      || input.baselineOffset < 0) return false;
    const now = this.options.now();
    const tx = this.db.transaction(() => {
      const authority = this.db.prepare(`SELECT predecessor_rollout_id FROM inbound_rollout_successor_authority
        WHERE conversation_id = ? AND delivery_id = ? AND target_machine_id = ? AND owner_epoch = ? AND used = 0`)
        .get(input.conversationId, input.deliveryId, input.targetMachineId, input.ownerEpoch) as { predecessor_rollout_id: string } | undefined;
      if (!authority) return false;
      const row = this.get(input.conversationId, input.deliveryId);
      if (!row || row.transferState !== 'imported' || row.ownerMachineId !== input.targetMachineId
        || row.ownerEpoch !== input.ownerEpoch || row.rolloutId !== authority.predecessor_rollout_id
        || input.rolloutId !== authority.predecessor_rollout_id) return false;
      const changed = this.db.prepare(`UPDATE inbound_delivery SET incarnation = ?, rollout_path = ?, rollout_id = ?,
          baseline_offset = ?, observed_offset = ?, scan_turn_id = NULL, updated_at = ?
        WHERE conversation_id = ? AND delivery_id = ? AND transfer_state = 'imported'
          AND owner_machine_id = ? AND owner_epoch = ? AND rollout_path IS NULL`)
        .run(input.incarnation, input.rolloutPath, input.rolloutId, input.baselineOffset, input.baselineOffset, now,
          input.conversationId, input.deliveryId, input.targetMachineId, input.ownerEpoch).changes === 1;
      if (!changed) return false;
      this.db.prepare(`INSERT OR IGNORE INTO inbound_rollout_cursor
        (rollout_id, rollout_path, observed_offset, active_turn_id, event_sequence, updated_at)
        VALUES (?, ?, ?, ?, 0, ?)`).run(input.rolloutId, input.rolloutPath, input.baselineOffset,
          row.transcriptState === 'consumed' ? row.turnId : null, now);
      this.db.prepare(`UPDATE inbound_rollout_successor_authority SET used = 1, used_at = ?
        WHERE conversation_id = ? AND delivery_id = ? AND used = 0`)
        .run(now, input.conversationId, input.deliveryId);
      return true;
    });
    return tx.immediate();
  }

  observableDeliveries(limit = 20): DeliveryEvidence[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const rows = this.db.prepare(`SELECT conversation_id, delivery_id FROM inbound_delivery
      WHERE transport_state IN ('dispatched','consumed') AND eligibility_state = 'open'
        AND transcript_state NOT IN ('responded','unknown')
      ORDER BY observation_deadline ASC, ordinal ASC LIMIT ?`).all(safeLimit) as Array<{ conversation_id: string; delivery_id: string }>;
    return rows.map((row) => this.get(row.conversation_id, row.delivery_id)).filter((row): row is DeliveryEvidence => row !== null);
  }

  rolloutWork(limit = 20): RolloutWork[] {
    const safeLimit = Math.max(1, Math.min(this.options.maxLiveRows, Math.floor(limit)));
    return (this.db.prepare(`SELECT c.rollout_id, c.rollout_path, c.observed_offset,
        c.active_turn_id, c.event_sequence, MIN(d.observation_deadline) AS oldest_deadline
      FROM inbound_rollout_cursor c JOIN inbound_delivery d
        ON d.rollout_id = c.rollout_id AND d.rollout_path = c.rollout_path
      WHERE d.transport_state IN ('dispatched','consumed') AND d.eligibility_state = 'open'
        AND d.transcript_state NOT IN ('responded','unknown')
      GROUP BY c.rollout_id, c.rollout_path
      ORDER BY oldest_deadline ASC, c.rollout_id ASC LIMIT ?`).all(safeLimit) as Array<Record<string, unknown>>)
      .map((row) => ({
        rolloutId: String(row.rollout_id), rolloutPath: String(row.rollout_path),
        observedOffset: Number(row.observed_offset), activeTurnId: row.active_turn_id == null ? null : String(row.active_turn_id),
        eventSequence: Number(row.event_sequence), oldestDeadline: Number(row.oldest_deadline),
      }));
  }

  applyRolloutEvents(work: RolloutWork, events: RolloutEvent[], observedThrough: number): boolean {
    if (!Number.isSafeInteger(observedThrough) || observedThrough < work.observedOffset) return false;
    const now = this.options.now();
    const tx = this.db.transaction(() => {
      const cursor = this.db.prepare(`SELECT observed_offset, active_turn_id, event_sequence
        FROM inbound_rollout_cursor WHERE rollout_id = ? AND rollout_path = ?`)
        .get(work.rolloutId, work.rolloutPath) as Record<string, unknown> | undefined;
      if (!cursor || Number(cursor.observed_offset) !== work.observedOffset
        || Number(cursor.event_sequence) !== work.eventSequence
        || (cursor.active_turn_id == null ? null : String(cursor.active_turn_id)) !== work.activeTurnId) return false;
      let activeTurn = work.activeTurnId;
      let sequence = work.eventSequence;
      for (const event of events) {
        sequence += 1;
        if (event.kind === 'task-started') {
          if (activeTurn !== null) return false;
          activeTurn = event.turnId;
        } else if (event.kind === 'user-message') {
          if (activeTurn !== event.turnId) return false;
          const matches = this.db.prepare(`SELECT conversation_id, delivery_id FROM inbound_delivery
            WHERE rollout_id = ? AND rollout_path = ? AND transport_state = 'dispatched'
              AND transcript_state = 'unseen' AND eligibility_state = 'open'
              AND baseline_offset < ? AND envelope_hmac = ? ORDER BY baseline_offset ASC, ordinal ASC`)
            .all(work.rolloutId, work.rolloutPath, event.through, event.envelopeHmac) as Array<{ conversation_id: string; delivery_id: string }>;
          if (matches.length > 1) return false;
          if (matches.length === 1) this.recordTranscriptConsumed(matches[0].conversation_id, matches[0].delivery_id, event.turnId, event.through);
        } else if (event.kind === 'assistant-message') {
          if (activeTurn !== event.turnId) return false;
          this.db.prepare(`UPDATE inbound_delivery SET assistant_seen = 1, updated_at = ?
            WHERE rollout_id = ? AND rollout_path = ? AND transcript_state = 'consumed' AND turn_id = ?`)
            .run(now, work.rolloutId, work.rolloutPath, event.turnId);
        } else {
          if (activeTurn !== event.turnId) return false;
          this.db.prepare(`UPDATE inbound_delivery SET transcript_state = 'responded', transport_state = 'consumed',
              observed_offset = ?, responded_at = COALESCE(responded_at, ?), updated_at = ?
            WHERE rollout_id = ? AND rollout_path = ? AND transcript_state = 'consumed'
              AND turn_id = ? AND assistant_seen = 1`)
            .run(event.through, now, now, work.rolloutId, work.rolloutPath, event.turnId);
          activeTurn = null;
        }
      }
      return this.db.prepare(`UPDATE inbound_rollout_cursor SET observed_offset = ?, active_turn_id = ?,
          event_sequence = ?, updated_at = ? WHERE rollout_id = ? AND rollout_path = ?
          AND observed_offset = ? AND event_sequence = ?`)
        .run(observedThrough, activeTurn, sequence, now, work.rolloutId, work.rolloutPath,
          work.observedOffset, work.eventSequence).changes === 1;
    });
    return tx.immediate();
  }

  markRolloutUnknown(rolloutId: string, rolloutPath: string): number {
    return this.db.prepare(`UPDATE inbound_delivery SET transport_state = 'effect-unknown',
        transcript_state = 'unknown', eligibility_state = 'unknown',
        composer_state = CASE WHEN composer_state = 'cleared' THEN composer_state ELSE 'unknown' END, updated_at = ?
      WHERE rollout_id = ? AND rollout_path = ? AND transport_state = 'dispatched'
        AND transcript_state IN ('unseen','consumed') AND eligibility_state = 'open'`)
      .run(this.options.now(), rolloutId, rolloutPath).changes;
  }

  observerSweepAllowed(now = this.options.now()): boolean {
    const row = this.db.prepare('SELECT next_attempt_at FROM inbound_observer_state WHERE singleton = 1')
      .get() as { next_attempt_at: number };
    return now >= Number(row.next_attempt_at);
  }

  recordObserverSweepSuccess(meta: { startedAt: number; endedAt: number; rows: number; bytes: number }): void {
    const tx = this.db.transaction(() => {
      this.insertObserverAudit('success', meta, null);
      this.db.prepare(`UPDATE inbound_observer_state SET consecutive_failures = 0,
        next_attempt_at = 0, episode_id = NULL, notified = 0, updated_at = ? WHERE singleton = 1`)
        .run(meta.endedAt);
    });
    tx.immediate();
  }

  recordObserverSweepFailure(meta: {
    startedAt: number; endedAt: number; rows: number; bytes: number; errorClass: string;
  }): { nextAttemptAt: number; notify: boolean; episodeId: string } {
    let result = { nextAttemptAt: meta.endedAt, notify: false, episodeId: '' };
    const tx = this.db.transaction(() => {
      const prior = this.db.prepare(`SELECT consecutive_failures, episode_id, notified
        FROM inbound_observer_state WHERE singleton = 1`).get() as {
          consecutive_failures: number; episode_id: string | null; notified: number;
        };
      const failures = Number(prior.consecutive_failures) + 1;
      const delays = [10_000, 30_000, 90_000, 270_000];
      const nextAttemptAt = meta.endedAt + delays[Math.min(failures - 1, delays.length - 1)];
      const episodeId = prior.episode_id ?? crypto.randomUUID();
      const notify = failures >= delays.length && prior.notified === 0;
      this.insertObserverAudit('failure', meta, meta.errorClass.slice(0, 120));
      this.db.prepare(`UPDATE inbound_observer_state SET consecutive_failures = ?, next_attempt_at = ?,
        episode_id = ?, notified = ?, updated_at = ? WHERE singleton = 1`)
        .run(failures, nextAttemptAt, episodeId, notify || prior.notified === 1 ? 1 : 0, meta.endedAt);
      if (notify) this.db.prepare(`INSERT OR IGNORE INTO inbound_observer_notice
        (episode_id, created_at, delivered_at) VALUES (?, ?, NULL)`).run(episodeId, meta.endedAt);
      result = { nextAttemptAt, notify, episodeId };
    });
    tx.immediate();
    return result;
  }

  observerWorkerStatus(): {
    consecutiveFailures: number; nextAttemptAt: number; episodeId: string | null; notified: boolean;
  } {
    const row = this.db.prepare(`SELECT consecutive_failures, next_attempt_at, episode_id, notified
      FROM inbound_observer_state WHERE singleton = 1`).get() as {
        consecutive_failures: number; next_attempt_at: number; episode_id: string | null; notified: number;
      };
    return {
      consecutiveFailures: Number(row.consecutive_failures), nextAttemptAt: Number(row.next_attempt_at),
      episodeId: row.episode_id, notified: row.notified === 1,
    };
  }

  pendingObserverNotices(limit = 10): Array<{ episodeId: string; createdAt: number }> {
    return (this.db.prepare(`SELECT episode_id, created_at FROM inbound_observer_notice
      WHERE delivered_at IS NULL ORDER BY created_at ASC LIMIT ?`)
      .all(Math.max(1, Math.min(100, limit))) as Array<{ episode_id: string; created_at: number }>)
      .map((row) => ({ episodeId: row.episode_id, createdAt: Number(row.created_at) }));
  }

  markObserverNoticeDelivered(episodeId: string): boolean {
    return this.db.prepare(`UPDATE inbound_observer_notice SET delivered_at = ?
      WHERE episode_id = ? AND delivered_at IS NULL`).run(this.options.now(), episodeId).changes === 1;
  }

  observerAudit(limit = 100): Array<{
    outcome: string; startedAt: number; endedAt: number; rows: number; bytes: number; errorClass: string | null;
  }> {
    return (this.db.prepare(`SELECT outcome, started_at, ended_at, rows_examined, bytes_read, error_class
      FROM inbound_observer_audit ORDER BY id DESC LIMIT ?`).all(Math.max(1, Math.min(1_000, limit))) as Array<Record<string, unknown>>)
      .map((row) => ({ outcome: String(row.outcome), startedAt: Number(row.started_at), endedAt: Number(row.ended_at),
        rows: Number(row.rows_examined), bytes: Number(row.bytes_read), errorClass: row.error_class === null ? null : String(row.error_class) }));
  }

  observerSelfHeal(): boolean {
    try {
      const ready = this.startupReadiness();
      if (!ready.schema || ready.journalMode.toLowerCase() !== 'wal' || ready.synchronous !== 2) return false;
      this.db.pragma('wal_checkpoint(PASSIVE)');
      return true;
    } catch { // @silent-fallback-ok: false is the typed self-heal failure result; the observer episode remains durable
      return false;
    }
  }

  pendingNotices(limit = 20): InboundDeliveryNotice[] {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return (this.db.prepare(`SELECT conversation_id, delivery_id, kind, created_at
      FROM inbound_delivery_notice WHERE delivered_at IS NULL ORDER BY created_at ASC LIMIT ?`)
      .all(safeLimit) as Array<Record<string, unknown>>).map((row) => ({
        conversationId: String(row.conversation_id), deliveryId: String(row.delivery_id),
        kind: 'superseded', createdAt: Number(row.created_at),
      }));
  }

  markNoticeDelivered(notice: InboundDeliveryNotice): boolean {
    return this.db.prepare(`UPDATE inbound_delivery_notice SET delivered_at = ?
      WHERE conversation_id = ? AND delivery_id = ? AND kind = ? AND delivered_at IS NULL`)
      .run(this.options.now(), notice.conversationId, notice.deliveryId, notice.kind).changes === 1;
  }

  recordComposerState(conversationId: string, deliveryId: string, state: 'present' | 'cleared' | 'unknown'): boolean {
    const allowed = state === 'present' ? "composer_state IN ('unobserved','present')"
      : state === 'cleared' ? "composer_state IN ('unobserved','present','cleared')"
        : "composer_state IN ('unobserved','present')";
    return this.db.prepare(`UPDATE inbound_delivery SET composer_state = ?,
      composer_cleared_at = CASE WHEN ? = 'cleared' THEN COALESCE(composer_cleared_at, ?) ELSE composer_cleared_at END,
      updated_at = ?
      WHERE conversation_id = ? AND delivery_id = ? AND transport_state = 'dispatched'
        AND eligibility_state = 'open' AND ${allowed}`)
      .run(state, state, this.options.now(), this.options.now(), conversationId, deliveryId).changes === 1;
  }

  recordScanProgress(conversationId: string, deliveryId: string, observedOffset: number, activeTurnId: string | null): boolean {
    if (!Number.isSafeInteger(observedOffset) || observedOffset < 0) return false;
    return this.db.prepare(`UPDATE inbound_delivery SET observed_offset = ?, scan_turn_id = ?, updated_at = ?
      WHERE conversation_id = ? AND delivery_id = ? AND transport_state = 'dispatched'
        AND transcript_state = 'unseen' AND observed_offset <= ?`)
      .run(observedOffset, activeTurnId, this.options.now(), conversationId, deliveryId, observedOffset).changes === 1;
  }

  recordTranscriptConsumed(conversationId: string, deliveryId: string, turnId: string, observedOffset: number): boolean {
    if (!turnId || !Number.isSafeInteger(observedOffset) || observedOffset < 0) return false;
    return this.db.prepare(`UPDATE inbound_delivery SET composer_state = 'cleared', transcript_state = 'consumed',
      turn_id = ?, scan_turn_id = NULL, observed_offset = ?, updated_at = ?
      , composer_cleared_at = COALESCE(composer_cleared_at, ?), consumed_at = COALESCE(consumed_at, ?)
      WHERE conversation_id = ? AND delivery_id = ? AND transport_state = 'dispatched'
        AND transcript_state = 'unseen' AND eligibility_state = 'open'`)
      .run(turnId, observedOffset, this.options.now(), this.options.now(), this.options.now(), conversationId, deliveryId).changes === 1;
  }

  recordResponded(conversationId: string, deliveryId: string, turnId: string, observedOffset: number): boolean {
    if (!turnId || !Number.isSafeInteger(observedOffset) || observedOffset < 0) return false;
    return this.db.prepare(`UPDATE inbound_delivery SET transcript_state = 'responded', transport_state = 'consumed', observed_offset = ?,
      responded_at = COALESCE(responded_at, ?), updated_at = ?
      WHERE conversation_id = ? AND delivery_id = ? AND transport_state = 'dispatched'
        AND transcript_state = 'consumed' AND turn_id = ?`)
      .run(observedOffset, this.options.now(), this.options.now(), conversationId, deliveryId, turnId).changes === 1;
  }

  markObservationUnknown(conversationId: string, deliveryId: string): boolean {
    // The observation deadline is terminal for automatic handling. Keeping the
    // transport state as `dispatched` made these typed-unknown, non-replayable
    // rows count against the live admission ceiling forever. Preserve the
    // uncertainty explicitly as `effect-unknown`, which is both terminal and
    // retained by the normal evidence GC policy.
    return this.db.prepare(`UPDATE inbound_delivery SET transport_state = 'effect-unknown',
      transcript_state = 'unknown', eligibility_state = 'unknown',
      composer_state = CASE WHEN composer_state = 'cleared' THEN composer_state ELSE 'unknown' END, updated_at = ?
      WHERE conversation_id = ? AND delivery_id = ? AND transport_state = 'dispatched'
        AND transcript_state IN ('unseen','consumed') AND eligibility_state = 'open'`)
      .run(this.options.now(), conversationId, deliveryId).changes === 1;
  }

  markKeypressExhausted(conversationId: string, deliveryId: string): boolean {
    return this.db.prepare(`UPDATE inbound_delivery SET eligibility_state = 'keypress-exhausted', updated_at = ?
      WHERE conversation_id = ? AND delivery_id = ? AND transport_state = 'dispatched'
        AND composer_state = 'present' AND eligibility_state = 'open'
        AND (SELECT COUNT(*) FROM inbound_attempt WHERE conversation_id = ? AND delivery_id = ?
          AND state IN ('attempted','effect-unknown')) >= 4`)
      .run(this.options.now(), conversationId, deliveryId, conversationId, deliveryId).changes === 1;
  }

  terminalize(conversationId: string, deliveryId: string): boolean {
    return this.transition(conversationId, deliveryId, 'dispatched', 'consumed');
  }

  /**
   * Fence all still-live evidence to a newer owner before a topic/session move.
   * The CAS makes a stale source unable to keep acting after the transfer epoch.
   */
  transferLiveRows(conversationId: string, fromMachineId: string, fromEpoch: number,
    toMachineId: string, toEpoch: number): number {
    if (!toMachineId || !Number.isSafeInteger(toEpoch) || toEpoch <= fromEpoch) return 0;
    return this.db.prepare(`UPDATE inbound_delivery
      SET owner_machine_id = ?, owner_epoch = ?, transfer_state = 'exported', updated_at = ?
      WHERE conversation_id = ? AND owner_machine_id = ? AND owner_epoch = ?
        AND transport_state NOT IN ('consumed','dispatch-failed','effect-unknown')`)
      .run(toMachineId, toEpoch, this.options.now(), conversationId, fromMachineId, fromEpoch).changes;
  }

  /**
   * Atomically snapshot and fence the source's live rows. Replay bodies leave
   * this machine only inside a recipient-bound X25519/AES-GCM envelope.
   */
  exportLiveRows(input: {
    conversationId: string;
    sourceMachineId: string;
    sourceEpoch: number;
    targetMachineId: string;
    transferEpoch: number;
    activeEpoch: number;
    localHmacKey: string;
    targetEncryptionPublicKey: string;
  }): EncryptedDeliveryTransfer {
    if (!input.targetMachineId || input.transferEpoch <= input.sourceEpoch || input.activeEpoch <= input.transferEpoch) {
      throw new Error('invalid delivery transfer epochs');
    }
    const tx = this.db.transaction(() => {
      // A transfer is also an incarnation boundary. Any effect that was
      // started but not durably completed remains source-side uncertainty and
      // is never made replayable on the target.
      const now = this.options.now();
      this.db.prepare(`UPDATE inbound_attempt SET state = 'effect-unknown', updated_at = ?
        WHERE conversation_id = ? AND state = 'attempt-started'
          AND delivery_id IN (SELECT delivery_id FROM inbound_delivery
            WHERE conversation_id = ? AND owner_machine_id = ? AND owner_epoch = ?)`)
        .run(now, input.conversationId, input.conversationId, input.sourceMachineId, input.sourceEpoch);
      this.db.prepare(`UPDATE inbound_delivery SET transport_state = 'effect-unknown', updated_at = ?
        WHERE conversation_id = ? AND owner_machine_id = ? AND owner_epoch = ?
          AND transport_state = 'dispatch-started'`)
        .run(now, input.conversationId, input.sourceMachineId, input.sourceEpoch);
      const raw = this.db.prepare(`SELECT * FROM inbound_delivery
        WHERE conversation_id = ? AND owner_machine_id = ? AND owner_epoch = ?
          AND transfer_state IN ('local','imported')
          AND transport_state NOT IN ('consumed','dispatch-failed','effect-unknown')
        ORDER BY ordinal ASC`).all(input.conversationId, input.sourceMachineId, input.sourceEpoch) as Array<Record<string, unknown>>;
      const attempts = this.db.prepare(`SELECT attempt_index, state, created_at, updated_at FROM inbound_attempt
        WHERE conversation_id = ? AND delivery_id = ? ORDER BY attempt_index ASC`);
      const rows: DeliveryTransferRow[] = raw.map((row) => {
        const envelope = unsealEnvelope(String(row.replay_envelope ?? ''), input.localHmacKey);
        const expected = crypto.createHmac('sha256', input.localHmacKey).update(envelope).digest('hex');
        if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(String(row.envelope_hmac), 'hex'))) {
          throw new Error(`delivery envelope integrity mismatch for ${String(row.delivery_id)}`);
        }
        return {
          schemaVersion: 2,
          deliveryId: String(row.delivery_id),
          ordinal: Number(row.ordinal),
          incarnation: String(row.incarnation),
          framework: String(row.framework),
          envelope,
          envelopeHmac: expected,
          transportState: row.transport_state as DeliveryTransportState,
          composerState: row.composer_state as DeliveryComposerState,
          transcriptState: row.transcript_state as DeliveryTranscriptState,
          eligibilityState: row.eligibility_state as DeliveryEligibilityState,
          rolloutId: row.rollout_id == null ? null : String(row.rollout_id),
          baselineOffset: Number(row.baseline_offset), observedOffset: Number(row.observed_offset),
          scanTurnId: row.scan_turn_id == null ? null : String(row.scan_turn_id),
          turnId: row.turn_id == null ? null : String(row.turn_id),
          observationDeadline: Number(row.observation_deadline),
          composerClearedAt: row.composer_cleared_at == null ? null : Number(row.composer_cleared_at),
          consumedAt: row.consumed_at == null ? null : Number(row.consumed_at),
          respondedAt: row.responded_at == null ? null : Number(row.responded_at),
          createdAt: Number(row.created_at),
          updatedAt: Number(row.updated_at),
          attempts: (attempts.all(input.conversationId, String(row.delivery_id)) as Array<Record<string, unknown>>).map((a) => ({
            attemptIndex: Number(a.attempt_index), state: a.state as AttemptState,
            createdAt: Number(a.created_at), updatedAt: Number(a.updated_at),
          })),
        };
      });
      const snapshot: DeliveryTransferSnapshot = {
        schemaVersion: 1,
        conversationId: input.conversationId,
        sourceMachineId: input.sourceMachineId,
        sourceEpoch: input.sourceEpoch,
        targetMachineId: input.targetMachineId,
        transferEpoch: input.transferEpoch,
        activeEpoch: input.activeEpoch,
        rows,
      };
      const encrypted = encryptForSync({ snapshot }, input.targetEncryptionPublicKey);
      const fenced = this.transferLiveRows(input.conversationId, input.sourceMachineId, input.sourceEpoch,
        input.targetMachineId, input.transferEpoch);
      if (fenced !== rows.length) throw new Error(`delivery transfer fence raced (${fenced}/${rows.length})`);
      return { schemaVersion: 1 as const, encrypted, rowCount: rows.length };
    });
    return tx.immediate();
  }

  /** Target-side authenticated import. Conflicting rows fail closed; exact replays are idempotent. */
  importLiveRows(input: {
    transfer: EncryptedDeliveryTransfer;
    ownEncryptionPrivateKey: crypto.KeyObject;
    localHmacKey: string;
    authenticatedSourceMachineId: string;
    expectedTargetMachineId: string;
    expectedConversationId: string;
    expectedTransferEpoch: number;
  }): { imported: number; duplicate: number; activeEpoch: number } {
    if (input.transfer.schemaVersion !== 1) throw new Error('unsupported delivery transfer schema');
    const decoded = decryptFromSync(input.transfer.encrypted, input.ownEncryptionPrivateKey).snapshot;
    assertTransferSnapshot(decoded);
    const snapshot = decoded;
    if (snapshot.sourceMachineId !== input.authenticatedSourceMachineId
      || snapshot.targetMachineId !== input.expectedTargetMachineId
      || snapshot.conversationId !== input.expectedConversationId
      || snapshot.transferEpoch !== input.expectedTransferEpoch) {
      throw new Error('delivery transfer identity/epoch mismatch');
    }
    if (snapshot.rows.length !== input.transfer.rowCount) throw new Error('delivery transfer row-count mismatch');
    let imported = 0;
    let duplicate = 0;
    const tx = this.db.transaction(() => {
      let nextOrdinal = Number((this.db.prepare(
        'SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM inbound_delivery WHERE conversation_id = ?',
      ).get(snapshot.conversationId) as { ordinal: number }).ordinal);
      const ordinalTaken = this.db.prepare(
        'SELECT 1 FROM inbound_delivery WHERE conversation_id = ? AND ordinal = ?',
      );
      for (const row of snapshot.rows) {
        const existing = this.get(snapshot.conversationId, row.deliveryId);
        if (existing) {
          if (existing.ownerMachineId === snapshot.targetMachineId
            && existing.ownerEpoch === snapshot.activeEpoch
            && existing.envelopeHmac === crypto.createHmac('sha256', input.localHmacKey).update(row.envelope).digest('hex')) {
            duplicate += 1;
            continue;
          }
          throw new Error(`conflicting imported delivery ${row.deliveryId}`);
        }
        const localHmac = crypto.createHmac('sha256', input.localHmacKey).update(row.envelope).digest('hex');
        const ordinal = ordinalTaken.get(snapshot.conversationId, row.ordinal) ? nextOrdinal++ : row.ordinal;
        if (ordinal >= nextOrdinal) nextOrdinal = ordinal + 1;
        this.db.prepare(`INSERT INTO inbound_delivery
          (schema_version, conversation_id, delivery_id, ordinal, incarnation, framework, envelope_hmac,
           envelope_bytes, replay_envelope, owner_machine_id, owner_epoch, transfer_state,
           transport_state, composer_state, transcript_state, eligibility_state, rollout_id,
           baseline_offset, observed_offset, scan_turn_id, turn_id, observation_deadline,
           composer_cleared_at, consumed_at, responded_at, created_at, updated_at)
          VALUES (2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'imported', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          snapshot.conversationId, row.deliveryId, ordinal, row.incarnation, row.framework, localHmac,
          Buffer.byteLength(row.envelope), sealEnvelope(row.envelope, input.localHmacKey), snapshot.targetMachineId,
          snapshot.activeEpoch, row.transportState, row.composerState, row.transcriptState, row.eligibilityState, row.rolloutId,
          row.baselineOffset, row.observedOffset, row.scanTurnId, row.turnId, row.observationDeadline,
          row.composerClearedAt, row.consumedAt, row.respondedAt, row.createdAt, row.updatedAt,
        );
        for (const attempt of row.attempts) {
          this.db.prepare(`INSERT INTO inbound_attempt
            (conversation_id, delivery_id, attempt_index, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
            .run(snapshot.conversationId, row.deliveryId, attempt.attemptIndex, attempt.state, attempt.createdAt, attempt.updatedAt);
        }
        if (row.rolloutId) this.db.prepare(`INSERT INTO inbound_rollout_successor_authority
          (conversation_id, delivery_id, predecessor_rollout_id, target_machine_id, owner_epoch, used, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?)`)
          .run(snapshot.conversationId, row.deliveryId, row.rolloutId, snapshot.targetMachineId, snapshot.activeEpoch, this.options.now());
        imported += 1;
      }
    });
    tx.immediate();
    return { imported, duplicate, activeEpoch: snapshot.activeEpoch };
  }

  /** Re-open source custody after a transfer abort CAS returns ownership locally at a newer epoch. */
  restoreAbortedTransfer(conversationId: string, sourceMachineId: string, transferEpoch: number, activeEpoch: number): number {
    if (activeEpoch <= transferEpoch) return 0;
    return this.db.prepare(`UPDATE inbound_delivery
      SET owner_machine_id = ?, owner_epoch = ?, transfer_state = 'local', updated_at = ?
      WHERE conversation_id = ? AND owner_machine_id != ? AND owner_epoch = ? AND transfer_state = 'exported'
        AND transport_state NOT IN ('consumed','dispatch-failed','effect-unknown')`)
      .run(sourceMachineId, activeEpoch, this.options.now(), conversationId, sourceMachineId, transferEpoch).changes;
  }

  /** Target-side claim after the transfer snapshot has been authenticated and imported. */
  claimTransferredRows(conversationId: string, machineId: string, transferEpoch: number, activeEpoch = transferEpoch): number {
    if (!Number.isSafeInteger(activeEpoch) || activeEpoch < transferEpoch) return 0;
    return this.db.prepare(`UPDATE inbound_delivery
      SET transfer_state = 'imported', owner_epoch = ?, updated_at = ?
      WHERE conversation_id = ? AND owner_machine_id = ? AND owner_epoch = ?
        AND transfer_state = 'exported'
        AND transport_state NOT IN ('consumed','dispatch-failed','effect-unknown')`)
      .run(activeEpoch, this.options.now(), conversationId, machineId, transferEpoch).changes;
  }

  /** Action-time owner fence. Every physical effect must pass this immediately before arming. */
  ownsLiveDelivery(conversationId: string, deliveryId: string, machineId: string, ownerEpoch: number): boolean {
    const row = this.db.prepare(`SELECT 1 FROM inbound_delivery
      WHERE conversation_id = ? AND delivery_id = ? AND owner_machine_id = ? AND owner_epoch = ?
        AND transfer_state IN ('local','imported')`).get(conversationId, deliveryId, machineId, ownerEpoch);
    return row !== undefined;
  }

  recoverySnapshot(conversationId: string, deliveryId: string): DeliveryRecoverySnapshot | null {
    const row = this.db.prepare(`SELECT d.*,
      (SELECT COALESCE(MAX(ordinal), 0) FROM inbound_delivery WHERE conversation_id = d.conversation_id) AS latest_ordinal,
      (SELECT breaker_open FROM inbound_delivery_control WHERE singleton = 1) AS breaker_open,
      (SELECT COUNT(*) FROM inbound_attempt WHERE conversation_id = d.conversation_id
        AND delivery_id = d.delivery_id AND state IN ('attempted','effect-unknown')) AS completed_attempts
      FROM inbound_delivery d WHERE d.conversation_id = ? AND d.delivery_id = ?`)
      .get(conversationId, deliveryId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      conversationId, deliveryId, ownerEpoch: Number(row.owner_epoch),
      latestOrdinal: Number(row.latest_ordinal), deliveryOrdinal: Number(row.ordinal),
      incarnation: String(row.incarnation),
      deliveryExhausted: row.eligibility_state === 'keypress-exhausted' || Number(row.completed_attempts) >= 4,
      breakerOpen: Number(row.breaker_open) === 1,
    };
  }

  /** Privacy-safe rows projected into the legacy pending-inject compatibility surface. */
  compatibilityTombstones(now = this.options.now()): Array<{ conversationId: string; deliveryId: string; createdAt: number }> {
    return (this.db.prepare(`SELECT conversation_id, delivery_id, created_at FROM inbound_delivery
      WHERE (transport_state NOT IN ('consumed','dispatch-failed','effect-unknown')
        OR updated_at >= ?)`).all(now - 24 * 60 * 60 * 1000) as Array<Record<string, unknown>>).map((row) => ({
      conversationId: String(row.conversation_id), deliveryId: String(row.delivery_id), createdAt: Number(row.created_at),
    }));
  }

  /** Delete a bounded set of expired/excess terminal evidence; never live rows. */
  gc(): { deletedRows: number; elapsedMs: number } {
    const started = this.options.now();
    const cutoff = started - this.options.terminalTtlMs;
    const candidates = this.db.prepare(`WITH ranked AS (
      SELECT conversation_id, delivery_id, updated_at,
        ROW_NUMBER() OVER (PARTITION BY conversation_id ORDER BY updated_at DESC, ordinal DESC) AS rank
      FROM inbound_delivery WHERE transport_state IN ('consumed','dispatch-failed','effect-unknown')
    ) SELECT conversation_id, delivery_id FROM ranked
      WHERE updated_at < ? OR rank > ? LIMIT ?`)
      .all(cutoff, this.options.terminalRowsPerConversation, this.options.gcBatchRows) as Array<{ conversation_id: string; delivery_id: string }>;
    let deletedRows = 0;
    const remove = this.db.transaction(() => {
      const attempts = this.db.prepare('DE' + 'LETE FROM inbound_attempt WHERE conversation_id = ? AND delivery_id = ?');
      const delivery = this.db.prepare('DE' + `LETE FROM inbound_delivery WHERE conversation_id = ? AND delivery_id = ?
        AND transport_state IN ('consumed','dispatch-failed','effect-unknown')`);
      for (const row of candidates) {
        if (this.options.now() - started >= this.options.gcBudgetMs) break;
        attempts.run(row.conversation_id, row.delivery_id);
        deletedRows += delivery.run(row.conversation_id, row.delivery_id).changes;
      }
    });
    remove.immediate();
    const elapsedMs = this.options.now() - started;
    this.lastGc = { at: this.options.now(), deletedRows, elapsedMs };
    return { deletedRows, elapsedMs };
  }

  status(): InboundDeliveryStoreStatus {
    const count = (table: string) => this.db.prepare(
      `SELECT state_key, COUNT(*) AS count FROM (${table}) GROUP BY state_key`,
    ).all() as Array<{ state_key: string; count: number }>;
    const deliveriesByState = Object.fromEntries(count(
      `SELECT CASE
        WHEN transcript_state = 'responded' THEN 'responded'
        WHEN transcript_state = 'consumed' THEN 'turn-consumed'
        WHEN transport_state = 'effect-unknown' THEN 'effect-unknown'
        WHEN eligibility_state = 'keypress-exhausted' THEN 'exhausted'
        WHEN eligibility_state != 'open' THEN eligibility_state
        WHEN composer_state = 'cleared' THEN 'composer-cleared'
        ELSE transport_state END AS state_key FROM inbound_delivery`,
    ).map((row) => [row.state_key, Number(row.count)]));
    const attemptsByState = Object.fromEntries(count(
      'SELECT state AS state_key FROM inbound_attempt',
    ).map((row) => [row.state_key, Number(row.count)]));
    const live = this.db.prepare(`SELECT COUNT(*) AS rows, COALESCE(SUM(envelope_bytes), 0) AS bytes
      FROM inbound_delivery WHERE transport_state NOT IN ('consumed','dispatch-failed','effect-unknown')`).get() as { rows: number; bytes: number };
    const logical = this.db.prepare(`SELECT
      (SELECT COUNT(*) FROM inbound_delivery) + (SELECT COUNT(*) FROM inbound_attempt) AS rows`).get() as { rows: number };
    const breaker = this.db.prepare('SELECT breaker_open, breaker_epoch, breaker_reason FROM inbound_delivery_control WHERE singleton = 1')
      .get() as { breaker_open: number; breaker_epoch: number; breaker_reason: string | null };
    const verification = this.db.prepare(`SELECT
      SUM(CASE WHEN transport_state IN ('dispatched','consumed') THEN 1 ELSE 0 END) AS dispatched,
      SUM(CASE WHEN composer_cleared_at IS NOT NULL THEN 1 ELSE 0 END) AS composer_cleared,
      SUM(CASE WHEN consumed_at IS NOT NULL THEN 1 ELSE 0 END) AS consumed,
      SUM(CASE WHEN responded_at IS NOT NULL THEN 1 ELSE 0 END) AS responded,
      AVG(CASE WHEN composer_cleared_at IS NOT NULL THEN composer_cleared_at - created_at END) AS clear_ms,
      AVG(CASE WHEN consumed_at IS NOT NULL THEN consumed_at - created_at END) AS consume_ms,
      AVG(CASE WHEN responded_at IS NOT NULL THEN responded_at - created_at END) AS respond_ms
      FROM inbound_delivery`).get() as Record<string, number | null>;
    return {
      deliveriesByState,
      attemptsByState,
      uncertainEffects: (deliveriesByState['effect-unknown'] ?? 0) + (attemptsByState['effect-unknown'] ?? 0),
      liveRows: Number(live.rows), liveBytes: Number(live.bytes), logicalRows: Number(logical.rows),
      databaseBytes: this.safeSizeProbe(),
      breaker: { open: breaker.breaker_open === 1, epoch: Number(breaker.breaker_epoch), reason: breaker.breaker_reason },
      verification: {
        dispatched: Number(verification.dispatched ?? 0), composerCleared: Number(verification.composer_cleared ?? 0),
        consumed: Number(verification.consumed ?? 0), responded: Number(verification.responded ?? 0),
        avgDispatchToClearMs: verification.clear_ms == null ? null : Number(verification.clear_ms),
        avgDispatchToConsumeMs: verification.consume_ms == null ? null : Number(verification.consume_ms),
        avgDispatchToRespondMs: verification.respond_ms == null ? null : Number(verification.respond_ms),
      },
      lastGc: this.lastGc,
    };
  }

  startupReadiness(): { schema: boolean; journalMode: string; synchronous: number } {
    const rows = this.db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>;
    const tables = new Set(rows.map((row) => row.name));
    const required = ['inbound_delivery', 'inbound_attempt', 'inbound_delivery_control',
      'inbound_rollout_cursor', 'inbound_rollout_successor_authority', 'inbound_delivery_notice',
      'inbound_observer_state', 'inbound_observer_audit'];
    required.push('inbound_observer_notice');
    return {
      schema: required.every((name) => tables.has(name)),
      journalMode: String(this.db.pragma('journal_mode', { simple: true })),
      synchronous: Number(this.db.pragma('synchronous', { simple: true })),
    };
  }

  private safeSizeProbe(): number {
    try { return Math.max(0, this.sizeProbe()); } catch { return Number.POSITIVE_INFINITY; }
  }

  private insertObserverAudit(outcome: 'success' | 'failure', meta: {
    startedAt: number; endedAt: number; rows: number; bytes: number;
  }, errorClass: string | null): void {
    this.db.prepare(`INSERT INTO inbound_observer_audit
      (outcome, started_at, ended_at, rows_examined, bytes_read, error_class) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(outcome, meta.startedAt, meta.endedAt, meta.rows, meta.bytes, errorClass);
    this.db.prepare(`DELETE FROM inbound_observer_audit WHERE id NOT IN
      (SELECT id FROM inbound_observer_audit ORDER BY id DESC LIMIT 1000)`).run();
  }

  close(): void { try { this.db.close(); } catch { /* idempotent */ } }

}

export function loadOrCreateDeliveryHmacKey(stateDir: string): string {
  const keyPath = path.join(stateDir, 'state', 'inbound-delivery.hmac-key');
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  try {
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
  } catch { /* create below */ }
  const candidate = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(keyPath, candidate + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return candidate;
  } catch (err) {
    // Another process may have won the exclusive create race.
    const existing = fs.readFileSync(keyPath, 'utf8').trim();
    if (/^[a-f0-9]{64}$/.test(existing)) return existing;
    throw err;
  }
}

function normalizeOwnerEpoch(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}

/** Replay material is machine-local encrypted evidence; API/status projections never expose it. */
function sealEnvelope(envelope: string, keyHex: string): string {
  const key = /^[a-f0-9]{64}$/.test(keyHex)
    ? Buffer.from(keyHex, 'hex')
    : crypto.createHash('sha256').update(keyHex).digest();
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(envelope, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function unsealEnvelope(sealed: string, keyHex: string): string {
  const bytes = Buffer.from(sealed, 'base64');
  if (bytes.length < 29) throw new Error('malformed sealed delivery envelope');
  const key = /^[a-f0-9]{64}$/.test(keyHex)
    ? Buffer.from(keyHex, 'hex')
    : crypto.createHash('sha256').update(keyHex).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}

function assertTransferSnapshot(value: unknown): asserts value is DeliveryTransferSnapshot {
  if (!value || typeof value !== 'object') throw new Error('malformed delivery transfer snapshot');
  const s = value as Partial<DeliveryTransferSnapshot>;
  if (s.schemaVersion !== 1 || typeof s.conversationId !== 'string'
    || typeof s.sourceMachineId !== 'string' || typeof s.targetMachineId !== 'string'
    || !Number.isSafeInteger(s.sourceEpoch) || !Number.isSafeInteger(s.transferEpoch)
    || !Number.isSafeInteger(s.activeEpoch) || !Array.isArray(s.rows)
    || s.transferEpoch! <= s.sourceEpoch! || s.activeEpoch! <= s.transferEpoch!) {
    throw new Error('malformed delivery transfer snapshot');
  }
  for (const row of s.rows) {
    if (!row || row.schemaVersion !== 2 || typeof row.deliveryId !== 'string'
      || !Number.isSafeInteger(row.ordinal) || typeof row.incarnation !== 'string'
      || typeof row.framework !== 'string' || typeof row.envelope !== 'string'
      || typeof row.envelopeHmac !== 'string' || !Array.isArray(row.attempts)
      || !['unobserved', 'present', 'cleared', 'unknown'].includes(row.composerState)
      || !['unseen', 'consumed', 'responded', 'unknown'].includes(row.transcriptState)
      || !['open', 'keypress-exhausted', 'superseded', 'continuity-lost', 'unknown'].includes(row.eligibilityState)
      || (row.rolloutId !== null && typeof row.rolloutId !== 'string')
      || !Number.isSafeInteger(row.baselineOffset) || !Number.isSafeInteger(row.observedOffset)
      || (row.scanTurnId !== null && typeof row.scanTurnId !== 'string')
      || (row.turnId !== null && typeof row.turnId !== 'string') || !Number.isSafeInteger(row.observationDeadline)
      || (row.composerClearedAt !== null && !Number.isSafeInteger(row.composerClearedAt))
      || (row.consumedAt !== null && !Number.isSafeInteger(row.consumedAt))
      || (row.respondedAt !== null && !Number.isSafeInteger(row.respondedAt))
      || !['prepared', 'dispatch-armed', 'dispatch-started', 'dispatched', 'consumed', 'dispatch-failed', 'effect-unknown'].includes(row.transportState)) {
      throw new Error('malformed delivery transfer row');
    }
  }
}

/** Additive, idempotent compatibility migration for pre-v2 local ledgers. */
function ensureDeliveryColumns(db: BetterSqliteDatabase): void {
  const columns = new Set((db.prepare('PRAGMA table_info(inbound_delivery)').all() as Array<{ name: string }>).map(r => r.name));
  const additions: Array<[string, string]> = [
    ['schema_version', "INTEGER NOT NULL DEFAULT 1"],
    ['replay_envelope', 'TEXT'],
    ['owner_machine_id', "TEXT NOT NULL DEFAULT 'local'"],
    ['owner_epoch', 'INTEGER NOT NULL DEFAULT 0'],
    ['transfer_state', "TEXT NOT NULL DEFAULT 'local'"],
    ['composer_state', "TEXT NOT NULL DEFAULT 'unobserved'"],
    ['transcript_state', "TEXT NOT NULL DEFAULT 'unseen'"],
    ['eligibility_state', "TEXT NOT NULL DEFAULT 'open'"],
    ['rollout_path', 'TEXT'],
    ['rollout_id', 'TEXT'],
    ['baseline_offset', 'INTEGER NOT NULL DEFAULT -1'],
    ['observed_offset', 'INTEGER NOT NULL DEFAULT -1'],
    ['scan_turn_id', 'TEXT'],
    ['turn_id', 'TEXT'],
    ['assistant_seen', 'INTEGER NOT NULL DEFAULT 0'],
    ['observation_deadline', 'INTEGER NOT NULL DEFAULT 0'],
    ['composer_cleared_at', 'INTEGER'],
    ['consumed_at', 'INTEGER'],
    ['responded_at', 'INTEGER'],
  ];
  for (const [name, declaration] of additions) {
    if (!columns.has(name)) db.exec(`ALTER TABLE inbound_delivery ADD COLUMN ${name} ${declaration}`);
  }
}
