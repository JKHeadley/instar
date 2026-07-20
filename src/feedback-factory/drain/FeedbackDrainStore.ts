import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { registerSqliteHandle } from '../../core/SqliteRegistry.js';
import type { CanonicalPipelineStageMetadata } from '../../core/canonicalPipelineRegistry.js';
import { NativeModuleHealer } from '../../memory/NativeModuleHealer.js';

export const FEEDBACK_DRAIN_STORE_STAGE = {
  canonicalPipelineId: 'feedback-factory',
  stage: 'durable-work',
} as const satisfies CanonicalPipelineStageMetadata;

export type ReadinessState = 'collecting' | 'ready' | 'queued' | 'held';
export type WorkState = 'queued' | 'claimed' | 'completed' | 'retryable' | 'dead-lettered' | 'held';
export type LinkState = 'pending' | 'readable' | 'degraded' | 'held';
export type RunState = 'accepted' | 'running' | 'succeeded' | 'no-op' | 'degraded' | 'failed' | 'abandoned';

export class DrainConflictError extends Error {
  readonly statusCode = 409;
  constructor(message: string) { super(message); this.name = 'DrainConflictError'; }
}

export interface ReadinessProjection {
  clusterId: string;
  state: ReadinessState;
  epoch: number;
  enteredAt: number;
  lastEvaluatedAt: number | null;
  nextReviewAt: number | null;
  reasonCode: string;
}

export interface FeedbackWork {
  workId: string;
  idempotencyKey: string;
  clusterId: string;
  readinessEpoch: number;
  state: WorkState;
  title: string;
  summary: string;
  priority: string;
  reportCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  authorityRef: string;
  evidenceRef: string;
  leaseEpoch: number;
  leaseExpiresAt: number | null;
  consumerId: string | null;
  attempts: number;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface Claim extends FeedbackWork { claimToken: string; }

export interface InitiativeLinkObservation {
  artifactId: string;
  artifactKind: string;
  feedbackWorkKey: string;
  readable: boolean;
}

export interface InitiativeLinkReconciliationResult {
  checked: number;
  linked: number;
  held: number;
  degraded: number;
}

export type FeedbackDrainCrashPoint =
  | 'readiness-after-state' | 'readiness-after-approval' | 'readiness-after-commit'
  | 'enqueue-after-work' | 'enqueue-after-readiness' | 'enqueue-after-link' | 'enqueue-after-commit'
  | 'claim-after-update' | 'claim-after-commit'
  | 'artifact-link-after-update' | 'artifact-link-after-commit'
  | 'completion-after-update' | 'completion-after-commit'
  | 'retry-after-update' | 'retry-after-commit'
  | 'run-after-transition' | 'run-after-commit'
  | 'restore-after-claims' | 'restore-after-runs' | 'restore-after-epoch' | 'restore-after-commit';

export interface AuthorityRecord {
  authorityId: string;
  agentId: string;
  ownerMachineId: string;
  ownerEpoch: number;
  provider: string;
  modelFamily: string;
  promptVersion: string;
  schemaVersion: string;
  decisionPointId: string;
  maxBatch: number;
  maxTokens: number;
  maxDailySpendUsd: number;
  generation: number;
  revoked: boolean;
}

export interface DrainMetrics {
  readiness: Record<ReadinessState, number>;
  work: Record<WorkState, number>;
  oldestReadyAgeMs: number | null;
  oldestQueuedAgeMs: number | null;
  oldestClaimedAgeMs: number | null;
  oldestFeedbackAgeMs: number | null;
  oldestHeldAgeMs: number | null;
  oldestDeadLetterAgeMs: number | null;
  lastEnqueuedAt: number | null;
  lastClaimedAt: number | null;
  lastCompletedAt: number | null;
  lastSuccessfulClusteringAt: number | null;
  lastSuccessfulEvaluationAt: number | null;
  lastSourceReconciliationAt: number | null;
  overdueCollecting: number;
  oldestOverdueAgeMs: number | null;
  sourceProjectionLagBytes: number;
  sourceChecksumConflicts: number;
  oldestSourceConflictAgeMs: number | null;
}

export interface FeedbackDrainStoreOptions {
  dbPath: string;
  tokenHmacKey: string | Buffer;
  clock?: () => number;
  idFactory?: () => string;
  tokenFactory?: () => string;
  db?: BetterSqliteDatabase;
  authorityBackupPath?: string;
  crashInjector?: (point: FeedbackDrainCrashPoint) => void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS drain_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS readiness (
  cluster_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('collecting','ready','queued','held')),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK(epoch >= 0), entered_at INTEGER NOT NULL,
  last_evaluated_at INTEGER, next_review_at INTEGER, reason_code TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_readiness_due ON readiness(next_review_at, cluster_id) WHERE state='collecting';
CREATE INDEX IF NOT EXISTS idx_readiness_state ON readiness(state, entered_at);
CREATE TABLE IF NOT EXISTS readiness_approvals (
  approval_key TEXT PRIMARY KEY, cluster_id TEXT NOT NULL, evidence_hash TEXT NOT NULL,
  authority_id TEXT NOT NULL, authority_generation INTEGER NOT NULL, decision_nonce TEXT NOT NULL,
  proposal_set_hash TEXT NOT NULL, epoch INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS work (
  work_id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, cluster_id TEXT NOT NULL,
  readiness_epoch INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','claimed','completed','retryable','dead-lettered','held')),
  title TEXT NOT NULL, summary TEXT NOT NULL, priority TEXT NOT NULL, report_count INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, authority_ref TEXT NOT NULL, evidence_ref TEXT NOT NULL,
  lease_epoch INTEGER NOT NULL DEFAULT 0, lease_expires_at INTEGER, consumer_id TEXT, token_hash TEXT,
  owner_authority_epoch INTEGER, attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_at INTEGER, completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_work_claim ON work(state, next_attempt_at, created_at);
CREATE TABLE IF NOT EXISTS work_tombstones (
  idempotency_key TEXT PRIMARY KEY, work_id TEXT NOT NULL UNIQUE, terminal_state TEXT NOT NULL,
  retired_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_links (
  work_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('pending','readable','degraded','held')),
  external_key TEXT NOT NULL UNIQUE, artifact_id TEXT, artifact_kind TEXT, verified_at INTEGER, updated_at INTEGER NOT NULL,
  FOREIGN KEY(work_id) REFERENCES work(work_id)
);
CREATE TABLE IF NOT EXISTS drain_runs (
  run_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('accepted','running','succeeded','no-op','degraded','failed','abandoned')),
  owner_host TEXT NOT NULL, owner_epoch INTEGER NOT NULL, lease_expires_at INTEGER,
  reason TEXT NOT NULL DEFAULT '', cancellation_requested_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_active_run ON drain_runs((1)) WHERE state IN ('accepted','running');
CREATE TABLE IF NOT EXISTS authority_records (
  authority_id TEXT NOT NULL, generation INTEGER NOT NULL, agent_id TEXT NOT NULL, owner_machine_id TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL, provider TEXT NOT NULL, model_family TEXT NOT NULL, prompt_version TEXT NOT NULL,
  schema_version TEXT NOT NULL, decision_point_id TEXT NOT NULL, max_batch INTEGER NOT NULL, max_tokens INTEGER NOT NULL,
  max_daily_spend_usd REAL NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY(authority_id, generation)
);
CREATE TABLE IF NOT EXISTS authority_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, generation INTEGER NOT NULL, action TEXT NOT NULL,
  authority_id TEXT NOT NULL, operator_decision_ref TEXT NOT NULL, payload_hash TEXT NOT NULL,
  previous_checksum TEXT NOT NULL, checksum TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS authority_daily_usage (
  authority_id TEXT NOT NULL, generation INTEGER NOT NULL, utc_day TEXT NOT NULL,
  committed_usd REAL NOT NULL DEFAULT 0 CHECK(committed_usd >= 0), decisions INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL, PRIMARY KEY(authority_id,generation,utc_day)
);
CREATE TABLE IF NOT EXISTS authority_posture (
  authority_id TEXT NOT NULL, generation INTEGER NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('active','proposal-only')),
  reason TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY(authority_id,generation)
);
CREATE TABLE IF NOT EXISTS drain_audit (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  from_state TEXT, to_state TEXT, reason TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS source_projection (
  ingest_sequence INTEGER PRIMARY KEY AUTOINCREMENT, source_record_id TEXT NOT NULL UNIQUE,
  generation_id TEXT NOT NULL, byte_offset INTEGER NOT NULL, byte_length INTEGER NOT NULL,
  record_checksum TEXT NOT NULL, entity_id TEXT NOT NULL, record_json TEXT NOT NULL, checked_at INTEGER, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_projection_reconcile ON source_projection(checked_at,ingest_sequence);
CREATE TABLE IF NOT EXISTS source_cursors (
  cursor_id TEXT PRIMARY KEY, generation_id TEXT NOT NULL, byte_offset INTEGER NOT NULL,
  last_record_checksum TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS source_conflicts (
  source_record_id TEXT PRIMARY KEY, expected_checksum TEXT NOT NULL, observed_checksum TEXT NOT NULL,
  reason TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS request_replay (
  authority_id TEXT NOT NULL, nonce_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(authority_id,nonce_hash)
);
CREATE INDEX IF NOT EXISTS idx_request_replay_expiry ON request_replay(expires_at);
`;

const clamp = (value: string, max: number): string => value.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const canonical = (value: unknown): string => JSON.stringify(value, Object.keys(value as object).sort());

export class FeedbackDrainStore {
  private readonly db: BetterSqliteDatabase;
  private readonly hmacKey: string | Buffer;
  private readonly now: () => number;
  private readonly idFactory: () => string;
  private readonly tokenFactory: () => string;
  private readonly authorityBackupPath: string | null;
  private readonly crashInjector: ((point: FeedbackDrainCrashPoint) => void) | null;
  private readonly dbPath: string;
  private unregisterSqlite?: () => void;

  constructor(opts: FeedbackDrainStoreOptions) {
    this.dbPath = opts.dbPath;
    this.hmacKey = opts.tokenHmacKey;
    if ((typeof this.hmacKey === 'string' && this.hmacKey.length < 32) || (Buffer.isBuffer(this.hmacKey) && this.hmacKey.length < 32)) {
      throw new Error('tokenHmacKey must contain at least 32 bytes');
    }
    this.now = opts.clock ?? Date.now;
    this.idFactory = opts.idFactory ?? randomUUID;
    this.tokenFactory = opts.tokenFactory ?? (() => randomBytes(32).toString('base64url'));
    this.authorityBackupPath = opts.authorityBackupPath ?? (opts.dbPath === ':memory:' ? null : path.join(path.dirname(opts.dbPath), 'feedback-readiness-authorities.json'));
    this.crashInjector = opts.crashInjector ?? null;
    if (opts.db) this.db = opts.db;
    else {
      if (opts.dbPath !== ':memory:') fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
      this.db = NativeModuleHealer.openWithHealSync('FeedbackDrainStore', () => new Database(opts.dbPath));
    }
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this.ensureSchemaUpgrades();
    this.restoreAuthorityBackupIfEmpty();
    this.unregisterSqlite = registerSqliteHandle(() => { try { this.db.close(); } catch { /* closed */ } });
  }

  close(): void {
    if (this.db.open) this.db.close();
    this.unregisterSqlite?.();
    this.unregisterSqlite = undefined;
  }

  integrityCheck(): boolean {
    const rows = this.db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    return rows.length === 1 && rows[0]?.integrity_check === 'ok';
  }

  /** Quiescent, checksummed SQLite checkpoint metadata consumed by BackupManager. */
  checkpointForBackup(ownerAuthorityEpoch: number): { schemaVersion: 1; snapshotId: string; checksum: string; dbFileIdentity: string; ownerAuthorityEpoch: number; createdAt: string; manifestChecksum: string } {
    if (this.dbPath === ':memory:') throw new Error('in-memory feedback drain cannot be checkpointed for backup');
    const recordedEpoch = this.ownerAuthorityEpoch();
    if (recordedEpoch === null) this.setMeta('owner_authority_epoch', String(ownerAuthorityEpoch));
    else if (recordedEpoch !== ownerAuthorityEpoch) throw new DrainConflictError('backup owner authority epoch is stale');
    const checkpointRows = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number; log: number; checkpointed: number }>;
    const checkpoint = checkpointRows[0];
    if (!checkpoint || checkpoint.busy !== 0 || checkpoint.checkpointed !== checkpoint.log) {
      throw new DrainConflictError('feedback drain WAL checkpoint is busy or incomplete');
    }
    if (!this.integrityCheck()) throw new Error('feedback drain integrity check failed before backup');
    const bytes = fs.readFileSync(this.dbPath);
    const stat = fs.statSync(this.dbPath);
    const payload = { schemaVersion: 1 as const, snapshotId: `feedback-drain:${randomUUID()}`, checksum: createHash('sha256').update(bytes).digest('hex'),
      dbFileIdentity: `${stat.dev}:${stat.ino}`, ownerAuthorityEpoch, createdAt: new Date(this.now()).toISOString() };
    const record = { ...payload, manifestChecksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
    const target = path.join(path.dirname(this.dbPath), 'feedback-drain-checkpoint.json');
    const tmp = `${target}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, 'w', 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(record)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, target);
    const dir = fs.openSync(path.dirname(target), 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    return record;
  }

  /** Distinguish a routine restart from a DB file restored out of a snapshot. */
  restorePending(): boolean {
    if (this.dbPath === ':memory:') return false;
    const checkpointPath = path.join(path.dirname(this.dbPath), 'feedback-drain-checkpoint.json');
    if (!fs.existsSync(checkpointPath)) return false;
    let checkpoint: { schemaVersion: number; snapshotId: string; checksum: string; dbFileIdentity: string; ownerAuthorityEpoch: number; createdAt: string; manifestChecksum: string };
    try { checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as typeof checkpoint; }
    catch { throw new DrainConflictError('feedback drain checkpoint manifest is malformed'); }
    const payload = { schemaVersion: checkpoint.schemaVersion, snapshotId: checkpoint.snapshotId, checksum: checkpoint.checksum,
      dbFileIdentity: checkpoint.dbFileIdentity, ownerAuthorityEpoch: checkpoint.ownerAuthorityEpoch, createdAt: checkpoint.createdAt };
    if (checkpoint.schemaVersion !== 1 || createHash('sha256').update(JSON.stringify(payload)).digest('hex') !== checkpoint.manifestChecksum) {
      throw new DrainConflictError('feedback drain checkpoint manifest checksum is invalid');
    }
    const stat = fs.statSync(this.dbPath);
    const currentIdentity = `${stat.dev}:${stat.ino}`;
    if (currentIdentity === checkpoint.dbFileIdentity) return false;
    const currentChecksum = createHash('sha256').update(fs.readFileSync(this.dbPath)).digest('hex');
    if (currentChecksum !== checkpoint.checksum || this.ownerAuthorityEpoch() !== checkpoint.ownerAuthorityEpoch) {
      throw new DrainConflictError('restored feedback drain does not match its checkpoint');
    }
    return true;
  }

  admitRequestNonce(authorityId: string, nonce: string, input: { now?: number; ttlMs?: number } = {}): boolean {
    const now = input.now ?? this.now();
    const ttlMs = Math.max(1_000, Math.min(60 * 60_000, input.ttlMs ?? 10 * 60_000));
    const nonceHash = createHmac('sha256', this.hmacKey).update(nonce).digest('hex');
    return this.db.transaction(() => {
      this.db.prepare(`DELETE FROM request_replay WHERE rowid IN (SELECT rowid FROM request_replay WHERE expires_at<=? ORDER BY expires_at LIMIT 100)`).run(now);
      const result = this.db.prepare(`INSERT OR IGNORE INTO request_replay(authority_id,nonce_hash,expires_at,created_at) VALUES (?,?,?,?)`)
        .run(clamp(authorityId, 200), nonceHash, now + ttlMs, now);
      return result.changes === 1;
    }).immediate();
  }

  projectSourceGeneration(input: { filePath: string; generationId: string; limit?: number; crashPoint?: 'after-read' | 'after-insert' | 'after-commit' }): { projected: number; replayed: number; byteOffset: number; lagBytes: number } {
    const limit = Math.max(0, Math.min(500, Math.trunc(input.limit ?? 500)));
    const generationId = clamp(input.generationId, 200);
    const cursor = this.db.prepare(`SELECT generation_id,byte_offset,last_record_checksum FROM source_cursors WHERE cursor_id='canonical-feedback'`).get() as { generation_id: string; byte_offset: number; last_record_checksum: string } | undefined;
    if (!generationId) return { projected: 0, replayed: 0, byteOffset: 0, lagBytes: 0 };
    if (!fs.existsSync(input.filePath)) {
      if (!cursor) return { projected: 0, replayed: 0, byteOffset: 0, lagBytes: 0 };
      this.setMeta('source_integrity_hold', 'source-generation-missing');
      throw new DrainConflictError('durable source generation is missing');
    }
    if (cursor && cursor.generation_id !== generationId) throw new DrainConflictError('source generation changed without a validated handoff');
    const offset = cursor?.byte_offset ?? 0;
    const size = fs.statSync(input.filePath).size;
    if (size < offset) throw new DrainConflictError('source generation truncated before durable cursor');
    if (size === offset || limit === 0) return { projected: 0, replayed: 0, byteOffset: offset, lagBytes: size - offset };
    const buffer = Buffer.allocUnsafe(Math.min(size - offset, 4 * 1024 * 1024));
    const fd = fs.openSync(input.filePath, 'r'); let bytesRead = 0;
    try { bytesRead = fs.readSync(fd, buffer, 0, buffer.length, offset); } finally { fs.closeSync(fd); }
    const records: Array<{ sourceId: string; entityId: string; checksum: string; raw: string; offset: number; length: number }> = [];
    let consumed = 0;
    for (let start = 0; start < bytesRead && records.length < limit;) {
      const newline = buffer.indexOf(0x0a, start); if (newline < 0) break;
      const raw = buffer.subarray(start, newline).toString('utf8').trim();
      const recordOffset = offset + start; consumed = newline + 1; start = newline + 1;
      if (!raw) continue;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch { throw new DrainConflictError('invalid complete source record'); }
      const entityId = String(parsed.feedbackId ?? parsed.feedback_id ?? parsed.id ?? '');
      if (!entityId) throw new DrainConflictError('source record has no stable feedback id');
      const sourceId = typeof parsed.sourceRecordId === 'string' && parsed.sourceRecordId
        ? parsed.sourceRecordId
        : `legacy:${entityId}:${createHash('sha256').update(raw).digest('hex')}`;
      records.push({ sourceId: clamp(sourceId, 300), entityId: clamp(entityId, 300), checksum: createHash('sha256').update(raw).digest('hex'), raw, offset: recordOffset, length: newline - (recordOffset - offset) + 1 });
    }
    if (input.crashPoint === 'after-read') throw new Error('injected crash after source read');
    let projected = 0; let replayed = 0;
    const sourceConflict = this.db.transaction((): boolean => {
      for (const record of records) {
        const prior = this.db.prepare('SELECT record_checksum FROM source_projection WHERE source_record_id=?').get(record.sourceId) as { record_checksum: string } | undefined;
        if (prior && prior.record_checksum !== record.checksum) {
          this.db.prepare(`INSERT INTO source_conflicts VALUES (?,?,?,?,?) ON CONFLICT(source_record_id) DO UPDATE SET observed_checksum=excluded.observed_checksum,reason=excluded.reason,created_at=excluded.created_at`)
            .run(record.sourceId, prior.record_checksum, record.checksum, 'source-record-checksum-conflict', this.now());
          this.setMeta('source_integrity_hold', 'source-record-checksum-conflict');
          return true;
        }
        if (prior) replayed++;
        else {
          this.db.prepare(`INSERT INTO source_projection(source_record_id,generation_id,byte_offset,byte_length,record_checksum,entity_id,record_json,created_at) VALUES (?,?,?,?,?,?,?,?)`)
            .run(record.sourceId, generationId, record.offset, record.length, record.checksum, record.entityId, record.raw, this.now());
          projected++;
        }
      }
      if (input.crashPoint === 'after-insert') throw new Error('injected crash after projection insert');
      const nextOffset = offset + consumed;
      const checksum = records.at(-1)?.checksum ?? cursor?.last_record_checksum ?? '';
      this.db.prepare(`INSERT INTO source_cursors(cursor_id,generation_id,byte_offset,last_record_checksum,updated_at) VALUES ('canonical-feedback',?,?,?,?)
        ON CONFLICT(cursor_id) DO UPDATE SET generation_id=excluded.generation_id,byte_offset=excluded.byte_offset,last_record_checksum=excluded.last_record_checksum,updated_at=excluded.updated_at`)
        .run(generationId, nextOffset, checksum, this.now());
      return false;
    }).immediate();
    if (sourceConflict) throw new DrainConflictError('source record checksum conflicts with its projection');
    const byteOffset = offset + consumed;
    this.db.prepare(`INSERT INTO drain_meta(key,value) VALUES ('source_lag_bytes',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(Math.max(0, size - byteOffset)));
    if (input.crashPoint === 'after-commit') throw new Error('injected crash after projection commit');
    return { projected, replayed, byteOffset, lagBytes: Math.max(0, size - byteOffset) };
  }

  sourceCursor(): { generationId: string; byteOffset: number; lastRecordChecksum: string } | null {
    const row: { generation_id: string; byte_offset: number; last_record_checksum: string } | undefined =
      this.db.prepare(`SELECT generation_id,byte_offset,last_record_checksum FROM source_cursors WHERE cursor_id='canonical-feedback'`).get() as { generation_id: string; byte_offset: number; last_record_checksum: string } | undefined;
    return row ? { generationId: row.generation_id, byteOffset: row.byte_offset, lastRecordChecksum: row.last_record_checksum } : null;
  }

  pendingProjectedFeedback(limit = 500): Array<{ ingestSequence: number; record: Record<string, unknown> }> {
    const cursor = Number((this.db.prepare(`SELECT value FROM drain_meta WHERE key='processing_ingest_sequence'`).get() as { value: string } | undefined)?.value ?? 0);
    const rows = this.db.prepare(`SELECT ingest_sequence,record_json FROM source_projection WHERE ingest_sequence>? ORDER BY ingest_sequence LIMIT ?`)
      .all(cursor, Math.max(0, Math.min(500, Math.trunc(limit)))) as Array<{ ingest_sequence: number; record_json: string }>;
    return rows.map((row) => ({ ingestSequence: row.ingest_sequence, record: JSON.parse(row.record_json) as Record<string, unknown> }));
  }

  acknowledgeProcessedProjection(ingestSequence: number): void {
    const current = Number((this.db.prepare(`SELECT value FROM drain_meta WHERE key='processing_ingest_sequence'`).get() as { value: string } | undefined)?.value ?? 0);
    if (!Number.isSafeInteger(ingestSequence) || ingestSequence < current) throw new DrainConflictError('processing projection cursor cannot rewind');
    const max = Number((this.db.prepare(`SELECT MAX(ingest_sequence) n FROM source_projection`).get() as { n: number | null }).n ?? 0);
    if (ingestSequence > max) throw new DrainConflictError('processing projection cursor exceeds durable projection');
    this.setMeta('processing_ingest_sequence', String(ingestSequence));
  }

  acceptSourceHandoff(input: { fromGenerationId: string; finalOffset: number; toGenerationId: string }): void {
    this.db.transaction(() => {
      const cursor = this.sourceCursor();
      if (!cursor || cursor.generationId !== input.fromGenerationId || cursor.byteOffset !== input.finalOffset) {
        throw new DrainConflictError('source cursor has not acknowledged the immutable generation boundary');
      }
      const existing = this.db.prepare(`SELECT COUNT(*) n FROM source_projection WHERE generation_id=?`).get(input.toGenerationId) as { n: number };
      if (existing.n > 0) throw new DrainConflictError('target source generation was projected before handoff acceptance');
      this.db.prepare(`UPDATE source_cursors SET generation_id=?,byte_offset=0,last_record_checksum='',updated_at=? WHERE cursor_id='canonical-feedback' AND generation_id=? AND byte_offset=?`)
        .run(input.toGenerationId, this.now(), input.fromGenerationId, input.finalOffset);
      this.audit('source-generation', input.toGenerationId, input.fromGenerationId, input.toGenerationId, 'checksummed-handoff-accepted');
    }).immediate();
  }

  reconcileSourceProjection(input: { filePath: string; generationId: string; limit?: number }): { checked: number; conflicts: number } {
    if (!fs.existsSync(input.filePath)) {
      const sourceId = `generation:${clamp(input.generationId, 200)}`;
      this.db.prepare(`INSERT INTO source_conflicts VALUES (?,?,?,?,?) ON CONFLICT(source_record_id) DO UPDATE SET observed_checksum=excluded.observed_checksum,reason=excluded.reason,created_at=excluded.created_at`)
        .run(sourceId, 'generation-present', 'generation-missing', 'reconciliation-generation-missing', this.now());
      this.setMeta('source_integrity_hold', 'reconciliation-generation-missing');
      this.setMeta('last_source_reconciliation_at', String(this.now()));
      throw new DrainConflictError('source generation is missing during reconciliation');
    }
    const rows = this.db.prepare(`SELECT * FROM source_projection WHERE generation_id=? ORDER BY checked_at IS NOT NULL,checked_at,ingest_sequence LIMIT ?`)
      .all(input.generationId, Math.max(0, Math.min(500, Math.trunc(input.limit ?? 500)))) as Record<string, unknown>[];
    let conflicts = 0;
    const fd = fs.openSync(input.filePath, 'r');
    try {
      for (const row of rows) {
        const bytes = Buffer.alloc(Number(row.byte_length));
        const read = fs.readSync(fd, bytes, 0, bytes.length, Number(row.byte_offset));
        const raw = bytes.subarray(0, read).toString('utf8').trim();
        const observed = createHash('sha256').update(raw).digest('hex');
        if (observed !== row.record_checksum) {
          conflicts++;
          this.db.prepare(`INSERT INTO source_conflicts VALUES (?,?,?,?,?) ON CONFLICT(source_record_id) DO UPDATE SET observed_checksum=excluded.observed_checksum,reason=excluded.reason,created_at=excluded.created_at`)
            .run(row.source_record_id, row.record_checksum, observed, 'reconciliation-checksum-conflict', this.now());
        }
        this.db.prepare('UPDATE source_projection SET checked_at=? WHERE ingest_sequence=?').run(this.now(), row.ingest_sequence);
      }
    } finally { fs.closeSync(fd); }
    this.setMeta('last_source_reconciliation_at', String(this.now()));
    return { checked: rows.length, conflicts };
  }

  markClusteringSucceeded(at = this.now()): void { this.setMeta('last_successful_clustering_at', String(at)); }

  sourceCompactionDue(intervalMs: number, now = this.now()): boolean {
    const row = this.db.prepare(`SELECT value FROM drain_meta WHERE key='last_source_compaction_at'`).get() as { value: string } | undefined;
    if (!row) { this.setMeta('last_source_compaction_at', String(now)); return false; }
    const last = Number(row?.value ?? 0);
    return !Number.isFinite(last) || last <= 0 || now - last >= Math.max(1, intervalMs);
  }

  recordSourceCompaction(at = this.now()): void { this.setMeta('last_source_compaction_at', String(at)); }

  ensureReadiness(clusterId: string, nextReviewAt: number | null = null): ReadinessProjection {
    const now = this.now();
    this.db.prepare(`INSERT OR IGNORE INTO readiness(cluster_id,state,epoch,entered_at,next_review_at)
      VALUES (?,'collecting',0,?,?)`).run(clamp(clusterId, 200), now, nextReviewAt);
    return this.getReadiness(clusterId)!;
  }

  getReadiness(clusterId: string): ReadinessProjection | null {
    const row = this.db.prepare('SELECT * FROM readiness WHERE cluster_id=?').get(clusterId) as Record<string, unknown> | undefined;
    return row ? this.readinessFromRow(row) : null;
  }

  approveReady(input: { clusterId: string; approvalKey: string; authorityId: string; authorityGeneration: number; evidenceHash: string; decisionNonce: string; proposalSetHash: string; nextReviewAt?: number | null }): ReadinessProjection {
    if (!/^[A-Za-z0-9._:-]{16,128}$/.test(input.decisionNonce) || !/^[a-f0-9]{64}$/.test(input.proposalSetHash)) {
      throw new DrainConflictError('approval decision nonce or proposal-set hash is invalid');
    }
    const outcome = this.db.transaction((): { row: ReadinessProjection; conflict: boolean } => {
      const duplicate = this.db.prepare('SELECT * FROM readiness_approvals WHERE approval_key=?').get(input.approvalKey) as Record<string, unknown> | undefined;
      if (duplicate) {
        if (duplicate.cluster_id !== input.clusterId || duplicate.evidence_hash !== input.evidenceHash ||
            duplicate.authority_id !== input.authorityId || Number(duplicate.authority_generation) !== input.authorityGeneration ||
            duplicate.decision_nonce !== input.decisionNonce || duplicate.proposal_set_hash !== input.proposalSetHash) {
          const current = this.getReadiness(input.clusterId) ?? this.ensureReadiness(input.clusterId, input.nextReviewAt ?? null);
          const row = current.state === 'held' ? current : this.holdReadinessInternal(input.clusterId, 'approval-key-conflict');
          return { row, conflict: true };
        }
        return { row: this.getReadiness(input.clusterId)!, conflict: false };
      }
      const authority = this.getAuthority(input.authorityId, input.authorityGeneration);
      if (!authority || authority.revoked || authority.generation !== this.latestAuthority(input.authorityId)?.generation) throw new DrainConflictError('readiness authority is not active');
      const current = this.getReadiness(input.clusterId) ?? this.ensureReadiness(input.clusterId, input.nextReviewAt ?? null);
      if (current.state !== 'collecting') throw new DrainConflictError(`cannot approve readiness from ${current.state}`);
      const now = this.now();
      const epoch = current.epoch + 1;
      this.db.prepare(`UPDATE readiness SET state='ready',epoch=?,entered_at=?,last_evaluated_at=?,next_review_at=NULL,reason_code='authority-approved' WHERE cluster_id=? AND state='collecting'`)
        .run(epoch, now, now, input.clusterId);
      this.inject('readiness-after-state');
      this.db.prepare('INSERT INTO readiness_approvals(approval_key,cluster_id,evidence_hash,authority_id,authority_generation,decision_nonce,proposal_set_hash,epoch,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(input.approvalKey, input.clusterId, input.evidenceHash, input.authorityId, input.authorityGeneration, input.decisionNonce, input.proposalSetHash, epoch, now);
      this.inject('readiness-after-approval');
      this.audit('readiness', input.clusterId, 'collecting', 'ready', 'authority-approved');
      return { row: this.getReadiness(input.clusterId)!, conflict: false };
    }).immediate();
    this.inject('readiness-after-commit');
    if (outcome.conflict) throw new DrainConflictError('approval key conflicts with its recorded evidence');
    return outcome.row;
  }

  holdReadiness(clusterId: string, reason: string): ReadinessProjection {
    return this.db.transaction(() => this.holdReadinessInternal(clusterId, reason)).immediate();
  }

  releaseHeld(clusterId: string, input: { revalidated: boolean; reason: string }): ReadinessProjection {
    if (!input.revalidated) throw new DrainConflictError('integrity revalidation is required');
    const now = this.now();
    const result = this.db.prepare(`UPDATE readiness SET state='collecting',epoch=epoch+1,entered_at=?,last_evaluated_at=?,reason_code=? WHERE cluster_id=? AND state='held'`)
      .run(now, now, clamp(input.reason, 200), clusterId);
    if (result.changes !== 1) throw new DrainConflictError('readiness is not held');
    this.audit('readiness', clusterId, 'held', 'collecting', input.reason);
    return this.getReadiness(clusterId)!;
  }

  dueReadiness(limit = 100, now = this.now()): ReadinessProjection[] {
    const bounded = Math.max(0, Math.min(100, Math.trunc(limit)));
    return (this.db.prepare(`SELECT * FROM readiness WHERE state='collecting' AND next_review_at IS NOT NULL AND next_review_at<=? ORDER BY next_review_at,cluster_id LIMIT ?`)
      .all(now, bounded) as Record<string, unknown>[]).map(row => this.readinessFromRow(row));
  }

  recordCollectingEvaluation(clusterId: string, input: { reason: string; nextReviewAt: number }): ReadinessProjection {
    const now = this.now();
    const result = this.db.prepare(`UPDATE readiness SET last_evaluated_at=?,next_review_at=?,reason_code=? WHERE cluster_id=? AND state='collecting'`)
      .run(now, input.nextReviewAt, clamp(input.reason, 200), clusterId);
    if (result.changes !== 1) throw new DrainConflictError('readiness is not collecting');
    return this.getReadiness(clusterId)!;
  }

  readyReadiness(limit = 250): ReadinessProjection[] {
    const bounded = Math.max(0, Math.min(250, Math.trunc(limit)));
    return (this.db.prepare(`SELECT * FROM readiness WHERE state='ready' ORDER BY entered_at,cluster_id LIMIT ?`)
      .all(bounded) as Record<string, unknown>[]).map((row) => this.readinessFromRow(row));
  }

  enqueue(input: { clusterId: string; title: string; summary: string; priority: string; reportCount: number; firstSeenAt: number; lastSeenAt: number; authorityRef: string; evidenceRef: string }): FeedbackWork {
    const result = this.db.transaction(() => {
      const readiness = this.getReadiness(input.clusterId);
      if (!readiness || !['ready', 'queued'].includes(readiness.state)) throw new DrainConflictError('cluster is not ready');
      const key = `feedback-work:${input.clusterId}:${readiness.epoch}`;
      const existing = this.workByKey(key);
      if (existing) return existing;
      if (readiness.state !== 'ready') throw new DrainConflictError('queued readiness has no work row');
      const now = this.now();
      const workId = this.idFactory();
      this.db.prepare(`INSERT INTO work(work_id,idempotency_key,cluster_id,readiness_epoch,state,title,summary,priority,report_count,first_seen_at,last_seen_at,authority_ref,evidence_ref,created_at,updated_at)
        VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?)`).run(workId, key, input.clusterId, readiness.epoch,
          clamp(input.title, 240), clamp(input.summary, 2000), clamp(input.priority, 40), Math.max(0, Math.trunc(input.reportCount)),
          input.firstSeenAt, input.lastSeenAt, clamp(input.authorityRef, 300), clamp(input.evidenceRef, 300), now, now);
      this.inject('enqueue-after-work');
      this.db.prepare(`UPDATE readiness SET state='queued',entered_at=?,reason_code='work-enqueued' WHERE cluster_id=? AND state='ready' AND epoch=?`).run(now, input.clusterId, readiness.epoch);
      this.inject('enqueue-after-readiness');
      this.db.prepare(`INSERT INTO artifact_links(work_id,state,external_key,updated_at) VALUES (?,'pending',?,?)`).run(workId, key, now);
      this.inject('enqueue-after-link');
      this.audit('work', workId, null, 'queued', 'readiness-enqueued');
      return this.workById(workId)!;
    }).immediate();
    this.inject('enqueue-after-commit');
    return result;
  }

  workById(workId: string): FeedbackWork | null {
    const row = this.db.prepare('SELECT * FROM work WHERE work_id=?').get(workId) as Record<string, unknown> | undefined;
    return row ? this.workFromRow(row) : null;
  }

  workByKey(key: string): FeedbackWork | null {
    const row = this.db.prepare('SELECT * FROM work WHERE idempotency_key=?').get(key) as Record<string, unknown> | undefined;
    return row ? this.workFromRow(row) : null;
  }

  isRetiredWorkKey(key: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 found FROM work_tombstones WHERE idempotency_key=?').get(key));
  }

  claimNext(input: { consumerId: string; ownerAuthorityEpoch: number; leaseMs: number; now?: number }): Claim | null {
    const claim = this.db.transaction(() => {
      this.assertOrInitializeOwnerAuthorityEpoch(input.ownerAuthorityEpoch);
      const now = input.now ?? this.now();
      const row = this.db.prepare(`SELECT work_id FROM work WHERE state IN ('queued','retryable') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,work_id LIMIT 1`).get(now) as { work_id: string } | undefined;
      if (!row) return null;
      const token = this.tokenFactory();
      const tokenHash = this.hashToken(token);
      const result = this.db.prepare(`UPDATE work SET state='claimed',lease_epoch=lease_epoch+1,lease_expires_at=?,consumer_id=?,token_hash=?,owner_authority_epoch=?,attempts=attempts+1,claimed_at=?,updated_at=?
        WHERE work_id=? AND state IN ('queued','retryable') AND (next_attempt_at IS NULL OR next_attempt_at<=?)`)
        .run(now + Math.max(1, input.leaseMs), clamp(input.consumerId, 200), tokenHash, input.ownerAuthorityEpoch, now, now, row.work_id, now);
      if (result.changes !== 1) throw new DrainConflictError('claim lost');
      this.inject('claim-after-update');
      this.audit('work', row.work_id, null, 'claimed', 'consumer-claim');
      return { ...this.workById(row.work_id)!, claimToken: token };
    }).immediate();
    this.inject('claim-after-commit');
    return claim;
  }

  /** Exercise the real claim/link/ack FSM in an isolated ephemeral database. */
  simulateClaims(input: { limit: number; ownerAuthorityEpoch: number; now?: number }): number {
    const limit = Math.max(0, Math.min(50, Math.trunc(input.limit)));
    const rows = this.db.prepare(`SELECT * FROM work WHERE state IN ('queued','retryable') AND (next_attempt_at IS NULL OR next_attempt_at<=?) ORDER BY created_at,work_id LIMIT ?`)
      .all(input.now ?? this.now(), limit) as Record<string, unknown>[];
    const simulation = new FeedbackDrainStore({ dbPath: ':memory:', tokenHmacKey: this.hmacKey, clock: this.now });
    let simulated = 0;
    try {
      const insertWork = simulation.db.prepare(`INSERT INTO work(work_id,idempotency_key,cluster_id,readiness_epoch,state,title,summary,priority,report_count,first_seen_at,last_seen_at,authority_ref,evidence_ref,lease_epoch,attempts,next_attempt_at,created_at,updated_at)
        VALUES (?,?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,NULL,?,?)`);
      const insertLink = simulation.db.prepare(`INSERT INTO artifact_links(work_id,state,external_key,updated_at) VALUES (?,'pending',?,?)`);
      for (const row of rows) {
        insertWork.run(row.work_id, row.idempotency_key, row.cluster_id, row.readiness_epoch, row.title, row.summary,
          row.priority, row.report_count, row.first_seen_at, row.last_seen_at, row.authority_ref, row.evidence_ref,
          row.lease_epoch, row.attempts, row.created_at, row.updated_at);
        insertLink.run(row.work_id, row.idempotency_key, row.updated_at);
      }
      for (let i = 0; i < limit; i++) {
        const claim = simulation.claimNext({ consumerId: 'initiative-simulation', ownerAuthorityEpoch: input.ownerAuthorityEpoch, leaseMs: 30_000, now: input.now });
        if (!claim) break;
        simulation.markArtifactReadable({
          workId: claim.workId, leaseEpoch: claim.leaseEpoch, claimToken: claim.claimToken,
          ownerAuthorityEpoch: input.ownerAuthorityEpoch, artifactId: `simulation:${claim.workId}`, artifactKind: 'simulation',
        });
        simulation.complete({ workId: claim.workId, leaseEpoch: claim.leaseEpoch, claimToken: claim.claimToken, ownerAuthorityEpoch: input.ownerAuthorityEpoch });
        simulated++;
      }
    } finally {
      simulation.close();
    }
    return simulated;
  }

  markArtifactReadable(input: { workId: string; leaseEpoch: number; claimToken: string; ownerAuthorityEpoch: number; artifactId: string; artifactKind: string }): void {
    this.db.transaction(() => {
      this.assertCurrentClaim(input);
      const now = this.now();
      const result = this.db.prepare(`UPDATE artifact_links SET state='readable',artifact_id=?,artifact_kind=?,verified_at=?,updated_at=? WHERE work_id=? AND state IN ('pending','degraded','readable')`)
        .run(clamp(input.artifactId, 300), clamp(input.artifactKind, 80), now, now, input.workId);
      if (result.changes !== 1) throw new DrainConflictError('artifact link is held or missing');
      this.inject('artifact-link-after-update');
    }).immediate();
    this.inject('artifact-link-after-commit');
  }

  complete(input: { workId: string; leaseEpoch: number; claimToken: string; ownerAuthorityEpoch: number }): FeedbackWork {
    const completed = this.db.transaction(() => {
      this.assertCurrentClaim(input);
      const link = this.db.prepare(`SELECT state,artifact_id FROM artifact_links WHERE work_id=?`).get(input.workId) as { state: LinkState; artifact_id: string | null } | undefined;
      if (!link || link.state !== 'readable' || !link.artifact_id) throw new DrainConflictError('readable artifact linkage is required');
      const now = this.now();
      const result = this.db.prepare(`UPDATE work SET state='completed',token_hash=NULL,lease_expires_at=NULL,completed_at=?,updated_at=? WHERE work_id=? AND state='claimed' AND lease_epoch=? AND owner_authority_epoch=?`)
        .run(now, now, input.workId, input.leaseEpoch, input.ownerAuthorityEpoch);
      if (result.changes !== 1) throw new DrainConflictError('claim is stale');
      this.inject('completion-after-update');
      this.audit('work', input.workId, 'claimed', 'completed', 'artifact-readable');
      return this.workById(input.workId)!;
    }).immediate();
    this.inject('completion-after-commit');
    return completed;
  }

  retry(input: { workId: string; leaseEpoch: number; claimToken: string; ownerAuthorityEpoch: number; retryAt: number; maxAttempts: number; reason: string }): FeedbackWork {
    const retried = this.db.transaction(() => {
      this.assertCurrentClaim(input);
      const work = this.workById(input.workId)!;
      const next: WorkState = work.attempts >= input.maxAttempts ? 'dead-lettered' : 'retryable';
      const now = this.now();
      this.db.prepare(`UPDATE work SET state=?,token_hash=NULL,lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE work_id=? AND state='claimed' AND lease_epoch=? AND owner_authority_epoch=?`)
        .run(next, next === 'retryable' ? input.retryAt : null, now, input.workId, input.leaseEpoch, input.ownerAuthorityEpoch);
      this.inject('retry-after-update');
      this.audit('work', input.workId, 'claimed', next, input.reason);
      return this.workById(input.workId)!;
    }).immediate();
    this.inject('retry-after-commit');
    return retried;
  }

  holdWork(workId: string, reason: string): FeedbackWork {
    const current = this.workById(workId);
    if (!current || ['completed', 'dead-lettered', 'held'].includes(current.state)) throw new DrainConflictError('work is terminal or missing');
    const now = this.now();
    this.db.prepare(`UPDATE work SET state='held',lease_epoch=lease_epoch+1,token_hash=NULL,lease_expires_at=NULL,next_attempt_at=NULL,updated_at=? WHERE work_id=?`).run(now, workId);
    this.db.prepare(`UPDATE artifact_links SET state='held',updated_at=? WHERE work_id=?`).run(now, workId);
    this.audit('work', workId, current.state, 'held', reason);
    return this.workById(workId)!;
  }

  reconcileExpiredLeases(input: { now?: number; limit?: number; retryDelayMs: number; maxAttempts: number }): { reconciled: number; retryable: number; deadLettered: number } {
    return this.db.transaction(() => {
      const now = input.now ?? this.now();
      const limit = Math.max(0, Math.min(100, Math.trunc(input.limit ?? 100)));
      const rows = this.db.prepare(`SELECT work_id,attempts FROM work WHERE state='claimed' AND lease_expires_at<=? ORDER BY lease_expires_at,work_id LIMIT ?`).all(now, limit) as Array<{ work_id: string; attempts: number }>;
      let retryable = 0; let deadLettered = 0;
      for (const row of rows) {
        const next = row.attempts >= input.maxAttempts ? 'dead-lettered' : 'retryable';
        this.db.prepare(`UPDATE work SET state=?,lease_epoch=lease_epoch+1,token_hash=NULL,lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE work_id=? AND state='claimed' AND lease_expires_at<=?`)
          .run(next, next === 'retryable' ? now + input.retryDelayMs : null, now, row.work_id, now);
        this.audit('work', row.work_id, 'claimed', next, 'lease-expired');
        if (next === 'retryable') retryable++; else deadLettered++;
      }
      return { reconciled: rows.length, retryable, deadLettered };
    }).immediate();
  }

  /**
   * Complete the safety-critical part of a restored DB admission. A restore
   * never reuses pre-restore writer or claim fences: integrity is checked,
   * the owner epoch advances exactly once, active runs are abandoned, and
   * every outstanding claim token is invalidated before another claim opens.
   */
  finalizeRestore(input: { restoredOwnerAuthorityEpoch: number; operatorDecisionRef: string; snapshotId?: string; manifestChecksum?: string;
    oldOwnerQuiesced?: boolean; splitBrainRecoveryPacket?: { incidentId: string; oldOwnerStatus: 'unreachable-or-fenced'; operatorDecisionRef: string } }): {
    ownerAuthorityEpoch: number; invalidatedClaims: number; abandonedRuns: number;
  } {
    if (!this.integrityCheck()) throw new DrainConflictError('restored database failed integrity_check');
    if (!Number.isSafeInteger(input.restoredOwnerAuthorityEpoch) || input.restoredOwnerAuthorityEpoch < 1) {
      throw new Error('restoredOwnerAuthorityEpoch must be a positive safe integer');
    }
    if (!clamp(input.operatorDecisionRef, 300)) throw new Error('operatorDecisionRef is required');
    if (this.dbPath !== ':memory:') {
    const checkpointPath = path.join(path.dirname(this.dbPath), 'feedback-drain-checkpoint.json');
    let checkpoint: { schemaVersion: number; snapshotId: string; checksum: string; dbFileIdentity: string; ownerAuthorityEpoch: number; createdAt: string; manifestChecksum: string };
    try { checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8')) as typeof checkpoint; }
    catch { throw new DrainConflictError('restored checkpoint manifest is missing or malformed'); }
    const payload = { schemaVersion: checkpoint.schemaVersion, snapshotId: checkpoint.snapshotId, checksum: checkpoint.checksum, dbFileIdentity: checkpoint.dbFileIdentity,
      ownerAuthorityEpoch: checkpoint.ownerAuthorityEpoch, createdAt: checkpoint.createdAt };
    const expectedManifest = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const restoredDbChecksum = createHash('sha256').update(fs.readFileSync(this.dbPath)).digest('hex');
    if (checkpoint.schemaVersion !== 1 || checkpoint.manifestChecksum !== expectedManifest || input.manifestChecksum !== checkpoint.manifestChecksum ||
        input.snapshotId !== checkpoint.snapshotId || checkpoint.checksum !== restoredDbChecksum || checkpoint.ownerAuthorityEpoch !== input.restoredOwnerAuthorityEpoch ||
        checkpoint.dbFileIdentity === `${fs.statSync(this.dbPath).dev}:${fs.statSync(this.dbPath).ino}`) {
      throw new DrainConflictError('restored checkpoint identity or checksum verification failed');
    }
    }
    const recovery = input.splitBrainRecoveryPacket;
    if (!input.oldOwnerQuiesced && (!recovery || recovery.oldOwnerStatus !== 'unreachable-or-fenced' ||
        recovery.operatorDecisionRef !== input.operatorDecisionRef || !/^[-A-Za-z0-9._:]{8,200}$/.test(recovery.incidentId))) {
      throw new DrainConflictError('old-owner quiescence or an explicit split-brain recovery packet is required');
    }
    const restored = this.db.transaction(() => {
      const recorded = this.ownerAuthorityEpoch();
      if (recorded !== null && recorded !== input.restoredOwnerAuthorityEpoch) {
        throw new DrainConflictError('restored owner authority epoch does not match the durable snapshot');
      }
      const now = this.now();
      const nextEpoch = input.restoredOwnerAuthorityEpoch + 1;
      const claims = this.db.prepare(`SELECT work_id FROM work WHERE state='claimed' ORDER BY work_id`).all() as Array<{ work_id: string }>;
      for (const claim of claims) {
        this.db.prepare(`UPDATE work SET state='retryable',lease_epoch=lease_epoch+1,token_hash=NULL,
          lease_expires_at=NULL,next_attempt_at=?,updated_at=? WHERE work_id=? AND state='claimed'`)
          .run(now, now, claim.work_id);
        this.audit('work', claim.work_id, 'claimed', 'retryable', 'restore-invalidated-claim');
      }
      this.inject('restore-after-claims');
      const activeRuns = this.db.prepare(`SELECT run_id,state FROM drain_runs WHERE state IN ('accepted','running') ORDER BY run_id`).all() as Array<{ run_id: string; state: 'accepted' | 'running' }>;
      for (const run of activeRuns) {
        this.db.prepare(`UPDATE drain_runs SET state='abandoned',reason='restore-epoch-bump',updated_at=? WHERE run_id=? AND state=?`).run(now, run.run_id, run.state);
      }
      this.inject('restore-after-runs');
      this.setMeta('owner_authority_epoch', String(nextEpoch));
      this.inject('restore-after-epoch');
      this.audit('restore', input.operatorDecisionRef, String(input.restoredOwnerAuthorityEpoch), String(nextEpoch), 'restore-owner-epoch-bump');
      return { ownerAuthorityEpoch: nextEpoch, invalidatedClaims: claims.length, abandonedRuns: activeRuns.length };
    }).immediate();
    this.inject('restore-after-commit');
    return restored;
  }

  ownerAuthorityEpoch(): number | null {
    const row = this.db.prepare(`SELECT value FROM drain_meta WHERE key='owner_authority_epoch'`).get() as { value: string } | undefined;
    if (!row) return null;
    const value = Number(row.value);
    if (!Number.isSafeInteger(value) || value < 1) throw new DrainConflictError('durable owner authority epoch is corrupt');
    return value;
  }

  /**
   * Reconcile the SQLite saga side with InitiativeTracker's immutable exact
   * key. Ambiguous, missing, unreadable, or conflicting links are held (or
   * marked degraded for immutable completed history); they are never treated
   * as permission to create another Initiative.
   */
  reconcileInitiativeLinks(input: {
    lookupByFeedbackWorkKey: (feedbackWorkKey: string) => readonly InitiativeLinkObservation[];
    limit?: number;
  }): InitiativeLinkReconciliationResult {
    const limit = Math.max(0, Math.min(500, Math.trunc(input.limit ?? 500)));
    const rows = this.db.prepare(`SELECT w.work_id,w.idempotency_key,w.state,l.state link_state,l.artifact_id
      FROM work w JOIN artifact_links l ON l.work_id=w.work_id ORDER BY w.work_id LIMIT ?`).all(limit) as Array<{
        work_id: string; idempotency_key: string; state: WorkState; link_state: LinkState; artifact_id: string | null;
      }>;
    const result: InitiativeLinkReconciliationResult = { checked: 0, linked: 0, held: 0, degraded: 0 };
    for (const row of rows) {
      result.checked++;
      let observations: readonly InitiativeLinkObservation[];
      try { observations = input.lookupByFeedbackWorkKey(row.idempotency_key); }
      catch { observations = []; }
      const exact = observations.filter((item) => item.feedbackWorkKey === row.idempotency_key && item.readable);
      const resolved = exact.length === 1 ? exact[0] : null;
      const conflicts = !resolved || (row.artifact_id !== null && row.artifact_id !== resolved.artifactId);
      if (conflicts) {
        if (row.state === 'completed') {
          this.db.prepare(`UPDATE artifact_links SET state='degraded',updated_at=? WHERE work_id=?`).run(this.now(), row.work_id);
          this.audit('artifact-link', row.work_id, row.link_state, 'degraded', exact.length > 1 ? 'duplicate-feedback-work-key' : 'initiative-link-unresolved');
          result.degraded++;
        } else if (!['held', 'dead-lettered'].includes(row.state)) {
          this.holdWork(row.work_id, exact.length > 1 ? 'duplicate-feedback-work-key' : 'initiative-link-unresolved');
          result.held++;
        } else {
          this.db.prepare(`UPDATE artifact_links SET state='held',updated_at=? WHERE work_id=?`).run(this.now(), row.work_id);
          result.held++;
        }
        continue;
      }
      this.db.prepare(`UPDATE artifact_links SET state='readable',artifact_id=?,artifact_kind=?,verified_at=?,updated_at=? WHERE work_id=? AND state!='held'`)
        .run(clamp(resolved.artifactId, 300), clamp(resolved.artifactKind, 80), this.now(), this.now(), row.work_id);
      result.linked++;
    }
    return result;
  }

  startRun(input: { ownerHost: string; ownerEpoch: number; leaseMs: number }): { runId: string; state: RunState; acquired: boolean } {
    return this.db.transaction(() => {
      const active = this.db.prepare(`SELECT run_id,state FROM drain_runs WHERE state IN ('accepted','running') LIMIT 1`).get() as { run_id: string; state: RunState } | undefined;
      if (active) return { runId: active.run_id, state: active.state, acquired: false };
      const now = this.now(); const runId = `run:${randomUUID()}`;
      this.db.prepare(`INSERT INTO drain_runs(run_id,state,owner_host,owner_epoch,lease_expires_at,reason,created_at,updated_at) VALUES (?,'accepted',?,?,?,?,?,?)`).run(runId, clamp(input.ownerHost, 200), input.ownerEpoch, now + input.leaseMs, '', now, now);
      return { runId, state: 'accepted' as const, acquired: true };
    }).immediate();
  }

  heartbeatRun(runId: string, ownerHost: string, ownerEpoch: number, leaseMs: number): void {
    const now = this.now();
    const result = this.db.prepare(`UPDATE drain_runs SET lease_expires_at=?,updated_at=?
      WHERE run_id=? AND state IN ('accepted','running') AND owner_host=? AND owner_epoch=?`)
      .run(now + Math.max(1, leaseMs), now, runId, clamp(ownerHost, 200), ownerEpoch);
    if (result.changes !== 1) throw new DrainConflictError('run fence is stale');
  }

  transitionRun(runId: string, from: 'accepted' | 'running', to: Exclude<RunState, 'accepted'>, reason = '', fence?: { ownerHost: string; ownerEpoch: number }): void {
    const allowed = from === 'accepted' ? new Set<RunState>(['running', 'failed', 'abandoned']) : new Set<RunState>(['succeeded', 'no-op', 'degraded', 'failed', 'abandoned']);
    if (!allowed.has(to)) throw new DrainConflictError(`invalid run transition ${from} -> ${to}`);
    this.db.transaction(() => {
      const result = fence
        ? this.db.prepare('UPDATE drain_runs SET state=?,reason=?,updated_at=? WHERE run_id=? AND state=? AND owner_host=? AND owner_epoch=?')
          .run(to, clamp(reason, 500), this.now(), runId, from, clamp(fence.ownerHost, 200), fence.ownerEpoch)
        : this.db.prepare('UPDATE drain_runs SET state=?,reason=?,updated_at=? WHERE run_id=? AND state=?').run(to, clamp(reason, 500), this.now(), runId, from);
      if (result.changes !== 1) throw new DrainConflictError('run state is stale');
      this.inject('run-after-transition');
    }).immediate();
    this.inject('run-after-commit');
  }

  requestRunCancellation(runId: string, fence: { ownerHost: string; ownerEpoch: number }): boolean {
    const now = this.now();
    const result = this.db.prepare(`UPDATE drain_runs SET cancellation_requested_at=COALESCE(cancellation_requested_at,?),updated_at=?
      WHERE run_id=? AND state IN ('accepted','running') AND owner_host=? AND owner_epoch=?`)
      .run(now, now, runId, clamp(fence.ownerHost, 200), fence.ownerEpoch);
    if (result.changes !== 1) throw new DrainConflictError('run cancellation fence is stale');
    return true;
  }

  isRunCancellationRequested(runId: string, fence: { ownerHost: string; ownerEpoch: number }): boolean {
    const row = this.db.prepare(`SELECT cancellation_requested_at FROM drain_runs WHERE run_id=? AND state IN ('accepted','running') AND owner_host=? AND owner_epoch=?`)
      .get(runId, clamp(fence.ownerHost, 200), fence.ownerEpoch) as { cancellation_requested_at: number | null } | undefined;
    if (!row) throw new DrainConflictError('run cancellation fence is stale');
    return row.cancellation_requested_at !== null;
  }

  stopCancelledRunAtBoundary(runId: string, fence: { ownerHost: string; ownerEpoch: number }): boolean {
    if (!this.isRunCancellationRequested(runId, fence)) return false;
    const row = this.db.prepare(`SELECT state FROM drain_runs WHERE run_id=?`).get(runId) as { state: 'accepted' | 'running' };
    this.transitionRun(runId, row.state, 'abandoned', 'cancelled-at-stage-boundary', fence);
    return true;
  }

  pruneOperationalHistory(input: { ownerHost: string; ownerAuthorityEpoch: number; now?: number; limit?: number }): {
    retiredWork: number; prunedAudit: number; prunedRuns: number; checkpointed: boolean;
  } {
    const now = input.now ?? this.now();
    const limit = Math.max(0, Math.min(1_000, Math.trunc(input.limit ?? 500)));
    this.assertOrInitializeOwnerAuthorityEpoch(input.ownerAuthorityEpoch);
    const foreignActive = this.db.prepare(`SELECT 1 found FROM drain_runs WHERE state IN ('accepted','running') AND (owner_host!=? OR owner_epoch!=?) LIMIT 1`)
      .get(clamp(input.ownerHost, 200), input.ownerAuthorityEpoch) as { found: 1 } | undefined;
    if (foreignActive) throw new DrainConflictError('retention writer fence is not owned');
    const queueCutoff = now - 400 * 24 * 60 * 60 * 1000;
    const runCutoff = now - 30 * 24 * 60 * 60 * 1000;
    const counts = this.db.transaction(() => {
      let remaining = limit;
      const terminal = this.db.prepare(`SELECT work_id,idempotency_key,state FROM work WHERE state IN ('completed','dead-lettered','held') AND updated_at<? ORDER BY updated_at,work_id LIMIT ?`)
        .all(queueCutoff, remaining) as Array<{ work_id: string; idempotency_key: string; state: WorkState }>;
      for (const row of terminal) {
        this.db.prepare(`INSERT OR IGNORE INTO work_tombstones VALUES (?,?,?,?)`).run(row.idempotency_key, row.work_id, row.state, now);
        this.db.prepare(`DELETE FROM artifact_links WHERE work_id=?`).run(row.work_id);
        this.db.prepare(`DELETE FROM work WHERE work_id=?`).run(row.work_id);
      }
      remaining -= terminal.length;
      const audits = this.db.prepare(`SELECT sequence FROM drain_audit WHERE created_at<? ORDER BY sequence LIMIT ?`).all(queueCutoff, remaining) as Array<{ sequence: number }>;
      for (const row of audits) this.db.prepare(`DELETE FROM drain_audit WHERE sequence=?`).run(row.sequence);
      remaining -= audits.length;
      const runs = this.db.prepare(`SELECT run_id FROM drain_runs WHERE state NOT IN ('accepted','running') AND updated_at<? ORDER BY updated_at,run_id LIMIT ?`).all(runCutoff, remaining) as Array<{ run_id: string }>;
      for (const row of runs) this.db.prepare(`DELETE FROM drain_runs WHERE run_id=?`).run(row.run_id);
      return { retiredWork: terminal.length, prunedAudit: audits.length, prunedRuns: runs.length };
    }).immediate();
    const checkpoint = this.db.pragma('wal_checkpoint(PASSIVE)') as Array<{ busy: number }>;
    return { ...counts, checkpointed: Number(checkpoint[0]?.busy ?? 1) === 0 };
  }

  abandonExpiredRuns(now = this.now(), limit = 10): number {
    const rows = this.db.prepare(`SELECT run_id,state FROM drain_runs WHERE state IN ('accepted','running') AND lease_expires_at<=? ORDER BY lease_expires_at LIMIT ?`).all(now, Math.max(0, Math.min(100, Math.trunc(limit)))) as Array<{ run_id: string; state: 'accepted' | 'running' }>;
    for (const row of rows) this.transitionRun(row.run_id, row.state, 'abandoned', 'lease-expired');
    return rows.length;
  }

  metrics(now = this.now()): DrainMetrics {
    const readiness = { collecting: 0, ready: 0, queued: 0, held: 0 };
    const work = { queued: 0, claimed: 0, completed: 0, retryable: 0, 'dead-lettered': 0, held: 0 };
    for (const row of this.db.prepare('SELECT state,COUNT(*) n FROM readiness GROUP BY state').all() as Array<{ state: ReadinessState; n: number }>) readiness[row.state] = row.n;
    for (const row of this.db.prepare('SELECT state,COUNT(*) n FROM work GROUP BY state').all() as Array<{ state: WorkState; n: number }>) work[row.state] = row.n;
    const scalar = (sql: string): number | null => (this.db.prepare(sql).get() as { value: number | null }).value;
    const age = (value: number | null): number | null => value === null ? null : Math.max(0, now - value);
    return {
      readiness, work,
      oldestReadyAgeMs: age(scalar(`SELECT MIN(entered_at) value FROM readiness WHERE state='ready'`)),
      oldestQueuedAgeMs: age(scalar(`SELECT MIN(created_at) value FROM work WHERE state IN ('queued','retryable')`)),
      oldestClaimedAgeMs: age(scalar(`SELECT MIN(updated_at) value FROM work WHERE state='claimed'`)),
      oldestFeedbackAgeMs: age(scalar(`SELECT MIN(created_at) value FROM source_projection`)),
      oldestHeldAgeMs: age(scalar(`SELECT MIN(at) value FROM (SELECT entered_at at FROM readiness WHERE state='held' UNION ALL SELECT updated_at at FROM work WHERE state='held')`)),
      oldestDeadLetterAgeMs: age(scalar(`SELECT MIN(updated_at) value FROM work WHERE state='dead-lettered'`)),
      lastEnqueuedAt: scalar(`SELECT MAX(created_at) value FROM work`),
      lastClaimedAt: scalar(`SELECT MAX(claimed_at) value FROM work WHERE attempts>0`),
      lastCompletedAt: scalar(`SELECT MAX(completed_at) value FROM work WHERE state='completed'`),
      lastSuccessfulClusteringAt: Number((this.db.prepare(`SELECT value FROM drain_meta WHERE key='last_successful_clustering_at'`).get() as { value: string } | undefined)?.value ?? 0) || null,
      lastSuccessfulEvaluationAt: scalar(`SELECT MAX(last_evaluated_at) value FROM readiness`),
      lastSourceReconciliationAt: Number((this.db.prepare(`SELECT value FROM drain_meta WHERE key='last_source_reconciliation_at'`).get() as { value: string } | undefined)?.value ?? 0) || null,
      overdueCollecting: Number((this.db.prepare(`SELECT COUNT(*) n FROM readiness WHERE state='collecting' AND next_review_at IS NOT NULL AND next_review_at<=?`).get(now) as { n: number }).n),
      oldestOverdueAgeMs: age(scalar(`SELECT MIN(next_review_at) value FROM readiness WHERE state='collecting' AND next_review_at IS NOT NULL AND next_review_at<=${Math.trunc(now)}`)),
      sourceProjectionLagBytes: Number((this.db.prepare(`SELECT value FROM drain_meta WHERE key='source_lag_bytes'`).get() as { value: string } | undefined)?.value ?? 0),
      sourceChecksumConflicts: Number((this.db.prepare(`SELECT COUNT(*) n FROM source_conflicts`).get() as { n: number }).n),
      oldestSourceConflictAgeMs: age(scalar(`SELECT MIN(created_at) value FROM source_conflicts`)),
    };
  }

  lastRun(): { runId: string; state: RunState; ownerHost: string; ownerEpoch: number; reason: string; createdAt: number; updatedAt: number; durationMs: number } | null {
    const row = this.db.prepare(`SELECT * FROM drain_runs ORDER BY created_at DESC,run_id DESC LIMIT 1`).get() as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      runId: String(row.run_id), state: row.state as RunState, ownerHost: String(row.owner_host), ownerEpoch: Number(row.owner_epoch),
      reason: String(row.reason), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
      durationMs: Math.max(0, Number(row.updated_at) - Number(row.created_at)),
    };
  }

  mutateAuthority(input: Omit<AuthorityRecord, 'generation' | 'revoked'> & { action: 'create' | 'replace' | 'revoke' | 'restore'; operatorDecisionRef: string }): AuthorityRecord {
    if (!input.operatorDecisionRef.trim()) throw new Error('operatorDecisionRef is required');
    for (const [name, value, max] of [
      ['authorityId', input.authorityId, 200], ['agentId', input.agentId, 200],
      ['ownerMachineId', input.ownerMachineId, 200], ['provider', input.provider, 80],
      ['modelFamily', input.modelFamily, 120], ['promptVersion', input.promptVersion, 120],
      ['schemaVersion', input.schemaVersion, 120], ['decisionPointId', input.decisionPointId, 160],
    ] as const) {
      if (!value.trim() || clamp(value, max) !== value.trim()) throw new Error(`${name} is invalid`);
    }
    if (!Number.isSafeInteger(input.ownerEpoch) || input.ownerEpoch < 1) throw new Error('ownerEpoch must be a positive integer');
    if (!Number.isSafeInteger(input.maxBatch) || input.maxBatch < 1 || input.maxBatch > 50) throw new Error('maxBatch must be 1..50');
    if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 128 || input.maxTokens > 100_000) throw new Error('maxTokens must be 128..100000');
    if (!Number.isFinite(input.maxDailySpendUsd) || input.maxDailySpendUsd <= 0 || input.maxDailySpendUsd > 1000) throw new Error('maxDailySpendUsd must be >0 and <=1000');
    const record = this.db.transaction(() => {
      const generation = this.authorityGeneration() + 1;
      const previous = this.latestAuthority(input.authorityId);
      if (input.action === 'create' && previous) throw new DrainConflictError('authority already exists');
      if (input.action !== 'create' && !previous) throw new DrainConflictError('authority does not exist');
      if (input.action === 'revoke' && previous?.revoked) throw new DrainConflictError('authority is already revoked');
      if (input.action === 'restore' && !previous?.revoked) throw new DrainConflictError('only a revoked authority can be restored');
      if (input.action === 'replace' && previous?.revoked) throw new DrainConflictError('restore the authority before replacing it');
      const revoked = input.action === 'revoke';
      const now = this.now();
      this.db.prepare(`INSERT INTO authority_records VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        input.authorityId, generation, input.agentId, input.ownerMachineId, input.ownerEpoch, input.provider,
        input.modelFamily, input.promptVersion, input.schemaVersion, input.decisionPointId,
        input.maxBatch, input.maxTokens, input.maxDailySpendUsd, revoked ? 1 : 0, now);
      this.db.prepare(`INSERT INTO drain_meta(key,value) VALUES ('authority_generation',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(generation));
      const payloadHash = createHash('sha256').update(canonical({ ...input, operatorDecisionRef: undefined, generation, revoked })).digest('hex');
      const prior = this.db.prepare('SELECT checksum FROM authority_audit ORDER BY sequence DESC LIMIT 1').get() as { checksum: string } | undefined;
      const previousChecksum = prior?.checksum ?? '0'.repeat(64);
      const checksum = createHash('sha256').update(`${previousChecksum}|${generation}|${input.action}|${input.authorityId}|${input.operatorDecisionRef}|${payloadHash}|${now}`).digest('hex');
      this.db.prepare(`INSERT INTO authority_audit(generation,action,authority_id,operator_decision_ref,payload_hash,previous_checksum,checksum,created_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(generation, input.action, input.authorityId, input.operatorDecisionRef, payloadHash, previousChecksum, checksum, now);
      return this.getAuthority(input.authorityId, generation)!;
    }).immediate();
    this.writeAuthorityBackup();
    return record;
  }

  authorityGeneration(): number {
    const row = this.db.prepare(`SELECT value FROM drain_meta WHERE key='authority_generation'`).get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  authorityPosture(authorityId: string, generation: number): { mode: 'active' | 'proposal-only'; reason: string; updatedAt: number } {
    const row: { mode: 'active' | 'proposal-only'; reason: string; updated_at: number } | undefined =
      this.db.prepare(`SELECT mode,reason,updated_at FROM authority_posture WHERE authority_id=? AND generation=?`).get(authorityId, generation) as { mode: 'active' | 'proposal-only'; reason: string; updated_at: number } | undefined;
    return row ? { mode: row.mode, reason: row.reason, updatedAt: row.updated_at } : { mode: 'active', reason: '', updatedAt: 0 };
  }

  demoteAuthority(authorityId: string, generation: number, reason: string): void {
    const authority = this.getAuthority(authorityId, generation);
    if (!authority || authority.revoked || this.latestAuthority(authorityId)?.generation !== generation) throw new DrainConflictError('cannot demote inactive authority');
    this.db.prepare(`INSERT INTO authority_posture(authority_id,generation,mode,reason,updated_at) VALUES (?,?,'proposal-only',?,?)
      ON CONFLICT(authority_id,generation) DO UPDATE SET mode='proposal-only',reason=excluded.reason,updated_at=excluded.updated_at`)
      .run(authorityId, generation, clamp(reason, 200), this.now());
    this.audit('authority', `${authorityId}:${generation}`, 'active', 'proposal-only', reason);
  }

  getAuthority(authorityId: string, generation?: number): AuthorityRecord | null {
    const row = generation === undefined
      ? this.db.prepare('SELECT * FROM authority_records WHERE authority_id=? ORDER BY generation DESC LIMIT 1').get(authorityId) as Record<string, unknown> | undefined
      : this.db.prepare('SELECT * FROM authority_records WHERE authority_id=? AND generation=?').get(authorityId, generation) as Record<string, unknown> | undefined;
    return row ? this.authorityFromRow(row) : null;
  }

  verifyAuthorityAudit(): boolean {
    const rows = this.db.prepare('SELECT * FROM authority_audit ORDER BY sequence').all() as Record<string, unknown>[];
    let previous = '0'.repeat(64);
    for (const row of rows) {
      if (row.previous_checksum !== previous) return false;
      const expected = createHash('sha256').update(`${previous}|${row.generation}|${row.action}|${row.authority_id}|${row.operator_decision_ref}|${row.payload_hash}|${row.created_at}`).digest('hex');
      if (expected !== row.checksum) return false;
      previous = String(row.checksum);
    }
    return true;
  }

  /** Fail-closed reservation against the authority's independent UTC-day cap. */
  reserveAuthoritySpend(authority: AuthorityRecord, estimatedUsd: number, decisions: number, now = this.now()): boolean {
    if (!Number.isFinite(estimatedUsd) || estimatedUsd < 0 || !Number.isSafeInteger(decisions) || decisions < 1) return false;
    const day = new Date(now).toISOString().slice(0, 10);
    return this.db.transaction(() => {
      const current = this.getAuthority(authority.authorityId, authority.generation);
      if (!current || current.revoked || current.generation !== this.latestAuthority(authority.authorityId)?.generation) return false;
      const row = this.db.prepare(`SELECT committed_usd FROM authority_daily_usage WHERE authority_id=? AND generation=? AND utc_day=?`)
        .get(authority.authorityId, authority.generation, day) as { committed_usd: number } | undefined;
      const committed = Number(row?.committed_usd ?? 0);
      if (committed + estimatedUsd > authority.maxDailySpendUsd) return false;
      this.db.prepare(`INSERT INTO authority_daily_usage(authority_id,generation,utc_day,committed_usd,decisions,updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(authority_id,generation,utc_day) DO UPDATE SET
        committed_usd=authority_daily_usage.committed_usd+excluded.committed_usd,
        decisions=authority_daily_usage.decisions+excluded.decisions,updated_at=excluded.updated_at`)
        .run(authority.authorityId, authority.generation, day, estimatedUsd, decisions, now);
      return true;
    }).immediate();
  }

  private latestAuthority(authorityId: string): AuthorityRecord | null {
    const row = this.db.prepare('SELECT * FROM authority_records WHERE authority_id=? ORDER BY generation DESC LIMIT 1').get(authorityId) as Record<string, unknown> | undefined;
    return row ? this.authorityFromRow(row) : null;
  }

  private writeAuthorityBackup(): void {
    if (!this.authorityBackupPath) return;
    const payload = {
      schemaVersion: 1,
      generation: this.authorityGeneration(),
      records: this.db.prepare('SELECT * FROM authority_records ORDER BY generation,authority_id').all(),
      audit: this.db.prepare('SELECT * FROM authority_audit ORDER BY sequence').all(),
    };
    const envelope = { ...payload, checksum: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
    fs.mkdirSync(path.dirname(this.authorityBackupPath), { recursive: true });
    const tmp = `${this.authorityBackupPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.authorityBackupPath);
  }

  private restoreAuthorityBackupIfEmpty(): void {
    if (!this.authorityBackupPath || !fs.existsSync(this.authorityBackupPath) || this.authorityGeneration() !== 0) return;
    let envelope: Record<string, unknown>;
    try { envelope = JSON.parse(fs.readFileSync(this.authorityBackupPath, 'utf8')) as Record<string, unknown>; }
    catch { throw new Error('readiness authority backup is invalid JSON'); }
    const payload = { schemaVersion: envelope.schemaVersion, generation: envelope.generation, records: envelope.records, audit: envelope.audit };
    const expected = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (envelope.schemaVersion !== 1 || envelope.checksum !== expected || !Array.isArray(envelope.records) || !Array.isArray(envelope.audit)) {
      throw new Error('readiness authority backup checksum or schema is invalid');
    }
    this.db.transaction(() => {
      const recordInsert = this.db.prepare(`INSERT INTO authority_records(authority_id,generation,agent_id,owner_machine_id,owner_epoch,provider,model_family,prompt_version,schema_version,decision_point_id,max_batch,max_tokens,max_daily_spend_usd,revoked,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const raw of envelope.records as Record<string, unknown>[]) recordInsert.run(
        raw.authority_id, raw.generation, raw.agent_id, raw.owner_machine_id, raw.owner_epoch, raw.provider, raw.model_family,
        raw.prompt_version, raw.schema_version, raw.decision_point_id, raw.max_batch, raw.max_tokens, raw.max_daily_spend_usd, raw.revoked, raw.created_at,
      );
      const auditInsert = this.db.prepare(`INSERT INTO authority_audit(sequence,generation,action,authority_id,operator_decision_ref,payload_hash,previous_checksum,checksum,created_at) VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const raw of envelope.audit as Record<string, unknown>[]) auditInsert.run(
        raw.sequence, raw.generation, raw.action, raw.authority_id, raw.operator_decision_ref, raw.payload_hash, raw.previous_checksum, raw.checksum, raw.created_at,
      );
      this.db.prepare(`INSERT INTO drain_meta(key,value) VALUES ('authority_generation',?)`).run(String(envelope.generation));
      if (!this.verifyAuthorityAudit()) throw new Error('readiness authority backup audit chain is invalid');
    }).immediate();
  }

  private holdReadinessInternal(clusterId: string, reason: string): ReadinessProjection {
    const current = this.getReadiness(clusterId);
    if (!current || !['collecting', 'ready', 'queued'].includes(current.state)) throw new DrainConflictError('readiness cannot be held');
    const now = this.now();
    this.db.prepare(`UPDATE readiness SET state='held',entered_at=?,reason_code=? WHERE cluster_id=?`).run(now, clamp(reason, 200), clusterId);
    if (current.state === 'queued') {
      const work = this.db.prepare(`SELECT work_id FROM work WHERE cluster_id=? AND readiness_epoch=?`).get(clusterId, current.epoch) as { work_id: string } | undefined;
      if (work) this.holdWork(work.work_id, reason);
    }
    this.audit('readiness', clusterId, current.state, 'held', reason);
    return this.getReadiness(clusterId)!;
  }

  private assertCurrentClaim(input: { workId: string; leaseEpoch: number; claimToken: string; ownerAuthorityEpoch: number }): void {
    const currentOwnerEpoch = this.ownerAuthorityEpoch();
    const row = this.db.prepare(`SELECT state,lease_epoch,token_hash,owner_authority_epoch FROM work WHERE work_id=?`).get(input.workId) as { state: WorkState; lease_epoch: number; token_hash: string | null; owner_authority_epoch: number | null } | undefined;
    const candidate = this.hashToken(input.claimToken);
    const persisted = row?.token_hash ?? '0'.repeat(64);
    const sameToken = timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(persisted, 'hex'));
    if (currentOwnerEpoch !== input.ownerAuthorityEpoch || !row || row.state !== 'claimed' || row.lease_epoch !== input.leaseEpoch || row.owner_authority_epoch !== input.ownerAuthorityEpoch || !sameToken) {
      throw new DrainConflictError('claim is stale or invalid');
    }
  }

  private assertOrInitializeOwnerAuthorityEpoch(epoch: number): void {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new DrainConflictError('owner authority epoch is invalid');
    const current = this.ownerAuthorityEpoch();
    if (current === null) this.setMeta('owner_authority_epoch', String(epoch));
    else if (current !== epoch) throw new DrainConflictError('owner authority epoch is stale');
  }

  private hashToken(token: string): string { return createHmac('sha256', this.hmacKey).update(token).digest('hex'); }
  private inject(point: FeedbackDrainCrashPoint): void { this.crashInjector?.(point); }
  private ensureSchemaUpgrades(): void {
    const columns = new Set((this.db.pragma('table_info(readiness_approvals)') as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has('decision_nonce')) this.db.exec(`ALTER TABLE readiness_approvals ADD COLUMN decision_nonce TEXT NOT NULL DEFAULT ''`);
    if (!columns.has('proposal_set_hash')) this.db.exec(`ALTER TABLE readiness_approvals ADD COLUMN proposal_set_hash TEXT NOT NULL DEFAULT ''`);
    const projectionColumns = new Set((this.db.pragma('table_info(source_projection)') as Array<{ name: string }>).map((row) => row.name));
    if (!projectionColumns.has('record_json')) this.db.exec(`ALTER TABLE source_projection ADD COLUMN record_json TEXT NOT NULL DEFAULT '{}'`);
    const runColumns = new Set((this.db.pragma('table_info(drain_runs)') as Array<{ name: string }>).map((row) => row.name));
    if (!runColumns.has('cancellation_requested_at')) this.db.exec(`ALTER TABLE drain_runs ADD COLUMN cancellation_requested_at INTEGER`);
  }
  private setMeta(key: string, value: string): void {
    this.db.prepare(`INSERT INTO drain_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, value);
  }
  private audit(kind: string, entityId: string, from: string | null, to: string, reason: string): void {
    this.db.prepare('INSERT INTO drain_audit(kind,entity_id,from_state,to_state,reason,created_at) VALUES (?,?,?,?,?,?)')
      .run(kind, entityId, from, to, clamp(reason, 500), this.now());
  }

  private readinessFromRow(row: Record<string, unknown>): ReadinessProjection {
    return { clusterId: String(row.cluster_id), state: row.state as ReadinessState, epoch: Number(row.epoch), enteredAt: Number(row.entered_at), lastEvaluatedAt: row.last_evaluated_at === null ? null : Number(row.last_evaluated_at), nextReviewAt: row.next_review_at === null ? null : Number(row.next_review_at), reasonCode: String(row.reason_code) };
  }

  private workFromRow(row: Record<string, unknown>): FeedbackWork {
    return { workId: String(row.work_id), idempotencyKey: String(row.idempotency_key), clusterId: String(row.cluster_id), readinessEpoch: Number(row.readiness_epoch), state: row.state as WorkState, title: String(row.title), summary: String(row.summary), priority: String(row.priority), reportCount: Number(row.report_count), firstSeenAt: Number(row.first_seen_at), lastSeenAt: Number(row.last_seen_at), authorityRef: String(row.authority_ref), evidenceRef: String(row.evidence_ref), leaseEpoch: Number(row.lease_epoch), leaseExpiresAt: row.lease_expires_at === null ? null : Number(row.lease_expires_at), consumerId: row.consumer_id === null ? null : String(row.consumer_id), attempts: Number(row.attempts), nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
  }

  private authorityFromRow(row: Record<string, unknown>): AuthorityRecord {
    return { authorityId: String(row.authority_id), agentId: String(row.agent_id), ownerMachineId: String(row.owner_machine_id), ownerEpoch: Number(row.owner_epoch), provider: String(row.provider), modelFamily: String(row.model_family), promptVersion: String(row.prompt_version), schemaVersion: String(row.schema_version), decisionPointId: String(row.decision_point_id), maxBatch: Number(row.max_batch), maxTokens: Number(row.max_tokens), maxDailySpendUsd: Number(row.max_daily_spend_usd), generation: Number(row.generation), revoked: Boolean(row.revoked) };
  }
}
