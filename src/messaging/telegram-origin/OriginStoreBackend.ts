/** Worker-owned SQLite implementation. The entries table is the ONE executable
 * authority; origin tables retain evidence independently of queue cleanup.
 * Spec: docs/specs/telegram-message-origin.md (binding 5, 10–13; N1–N10).
 */
import { isMainThread } from 'node:worker_threads';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PendingRelayStore } from '../pending-relay-store.js';
import { snapshotLegacyOrigin } from './OriginLegacy.js';
import type { OriginLegacySnapshot } from './OriginLegacy.js';
import { advanceBrowserRecovery, type BrowserRecoveryState, type BrowserRecoveryAction, type BrowserRecoveryDecision } from './OriginBrowserRecovery.js';
import type {
  AdmissionResult, ArchiveResult, ChildOutcome, ClaimFence, ClaimInput, ClaimResult,
  DerivedMaterializationInput, EvidenceReceipt, NoticeReservation, NoticeReservationInput,
  OriginAdmission, OriginAuditRecord, OriginAcceptanceVerification, OriginListPage, OriginListQuery, OriginMetrics,
  OriginStoreOptions, OutcomeInput, OutcomeWriteResult, StoredChild, StoredMaterializationInput, StoredOriginInput,
} from './StoreTypes.js';

const SIX_HOURS = 6 * 60 * 60_000;
const MAX_LEASE_MS = 60_000;
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_READ_BYTES = 64 * 1024 * 1024;
const MAX_AUDIT_PAGE_BYTES = 2 * 1024 * 1024;
const digest = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const fail = (code: string): never => { throw new Error(`origin-store:${code}`); };
function id(value: string): void { if (typeof value !== 'string' || !value.length || value.length > 256) fail('invalid-id'); }
function integer(value: number, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('invalid-bound');
}
function json(value: string, maxBytes: number): void {
  if (typeof value !== 'string' || Buffer.byteLength(value) > maxBytes) fail('invalid-json-size');
  JSON.parse(value);
}
function seal(value: string, hash: string): void {
  if (!/^[a-f0-9]{64}$/.test(hash) || digest(value) !== hash) fail('digest-mismatch');
}
type DbOrigin = { sequence: number; origin_id: string; machine_id: string; created_at: number; envelope_digest: string; record_json: string | null; archive_id: string | null };
type DbOperation = { operation_id: string; origin_id: string; admission_digest: string; prepared_at: number; deadline_at: number; max_attempts: number; payload_bytes: number; state: string; kind: string };
type DbChild = { child_id: string; operation_id: string; delivery_id: string; destination_json: string; content_digest: string; generation: number; state: string; allowed_derivations: string };
type DbEntry = { state: string; claimed_by: string | null; attempts: number; next_attempt_at: string | null; entry_kind: string; owner_boot_id: string | null; lease_until: number | null };
type DbMaterialization = { materialization_id: string; child_id: string; generation: number; request_json: string | null; request_digest: string; dispatch_deadline: number | null };
type DbAttempt = { attempt_id: string; child_id: string; materialization_id: string; claim_token: string; owner_boot_id: string; phase: string; outcome: string | null; receipt_json: string | null; created_at: number; resolved_at: number | null };

export class OriginStoreBackend {
  private readonly queue: PendingRelayStore;
  private readonly db: Database.Database;
  private readonly options: Required<Pick<OriginStoreOptions, 'maxOperations' | 'maxPayloadBytes' | 'maxChildren' | 'maxNoticeReservations' | 'maxNoticeBytes'>>;
  private readonly archiveDir: string;
  private archiveReadScope?: { handles: Map<string, Database.Database>; bytes: number };
  private readonly archiveReadStats = { filesVerified: 0, bytesHashed: 0 };

  constructor(options: OriginStoreOptions) {
    if (isMainThread) fail('worker-required');
    this.options = {
      maxOperations: options.maxOperations ?? 1000,
      maxPayloadBytes: options.maxPayloadBytes ?? 256 * 1024 * 1024,
      maxChildren: options.maxChildren ?? 100,
      maxNoticeReservations: options.maxNoticeReservations ?? 1000,
      maxNoticeBytes: options.maxNoticeBytes ?? 8 * 1024 * 1024,
    };
    for (const value of Object.values(this.options)) integer(value, 1, Number.MAX_SAFE_INTEGER);
    this.archiveDir = path.join(options.stateDir, 'state', 'telegram-origin-archives', options.agentId.replace(/[^A-Za-z0-9._-]/g, '_'));
    this.queue = PendingRelayStore.open(options.agentId, options.stateDir, { durability: 'FULL', busyTimeoutMs: 25 });
    this.db = this.queue.rawDb();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telegram_origins (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT, origin_id TEXT NOT NULL UNIQUE,
        machine_id TEXT NOT NULL, created_at INTEGER NOT NULL, envelope_digest TEXT NOT NULL,
        record_json TEXT, archive_id TEXT);
      CREATE INDEX IF NOT EXISTS telegram_origin_sort ON telegram_origins(created_at,machine_id,origin_id);
      CREATE INDEX IF NOT EXISTS telegram_origin_evidence_operation ON telegram_origins(
        json_extract(json_extract(record_json,'$.envelopeJson'),'$.operationId')) WHERE record_json IS NOT NULL;
      CREATE TABLE IF NOT EXISTS telegram_origin_verifications (
        origin_id TEXT PRIMARY KEY, evidence_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_origin_audit_assertions (
        slot INTEGER PRIMARY KEY, jti TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_origin_diagnostics (
        origin_id TEXT PRIMARY KEY, state TEXT NOT NULL, reason TEXT NOT NULL,
        created_at INTEGER NOT NULL, resolved_at INTEGER, diagnosis TEXT);
      CREATE TABLE IF NOT EXISTS telegram_origin_destinations (
        origin_id TEXT PRIMARY KEY, transport TEXT NOT NULL, account_id TEXT NOT NULL, chat_id TEXT, topic_id TEXT);
      CREATE INDEX IF NOT EXISTS telegram_origin_destination_lookup ON telegram_origin_destinations(transport,account_id,chat_id,topic_id,origin_id);
      CREATE TABLE IF NOT EXISTS telegram_origin_outcome_details (
        attempt_id TEXT PRIMARY KEY, reason TEXT, next_attempt_at INTEGER);
      CREATE TABLE IF NOT EXISTS telegram_origin_browser_recovery (profile_id TEXT PRIMARY KEY, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_origin_operations (
        operation_id TEXT PRIMARY KEY, origin_id TEXT NOT NULL UNIQUE, admission_digest TEXT NOT NULL,
        prepared_at INTEGER NOT NULL, deadline_at INTEGER NOT NULL, max_attempts INTEGER NOT NULL,
        payload_bytes INTEGER NOT NULL, state TEXT NOT NULL, kind TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS telegram_origin_operation_state ON telegram_origin_operations(kind,state,deadline_at);
      CREATE TABLE IF NOT EXISTS telegram_origin_payloads (
        payload_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, digest TEXT NOT NULL, size INTEGER NOT NULL, data BLOB);
      CREATE INDEX IF NOT EXISTS telegram_origin_payload_operation ON telegram_origin_payloads(operation_id);
      CREATE INDEX IF NOT EXISTS telegram_origin_payload_live ON telegram_origin_payloads(operation_id) WHERE data IS NOT NULL;
      CREATE TABLE IF NOT EXISTS telegram_origin_children (
        child_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, delivery_id TEXT NOT NULL UNIQUE,
        destination_json TEXT NOT NULL, content_digest TEXT NOT NULL, generation INTEGER NOT NULL,
        state TEXT NOT NULL, allowed_derivations TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS telegram_origin_child_operation ON telegram_origin_children(operation_id);
      CREATE TABLE IF NOT EXISTS telegram_origin_materializations (
        materialization_id TEXT PRIMARY KEY, child_id TEXT NOT NULL, generation INTEGER NOT NULL,
        request_json TEXT, request_digest TEXT NOT NULL, dispatch_deadline INTEGER, derivation_json TEXT);
      CREATE INDEX IF NOT EXISTS telegram_origin_materialization_child ON telegram_origin_materializations(child_id,generation);
      CREATE INDEX IF NOT EXISTS telegram_origin_materialization_live ON telegram_origin_materializations(child_id) WHERE request_json IS NOT NULL;
      CREATE TABLE IF NOT EXISTS telegram_origin_attempts (
        attempt_id TEXT PRIMARY KEY, child_id TEXT NOT NULL, materialization_id TEXT NOT NULL,
        claim_token TEXT NOT NULL UNIQUE, owner_boot_id TEXT NOT NULL,
        phase TEXT NOT NULL, outcome TEXT, receipt_json TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
      CREATE INDEX IF NOT EXISTS telegram_origin_attempt_child ON telegram_origin_attempts(child_id,created_at);
      CREATE TABLE IF NOT EXISTS telegram_origin_metric_events (event_id TEXT NOT NULL, metric TEXT NOT NULL, PRIMARY KEY(event_id,metric));
      CREATE TABLE IF NOT EXISTS telegram_origin_metrics (metric TEXT PRIMARY KEY, count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_origin_health (id INTEGER PRIMARY KEY CHECK(id=1), ticked_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_origin_recovery_cursor (id INTEGER PRIMARY KEY CHECK(id=1), after_rowid INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_origin_owners (owner_boot_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS telegram_origin_platform_receipts (
        child_id TEXT NOT NULL, origin_id TEXT NOT NULL, transport TEXT NOT NULL, account_id TEXT NOT NULL,
        chat_id TEXT NOT NULL, topic_id TEXT NOT NULL, message_id TEXT NOT NULL, PRIMARY KEY(child_id,message_id));
      CREATE INDEX IF NOT EXISTS telegram_origin_receipt_namespace ON telegram_origin_platform_receipts(transport,account_id,chat_id,topic_id,message_id,origin_id);
      CREATE TABLE IF NOT EXISTS telegram_origin_notices (
        child_id TEXT PRIMARY KEY, alert_destination_id TEXT NOT NULL, generation TEXT NOT NULL,
        owner_boot_id TEXT NOT NULL, claim_token TEXT NOT NULL UNIQUE, request_bytes INTEGER NOT NULL,
        state TEXT NOT NULL, UNIQUE(alert_destination_id,generation));
      CREATE TABLE IF NOT EXISTS telegram_origin_archives (
        archive_id TEXT PRIMARY KEY, filename TEXT NOT NULL, digest TEXT NOT NULL, count INTEGER NOT NULL,
        first_sequence INTEGER NOT NULL, last_sequence INTEGER NOT NULL, committed_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS telegram_origin_entries_lane ON entries(entry_kind,state,next_attempt_at);
    `);
  }

  private event(eventId: string, metric: string): void {
    const inserted = this.db.prepare('INSERT OR IGNORE INTO telegram_origin_metric_events(event_id,metric) VALUES (?,?)').run(eventId, metric);
    if (inserted.changes) this.db.prepare('INSERT INTO telegram_origin_metrics(metric,count) VALUES (?,1) ON CONFLICT(metric) DO UPDATE SET count=count+1').run(metric);
  }
  private indexReceipt(child: DbChild, receiptJson: string): void {
    const receipt = JSON.parse(receiptJson), destination = JSON.parse(child.destination_json);
    if (!destination.transport || !destination.accountId || !destination.chatId) return;
    const values = Array.isArray(receipt.messages) ? receipt.messages : [receipt];
    if (values.length > 100) fail('receipt-cardinality');
    for (const value of values) {
      const messageId = value.messageId ?? value.result?.message_id ?? value.message_id;
      if (messageId === undefined) continue;
      this.db.prepare('INSERT OR IGNORE INTO telegram_origin_platform_receipts VALUES (?,?,?,?,?,?,?)')
        .run(child.child_id, this.operation(child.operation_id)!.origin_id, destination.transport, destination.accountId,
          destination.chatId, destination.topicId ?? '', String(messageId));
    }
  }

  private validateRecord(record: StoredOriginInput): void {
    id(record.originId); id(record.machineId); integer(record.createdAt, 0, Number.MAX_SAFE_INTEGER);
    json(record.envelopeJson, 256 * 1024); seal(record.envelopeJson, record.envelopeDigest);
    if (record.harnessId !== undefined) id(record.harnessId);
    if (record.evidenceStatus !== undefined && !['observed', 'configured', 'unknown', 'not-applicable'].includes(record.evidenceStatus)) fail('invalid-evidence-status');
  }

  putEvidence(record: StoredOriginInput): EvidenceReceipt {
    this.validateRecord(record);
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT envelope_digest FROM telegram_origins WHERE origin_id=?').get(record.originId) as { envelope_digest: string } | undefined;
      if (old) {
        if (old.envelope_digest !== record.envelopeDigest) fail('origin-id-conflict');
        return { originId: record.originId, digest: record.envelopeDigest, inserted: false, sink: 'primary' as const };
      }
      this.db.prepare('INSERT INTO telegram_origins(origin_id,machine_id,created_at,envelope_digest,record_json) VALUES (?,?,?,?,?)')
        .run(record.originId, record.machineId, record.createdAt, record.envelopeDigest, JSON.stringify(record));
      const destination = JSON.parse(record.envelopeJson).destination;
      if (destination) this.db.prepare('INSERT INTO telegram_origin_destinations VALUES (?,?,?,?,?)')
        .run(record.originId, destination.transport, destination.accountId, destination.chatId ?? null, destination.topicId ?? null);
      this.event(record.originId, 'operation:prepared');
      this.event(record.originId, `evidence:${record.harnessId ?? 'not-applicable'}:${record.evidenceStatus ?? 'unknown'}`);
      return { originId: record.originId, digest: record.envelopeDigest, inserted: true, sink: 'primary' as const };
    }).immediate();
  }

  /** A separate local receipt, never a caller-supplied field in the signed
   * envelope. The first successful acceptance verification is immutable. */
  putVerifiedEvidence(input: { record: StoredOriginInput; verification: OriginAcceptanceVerification }): EvidenceReceipt {
    const { record, verification } = input;
    this.validateRecord(record);
    id(verification.verifierMachineId); id(verification.keyId);
    integer(verification.keyEpoch, 0, Number.MAX_SAFE_INTEGER); integer(verification.verifiedAt, 0, Number.MAX_SAFE_INTEGER);
    if (verification.envelopeDigest !== record.envelopeDigest || verification.keyStatusAtAcceptance !== 'active' ||
      !/^[a-f0-9]{64}$/.test(verification.keyFingerprint)) fail('invalid-verification-evidence');
    const attestation = JSON.parse(record.envelopeJson).attestation;
    if (!attestation || attestation.keyId !== verification.keyId || attestation.keyEpoch !== verification.keyEpoch) fail('verification-key-mismatch');
    const evidenceJson = JSON.stringify(verification); json(evidenceJson, 4096);
    return this.db.transaction(() => {
      const receipt = this.putEvidence(record);
      this.db.prepare('INSERT OR IGNORE INTO telegram_origin_verifications(origin_id,evidence_json) VALUES (?,?)').run(record.originId, evidenceJson);
      return receipt;
    }).immediate();
  }

  private validateAdmission(input: OriginAdmission, notice: boolean): number {
    this.validateRecord(input.record); id(input.operationId);
    integer(input.preparedAt, 0, Number.MAX_SAFE_INTEGER);
    integer(input.deadlineAt, input.preparedAt + 1, input.preparedAt + SIX_HOURS);
    integer(input.maxAttempts, 1, 9); integer(input.payloadBytes, 0, this.options.maxPayloadBytes);
    integer(input.children.length, 1, notice ? 1 : this.options.maxChildren);
    const ids = new Set<string>();
    let bytes = 0;
    const payloadIds = new Set<string>();
    integer(input.payloads?.length ?? 0, 0, notice ? 0 : 10);
    let attachmentBytes = 0;
    for (const payload of input.payloads ?? []) {
      id(payload.payloadId); integer(payload.size, 0, 50 * 1024 * 1024);
      if (payloadIds.has(payload.payloadId) || !(payload.data instanceof Uint8Array)
        || payload.data.byteLength !== payload.size || digest(Buffer.from(payload.data)) !== payload.digest) fail('invalid-attachment-custody');
      payloadIds.add(payload.payloadId); bytes += payload.size; attachmentBytes += payload.size;
    }
    if (attachmentBytes > 64 * 1024 * 1024) fail('attachment-capacity');
    for (const child of input.children) {
      id(child.childId); id(child.deliveryId);
      if (ids.has(child.childId) || ids.has(child.deliveryId)) fail('duplicate-child');
      ids.add(child.childId); ids.add(child.deliveryId);
      json(child.destinationJson, 8192);
      if (!/^[a-f0-9]{64}$/.test(child.canonicalContentDigest)) fail('invalid-content-digest');
      integer(child.materializations.length, 1, 8);
      for (const kind of child.allowedDerivations ?? []) if (!['signature-renewal', 'companion-receipt'].includes(kind)) fail('invalid-derivation');
      for (const materialization of child.materializations) {
        this.validateMaterialization(materialization);
        bytes += Buffer.byteLength(materialization.requestJson);
      }
    }
    if (bytes > input.payloadBytes || (notice && bytes > 8192)) fail('payload-budget');
    return bytes;
  }

  private validateMaterialization(input: StoredMaterializationInput): void {
    id(input.materializationId); json(input.requestJson, this.options.maxPayloadBytes); seal(input.requestJson, input.requestDigest);
    if (input.dispatchDeadline !== undefined) integer(input.dispatchDeadline, 0, Number.MAX_SAFE_INTEGER);
  }

  admit(input: OriginAdmission): AdmissionResult { return this.admitInternal(input, false); }
  getBrowserRecoveryStates(): Array<{ profileId: string; nextAllowedAt: number; failingSince: number | null; failures: number; attentionPending: boolean; publicTransportAlternative: boolean }> {
    const rows = this.db.prepare('SELECT profile_id,state_json FROM telegram_origin_browser_recovery ORDER BY profile_id LIMIT 256').all() as Array<{ profile_id: string; state_json: string }>;
    return rows.map(row => { const state = JSON.parse(row.state_json) as BrowserRecoveryState;
      return { profileId: row.profile_id, nextAllowedAt: state.nextAllowedAt, failingSince: state.latch.failingSince,
        failures: state.latch.failures, attentionPending: state.attentionId !== null && !state.attentionAccepted,
        publicTransportAlternative: state.failedBuilds.length >= 2 }; });
  }
  browserRecovery(input: { profileId: string; action: BrowserRecoveryAction; now?: number }): BrowserRecoveryDecision {
    id(input.profileId); id(input.action.fence);
    if (input.action.kind === 'failure') id(input.action.buildId);
    const now = input.now ?? Date.now(); integer(now, 0, Number.MAX_SAFE_INTEGER);
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT state_json FROM telegram_origin_browser_recovery WHERE profile_id=?').get(input.profileId) as { state_json: string } | undefined;
      if (!row && (this.db.prepare('SELECT count(*) n FROM telegram_origin_browser_recovery').get() as { n: number }).n >= 256) fail('browser-recovery-capacity');
      const result = advanceBrowserRecovery(row ? JSON.parse(row.state_json) as BrowserRecoveryState : null, input.action, now);
      this.db.prepare('INSERT INTO telegram_origin_browser_recovery VALUES (?,?) ON CONFLICT(profile_id) DO UPDATE SET state_json=excluded.state_json')
        .run(input.profileId, JSON.stringify(result.state));
      return result;
    }).immediate();
  }

  reserveDiagnostic(input: { originId: string; reason: string }): boolean {
    id(input.originId); id(input.reason);
    return this.db.transaction(() => {
      if (!this.db.prepare('SELECT 1 FROM telegram_origins WHERE origin_id=?').get(input.originId)) return false;
      return this.db.prepare("INSERT OR IGNORE INTO telegram_origin_diagnostics VALUES (?,'pending',?,?,NULL,NULL)")
        .run(input.originId, input.reason, Date.now()).changes === 1;
    }).immediate();
  }
  undiagnosedOrigins(): Array<{ originId: string; reason: string }> {
    return this.db.prepare(`SELECT o.origin_id originId,coalesce(d.reason,'transport-acceptance-unknown') reason
      FROM telegram_origin_operations o JOIN telegram_origin_children c ON c.operation_id=o.operation_id
      JOIN telegram_origin_attempts a ON a.child_id=c.child_id
      LEFT JOIN telegram_origin_outcome_details d ON d.attempt_id=a.attempt_id
      WHERE a.outcome='outcome-unknown' AND NOT EXISTS
        (SELECT 1 FROM telegram_origin_diagnostics x WHERE x.origin_id=o.origin_id)
      GROUP BY o.origin_id ORDER BY o.rowid LIMIT 10`).all() as Array<{ originId: string; reason: string }>;
  }
  completeDiagnostic(input: { originId: string; diagnosis?: string }): boolean {
    id(input.originId);
    if (input.diagnosis !== undefined && (typeof input.diagnosis !== 'string' || Buffer.byteLength(input.diagnosis) > 8192)) fail('diagnostic-capacity');
    return this.db.prepare("UPDATE telegram_origin_diagnostics SET state=?,resolved_at=?,diagnosis=? WHERE origin_id=? AND state='pending'")
      .run(input.diagnosis === undefined ? 'unavailable' : 'complete', Date.now(), input.diagnosis ?? null, input.originId).changes === 1;
  }

  legacyCandidates(): OriginLegacySnapshot[] {
    const rows = this.db.prepare("SELECT * FROM entries WHERE entry_kind='legacy' AND state IN ('queued','claimed','delivered-ambiguous') ORDER BY attempted_at LIMIT 100").all();
    return rows.map(row => snapshotLegacyOrigin(row as import('../pending-relay-store.js').PendingRelayRow));
  }
  /** Reclassify the existing queue row inside the admission transaction. No
   * second executable copy, reset budget, or stale-snapshot takeover exists. */
  importLegacy(input: { snapshot: OriginLegacySnapshot; admission: OriginAdmission }): boolean {
    return this.db.transaction(() => {
      const row = this.queue.findByDeliveryId(input.snapshot.deliveryId);
      if (!row || row.entry_kind !== 'legacy' || !['queued', 'claimed', 'delivered-ambiguous'].includes(row.state)) return false;
      const snapshot = snapshotLegacyOrigin(row);
      if (snapshot.snapshotDigest !== input.snapshot.snapshotDigest) return false;
      if (input.admission.preparedAt !== snapshot.preparedAt || input.admission.deadlineAt > snapshot.preparedAt + SIX_HOURS ||
        input.admission.children[0]?.deliveryId !== snapshot.deliveryId) fail('legacy-budget-or-identity-changed');
      const record = JSON.parse(input.admission.record.envelopeJson);
      if (record.producerKind !== 'imported-legacy' || record.legacySnapshotDigest !== snapshot.snapshotDigest ||
        record.machine.status !== 'unknown' || record.model.status !== 'unknown' || record.harness.status !== 'unknown') fail('legacy-origin-required');
      this.admitInternal(input.admission, false, snapshot);
      const terminal = !snapshot.replaySafe || snapshot.attempts >= input.admission.maxAttempts;
      for (const child of input.admission.children) {
        this.db.prepare('UPDATE entries SET attempts=?,next_attempt_at=? WHERE delivery_id=?').run(snapshot.attempts, snapshot.nextAttemptAt, child.deliveryId);
        if (terminal) {
          this.db.prepare("UPDATE entries SET state='delivered-ambiguous',claimed_by=NULL WHERE delivery_id=?").run(child.deliveryId);
          this.db.prepare("UPDATE telegram_origin_children SET state='outcome-unknown' WHERE child_id=?").run(child.childId);
          this.event(child.childId, 'child:outcome-unknown');
        }
      }
      if (terminal) this.refreshOperation(input.admission.operationId);
      this.expireOperation(input.admission.operationId, Date.now());
      this.event(input.admission.operationId, 'operation:imported-legacy');
      return true;
    }).immediate();
  }

  healthTransaction(): void {
    this.db.transaction(() => {
      this.db.prepare('INSERT INTO telegram_origin_health VALUES (1,?) ON CONFLICT(id) DO UPDATE SET ticked_at=excluded.ticked_at').run(Date.now());
    }).immediate();
  }
  registerOwner(input: { ownerBootId: string; machineId: string }): void {
    id(input.ownerBootId); id(input.machineId);
    this.db.transaction(() => {
      const old = this.db.prepare('SELECT machine_id FROM telegram_origin_owners WHERE owner_boot_id=?').get(input.ownerBootId) as { machine_id: string } | undefined;
      if (old && old.machine_id !== input.machineId) fail('owner-identity-conflict');
      this.db.prepare('INSERT OR IGNORE INTO telegram_origin_owners VALUES (?,?)').run(input.ownerBootId, input.machineId);
    }).immediate();
  }

  private admitInternal(input: OriginAdmission, notice: boolean, legacy?: OriginLegacySnapshot): AdmissionResult {
    this.validateAdmission(input, notice);
    const admissionDigest = digest(JSON.stringify({ ...input,
      ...(input.payloads ? { payloads: input.payloads.map(({ data: _data, ...reference }) => reference) } : {}) }));
    return this.db.transaction(() => {
      const existing = this.operation(input.operationId);
      if (existing) {
        if (existing.admission_digest !== admissionDigest || existing.kind !== (notice ? 'notice' : 'ordinary')) fail('operation-id-conflict');
        return { operationId: input.operationId, originId: input.record.originId, inserted: false };
      }
      if (!notice) {
        const active = this.db.prepare("SELECT count(*) n,coalesce(sum(payload_bytes),0) bytes FROM telegram_origin_operations WHERE kind='ordinary' AND state NOT IN ('accepted','suppressed','expired','known-failed')").get() as { n: number; bytes: number };
        if (active.n >= this.options.maxOperations || active.bytes + input.payloadBytes > this.options.maxPayloadBytes) fail('capacity-unavailable');
      }
      this.putEvidence(input.record);
      this.db.prepare('INSERT INTO telegram_origin_operations VALUES (?,?,?,?,?,?,?,?,?)')
        .run(input.operationId, input.record.originId, admissionDigest, input.preparedAt, input.deadlineAt, input.maxAttempts, input.payloadBytes, 'admitted', notice ? 'notice' : 'ordinary');
      for (const payload of input.payloads ?? []) this.db.prepare('INSERT INTO telegram_origin_payloads VALUES (?,?,?,?,?)')
        .run(payload.payloadId, input.operationId, payload.digest, payload.size, Buffer.from(payload.data));
      for (const child of input.children) {
        this.db.prepare('INSERT INTO telegram_origin_children VALUES (?,?,?,?,?,?,?,?)').run(child.childId, input.operationId, child.deliveryId, child.destinationJson, child.canonicalContentDigest, 0, 'queued', JSON.stringify(child.allowedDerivations ?? []));
        for (const m of child.materializations) this.insertMaterialization(child.childId, 0, m, null);
        if (legacy?.deliveryId === child.deliveryId) {
          this.db.prepare("UPDATE entries SET entry_kind='telegram-origin',origin_child_id=?,state='queued',claimed_by=NULL WHERE delivery_id=? AND entry_kind='legacy'").run(child.childId, child.deliveryId);
        } else this.db.prepare(`INSERT INTO entries(delivery_id,topic_id,text_hash,text,attempted_at,attempts,state,status_history,entry_kind,origin_child_id)
          VALUES (?,0,?,X'',?,0,'queued','[]',?,?)`).run(child.deliveryId, child.canonicalContentDigest, new Date(input.preparedAt).toISOString(), notice ? 'telegram-origin-notice' : 'telegram-origin', child.childId);
      }
      this.event(input.operationId, 'operation:admitted');
      return { operationId: input.operationId, originId: input.record.originId, inserted: true };
    }).immediate();
  }

  private insertMaterialization(childId: string, generation: number, input: StoredMaterializationInput, derivation: string | null): void {
    this.db.prepare('INSERT INTO telegram_origin_materializations VALUES (?,?,?,?,?,?,?)')
      .run(input.materializationId, childId, generation, input.requestJson, input.requestDigest, input.dispatchDeadline ?? null, derivation);
  }
  private operation(operationId: string): DbOperation | undefined {
    return this.db.prepare('SELECT * FROM telegram_origin_operations WHERE operation_id=?').get(operationId) as DbOperation | undefined;
  }
  private child(childId: string): DbChild | undefined {
    return this.db.prepare('SELECT * FROM telegram_origin_children WHERE child_id=?').get(childId) as DbChild | undefined;
  }
  private entry(deliveryId: string): DbEntry | undefined {
    return this.db.prepare('SELECT * FROM entries WHERE delivery_id=?').get(deliveryId) as DbEntry | undefined;
  }
  private materialization(row: DbMaterialization): StoredMaterializationInput {
    if (row.request_json === null) fail('payload-expired');
    seal(row.request_json!, row.request_digest);
    return { materializationId: row.materialization_id, requestJson: row.request_json!, requestDigest: row.request_digest, ...(row.dispatch_deadline === null ? {} : { dispatchDeadline: row.dispatch_deadline }) };
  }

  getChild(childId: string): StoredChild | null {
    const child = this.child(childId); if (!child) return null;
    const op = this.operation(child.operation_id)!;
    const entry = this.entry(child.delivery_id);
    const rows = this.db.prepare('SELECT * FROM telegram_origin_materializations WHERE child_id=? AND generation=? AND request_json IS NOT NULL ORDER BY materialization_id').all(childId, child.generation) as DbMaterialization[];
    return { childId, operationId: op.operation_id, originId: op.origin_id, deliveryId: child.delivery_id, destinationJson: child.destination_json, canonicalContentDigest: child.content_digest, generation: child.generation, state: child.state, attempts: entry?.attempts ?? 0, materializations: rows.map(row => this.materialization(row)) };
  }

  getOperation(operationId: string): OriginAuditRecord | null {
    id(operationId);
    const op = this.operation(operationId);
    if (op) return this.getOrigin(op.origin_id);
    // Tokenless sources retain an immutable envelope without an executable
    // operation. Evidence-only rows are never archived by the operation join.
    const rows = this.db.prepare(`SELECT origin_id FROM telegram_origins WHERE record_json IS NOT NULL
      AND json_extract(json_extract(record_json,'$.envelopeJson'),'$.operationId')=? LIMIT 2`).all(operationId) as Array<{ origin_id: string }>;
    if (rows.length > 1) fail('evidence-operation-conflict');
    return rows[0] ? this.getOrigin(rows[0].origin_id) : null;
  }

  /** Read only from the credential owner's outbox. Evidence mirrors never
   * contribute recovery candidates. Preserve insertion order for split sends.
   * A single uncertain or terminal failed child holds the whole remainder.
   */
  recoverableAdmissions(input: { limit?: number; now?: number } = {}): OriginAdmission[] {
    return this.readRecoverableAdmissions(input, false);
  }
  /** Persist progress even when the selected candidates cannot currently run.
   * Another boot resumes the scan rather than retrying the same blocked head.
   * This is scheduling state only: child claims still fence every dispatch. */
  takeRecoverableAdmissions(input: { limit?: number; now?: number } = {}): OriginAdmission[] {
    return this.readRecoverableAdmissions(input, true);
  }
  private readRecoverableAdmissions(input: { limit?: number; now?: number }, advance: boolean): OriginAdmission[] {
    const limit = input.limit ?? 10, now = input.now ?? Date.now();
    integer(limit, 1, 100);
    return this.db.transaction(() => {
      const after = advance ? (this.db.prepare('SELECT after_rowid FROM telegram_origin_recovery_cursor WHERE id=1').get() as { after_rowid: number } | undefined)?.after_rowid ?? 0 : 0;
      const operations = this.db.prepare(`SELECT o.*,o.rowid recovery_rowid FROM telegram_origin_operations o
        WHERE o.kind='ordinary' AND o.state IN ('admitted','held','partial') AND o.deadline_at>?
        AND EXISTS (SELECT 1 FROM telegram_origin_children c JOIN entries e ON e.delivery_id=c.delivery_id
          WHERE c.operation_id=o.operation_id AND c.state='queued' AND e.state='queued'
          AND e.attempts<o.max_attempts AND (e.next_attempt_at IS NULL OR e.next_attempt_at<=?))
        AND NOT EXISTS (SELECT 1 FROM telegram_origin_children c WHERE c.operation_id=o.operation_id
          AND c.state NOT IN ('queued','accepted'))
        ORDER BY CASE WHEN o.rowid>? THEN 0 ELSE 1 END,o.rowid LIMIT ?`).all(now, new Date(now).toISOString(), after, limit) as Array<DbOperation & { recovery_rowid: number }>;
      const admissions = operations.map(op => {
        const audit = this.getOrigin(op.origin_id);
        if (!audit) return fail('recovery-origin-missing');
        const children = this.db.prepare('SELECT * FROM telegram_origin_children WHERE operation_id=? ORDER BY rowid').all(op.operation_id) as DbChild[];
        return { record: audit.record, operationId: op.operation_id, preparedAt: op.prepared_at,
          deadlineAt: op.deadline_at, maxAttempts: op.max_attempts, payloadBytes: op.payload_bytes,
          children: children.map(child => {
            const rows = this.db.prepare('SELECT * FROM telegram_origin_materializations WHERE child_id=? AND generation=0 ORDER BY rowid').all(child.child_id) as DbMaterialization[];
            if (!rows.length || rows.some(row => row.request_json === null)) return fail('recovery-payload-missing');
            return { childId: child.child_id, deliveryId: child.delivery_id, destinationJson: child.destination_json,
              canonicalContentDigest: child.content_digest, materializations: rows.map(row => this.materialization(row)),
              allowedDerivations: JSON.parse(child.allowed_derivations) };
          }) };
      });
      if (advance && operations.length) this.db.prepare('INSERT INTO telegram_origin_recovery_cursor VALUES (1,?) ON CONFLICT(id) DO UPDATE SET after_rowid=excluded.after_rowid').run(operations.at(-1)!.recovery_rowid);
      return admissions;
    }).immediate();
  }

  claim(input: ClaimInput): ClaimResult {
    integer(input.leaseMs, 1, MAX_LEASE_MS); id(input.ownerBootId);
    const now = input.now ?? Date.now(); integer(now, 0, Number.MAX_SAFE_INTEGER);
    return this.db.transaction((): ClaimResult => {
      const child = this.child(input.childId); if (!child) return { status: 'unavailable', reason: 'missing' };
      const op = this.operation(child.operation_id)!; const entry = this.entry(child.delivery_id)!;
      if (op.kind !== 'ordinary' || !['admitted', 'partial'].includes(op.state) || child.state !== 'queued' || entry.state !== 'queued' || (entry.next_attempt_at !== null && Date.parse(entry.next_attempt_at) > now)) return { status: 'unavailable', reason: 'not-ready' };
      if (op.deadline_at <= now) { this.expireOperation(op.operation_id, now); return { status: 'unavailable', reason: 'expired' }; }
      if (entry.attempts >= op.max_attempts) return { status: 'unavailable', reason: 'attempt-budget' };
      const materialization = this.db.prepare('SELECT * FROM telegram_origin_materializations WHERE materialization_id=? AND child_id=?').get(input.materializationId, input.childId) as DbMaterialization | undefined;
      if (!materialization || materialization.generation !== child.generation) return { status: 'unavailable', reason: 'stale-materialization' };
      if (materialization.dispatch_deadline !== null && materialization.dispatch_deadline <= now) return { status: 'unavailable', reason: 'signature-expired' };
      const sealed = this.materialization(materialization);
      const claimToken = randomUUID(); const attemptId = randomUUID();
      if (!this.queue.claimCas(child.delivery_id, claimToken, { state: 'queued', claimed_by: null }, 'telegram-origin')) return { status: 'unavailable', reason: 'not-ready' };
      this.db.prepare('UPDATE entries SET owner_boot_id=?,lease_until=?,attempts=attempts+1 WHERE delivery_id=? AND claimed_by=?').run(input.ownerBootId, Math.min(now + input.leaseMs, op.deadline_at), child.delivery_id, claimToken);
      this.db.prepare("UPDATE telegram_origin_children SET state='claimed' WHERE child_id=?").run(child.child_id);
      this.db.prepare("INSERT INTO telegram_origin_attempts VALUES (?,?,?,?,?,'claimed',NULL,NULL,?,NULL)").run(attemptId, child.child_id, materialization.materialization_id, claimToken, input.ownerBootId, now);
      this.event(attemptId, 'attempt:claimed');
      return { status: 'claimed', child: { childId: child.child_id, claimToken, operationId: op.operation_id, originId: op.origin_id, deliveryId: child.delivery_id, ownerBootId: input.ownerBootId, materialization: sealed, destinationJson: child.destination_json, attemptId, attemptNumber: entry.attempts + 1, deadlineAt: Math.min(op.deadline_at, materialization.dispatch_deadline ?? op.deadline_at) } };
    }).immediate();
  }

  /** Only the still-claimed phase may return its unused attempt budget. The
   * caller invalidates its private wire closure first; dispatched crash state
   * can never use this path. Retain the canceled attempt as audit evidence. */
  releaseUndispatchedClaim(input: ClaimFence & { now?: number }): boolean {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const child = this.child(input.childId); if (!child) return false;
      const entry = this.entry(child.delivery_id)!;
      const attempt = this.db.prepare('SELECT * FROM telegram_origin_attempts WHERE child_id=? AND claim_token=?').get(input.childId, input.claimToken) as DbAttempt | undefined;
      if (!attempt || attempt.phase !== 'claimed' || attempt.outcome !== null || entry.entry_kind !== 'telegram-origin' ||
        entry.state !== 'claimed' || entry.claimed_by !== input.claimToken || entry.owner_boot_id !== attempt.owner_boot_id || (entry.lease_until ?? 0) <= now) return false;
      this.db.prepare("UPDATE telegram_origin_attempts SET outcome='known-failed',resolved_at=? WHERE attempt_id=? AND outcome IS NULL").run(now, attempt.attempt_id);
      this.db.prepare('INSERT INTO telegram_origin_outcome_details VALUES (?,?,?)').run(attempt.attempt_id, 'capacity-held-before-dispatch', now);
      this.db.prepare("UPDATE telegram_origin_children SET state='queued' WHERE child_id=?").run(child.child_id);
      this.db.prepare("UPDATE entries SET state='queued',claimed_by=NULL,owner_boot_id=NULL,lease_until=NULL,attempts=MAX(0,attempts-1),next_attempt_at=NULL WHERE delivery_id=? AND claimed_by=?").run(child.delivery_id, input.claimToken);
      this.event(attempt.attempt_id, 'attempt:capacity-held-before-dispatch');
      this.refreshOperation(child.operation_id); return true;
    }).immediate();
  }

  markDispatched(input: ClaimFence & { now?: number }): boolean {
    const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const child = this.child(input.childId); if (!child) return false;
      const op = this.operation(child.operation_id)!; const entry = this.entry(child.delivery_id)!;
      if (entry.entry_kind !== 'telegram-origin' || entry.claimed_by !== input.claimToken || entry.state !== 'claimed' || (entry.lease_until ?? 0) <= now || op.deadline_at <= now) return false;
      const attempt = this.db.prepare('SELECT * FROM telegram_origin_attempts WHERE child_id=? AND claim_token=?').get(input.childId, input.claimToken) as DbAttempt;
      if (!attempt || attempt.outcome !== null || attempt.phase !== 'claimed') return false;
      const m = this.db.prepare('SELECT * FROM telegram_origin_materializations WHERE materialization_id=?').get(attempt.materialization_id) as DbMaterialization;
      if (m.dispatch_deadline !== null && m.dispatch_deadline <= now) return false;
      this.db.prepare("UPDATE telegram_origin_attempts SET phase='dispatched' WHERE attempt_id=?").run(attempt.attempt_id);
      this.event(attempt.attempt_id, 'attempt:dispatched');
      return true;
    }).immediate();
  }

  renewClaim(input: ClaimFence & { leaseMs: number; now?: number }): boolean {
    integer(input.leaseMs, 1, MAX_LEASE_MS); const now = input.now ?? Date.now();
    return this.db.transaction(() => {
      const child = this.child(input.childId); if (!child) return false;
      const op = this.operation(child.operation_id)!; const entry = this.entry(child.delivery_id)!;
      if (op.deadline_at <= now || (entry.lease_until ?? 0) <= now) return false;
      if (!this.queue.renewClaim(child.delivery_id, input.claimToken, input.claimToken, 'telegram-origin')) return false;
      this.db.prepare('UPDATE entries SET lease_until=? WHERE delivery_id=? AND claimed_by=?').run(Math.min(now + input.leaseMs, op.deadline_at), child.delivery_id, input.claimToken);
      return true;
    }).immediate();
  }

  recordOutcome(input: OutcomeInput): OutcomeWriteResult {
    if (!['accepted', 'known-failed', 'scheduled', 'outcome-unknown', 'suppressed'].includes(input.outcome)) fail('invalid-outcome');
    if (input.receiptJson !== undefined) json(input.receiptJson, 64 * 1024);
    if ((input.outcome === 'accepted' || input.outcome === 'scheduled') && !input.receiptJson) return { recorded: false, reason: 'receipt-required' };
    if (input.nextAttemptAt !== undefined && input.outcome !== 'known-failed') return { recorded: false, reason: 'invalid-transition' };
    const now = input.now ?? Date.now();
    return this.db.transaction((): OutcomeWriteResult => {
      const child = this.child(input.childId); if (!child) return { recorded: false, reason: 'stale-fence' };
      const op = this.operation(child.operation_id)!; const entry = this.entry(child.delivery_id)!;
      const attempt = this.db.prepare('SELECT * FROM telegram_origin_attempts WHERE child_id=? AND claim_token=?').get(input.childId, input.claimToken) as DbAttempt | undefined;
      if (!attempt || entry.entry_kind !== 'telegram-origin' || entry.claimed_by !== input.claimToken || entry.state !== 'claimed' || (entry.lease_until ?? 0) <= now) return { recorded: false, reason: 'stale-fence' };
      if (['accepted', 'scheduled'].includes(input.outcome) && attempt.phase !== 'dispatched') return { recorded: false, reason: 'not-dispatched' };
      if (attempt.outcome !== null) return { recorded: false, reason: 'invalid-transition' };
      const retry = input.outcome === 'known-failed' && input.nextAttemptAt !== undefined && input.nextAttemptAt >= now && input.nextAttemptAt < op.deadline_at && entry.attempts < op.max_attempts;
      const state = retry ? 'queued' : input.outcome;
      this.db.prepare('UPDATE telegram_origin_attempts SET outcome=?,receipt_json=?,resolved_at=? WHERE attempt_id=? AND outcome IS NULL').run(input.outcome, input.receiptJson ?? null, now, attempt.attempt_id);
      this.db.prepare('INSERT INTO telegram_origin_outcome_details VALUES (?,?,?)').run(attempt.attempt_id, input.reason ?? null, retry ? input.nextAttemptAt : null);
      if (input.receiptJson && (['accepted', 'scheduled'].includes(input.outcome) ||
        (input.outcome === 'outcome-unknown' && input.reason === 'partial-platform-receipt' && JSON.parse(input.receiptJson).partial === true))) this.indexReceipt(child, input.receiptJson);
      this.db.prepare('UPDATE telegram_origin_children SET state=? WHERE child_id=?').run(state, child.child_id);
      this.db.prepare('UPDATE entries SET state=?,claimed_by=NULL,owner_boot_id=NULL,lease_until=NULL,next_attempt_at=? WHERE delivery_id=? AND claimed_by=?')
        .run(retry ? 'queued' : input.outcome === 'outcome-unknown' ? 'delivered-ambiguous' : 'delivered-recovered', retry ? new Date(input.nextAttemptAt!).toISOString() : null, child.delivery_id, input.claimToken);
      this.event(attempt.attempt_id, `attempt:${input.outcome}`);
      if (!retry) this.event(`${child.child_id}:${input.outcome}`, `child:${input.outcome}`);
      this.refreshOperation(op.operation_id);
      return { recorded: true };
    }).immediate();
  }

  private refreshOperation(operationId: string): void {
    const children = this.db.prepare('SELECT state FROM telegram_origin_children WHERE operation_id=?').all(operationId) as { state: string }[];
    const states = children.map(child => child.state);
    let state = 'admitted';
    if (states.every(s => s === 'accepted')) state = 'accepted';
    else if (states.every(s => s === 'suppressed')) state = 'suppressed';
    else if (states.some(s => s === 'accepted')) state = 'partial';
    else if (states.some(s => s === 'outcome-unknown')) state = 'outcome-unknown';
    else if (states.every(s => s === 'known-failed')) state = 'known-failed';
    else if (states.every(s => s === 'scheduled')) state = 'scheduled';
    this.db.prepare('UPDATE telegram_origin_operations SET state=? WHERE operation_id=?').run(state, operationId);
    this.event(`${operationId}:${state}`, `operation:${state === 'partial' ? 'partially-delivered' : state}`);
  }

  reapAbandoned(now = Date.now()): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT origin_child_id childId,claimed_by token FROM entries WHERE entry_kind='telegram-origin' AND state='claimed' AND lease_until<=? LIMIT 1000").all(now) as Array<{ childId: string; token: string }>;
      for (const row of rows) {
        const child = this.child(row.childId)!;
        this.db.prepare("UPDATE entries SET state='delivered-ambiguous',claimed_by=NULL,lease_until=NULL WHERE origin_child_id=? AND claimed_by=?").run(row.childId, row.token);
        this.db.prepare("UPDATE telegram_origin_children SET state='outcome-unknown' WHERE child_id=?").run(row.childId);
        this.db.prepare("UPDATE telegram_origin_attempts SET outcome='outcome-unknown',resolved_at=? WHERE claim_token=? AND outcome IS NULL").run(now, row.token);
        this.event(`${row.childId}:outcome-unknown`, 'child:outcome-unknown');
        this.refreshOperation(child.operation_id);
      }
      return rows.length;
    }).immediate();
  }

  addMaterialization(input: DerivedMaterializationInput): boolean {
    this.validateMaterialization(input.materialization);
    return this.db.transaction(() => {
      const child = this.child(input.childId); if (!child) return false;
      const op = this.operation(child.operation_id)!;
      if (child.generation !== input.expectedGeneration || child.state !== 'queued' || op.deadline_at <= Date.now()) return false;
      if (!JSON.parse(child.allowed_derivations).includes(input.kind) || child.destination_json !== input.destinationJson || child.content_digest !== input.canonicalContentDigest) fail('unauthorized-derivation');
      const count = this.db.prepare('SELECT count(*) n FROM telegram_origin_materializations WHERE child_id=?').get(child.child_id) as { n: number };
      if (count.n >= 80 || Buffer.byteLength(input.materialization.requestJson) > op.payload_bytes) fail('materialization-budget');
      this.insertMaterialization(child.child_id, child.generation + 1, input.materialization, JSON.stringify({ kind: input.kind, inputDigest: input.inputDigest, parentGeneration: child.generation }));
      this.db.prepare('UPDATE telegram_origin_children SET generation=generation+1 WHERE child_id=? AND generation=?').run(child.child_id, child.generation);
      return true;
    }).immediate();
  }

  recordOperationState(input: { operationId: string; state: 'held' | 'suppressed' | 'expired' | 'admitted'; now?: number }): boolean {
    return this.db.transaction(() => {
      const op = this.operation(input.operationId); if (!op) return false;
      if (input.state === 'expired') return this.expireOperation(input.operationId, input.now ?? Date.now());
      if (['accepted', 'expired', 'outcome-unknown', 'partial'].includes(op.state)) return false;
      if (input.state === 'admitted' && op.state !== 'held') return false;
      const active = this.db.prepare("SELECT 1 FROM entries e JOIN telegram_origin_children c ON c.delivery_id=e.delivery_id WHERE c.operation_id=? AND e.state='claimed'").get(input.operationId);
      if (active) return false;
      this.db.prepare('UPDATE telegram_origin_operations SET state=? WHERE operation_id=?').run(input.state, input.operationId);
      if (input.state === 'suppressed') {
        this.db.prepare("UPDATE telegram_origin_children SET state='suppressed' WHERE operation_id=? AND state='queued'").run(input.operationId);
        this.db.prepare("UPDATE entries SET state='delivered-tone-gated' WHERE origin_child_id IN (SELECT child_id FROM telegram_origin_children WHERE operation_id=?) AND state='queued'").run(input.operationId);
      }
      this.event(`${input.operationId}:${input.state}`, `operation:${input.state}`);
      return true;
    }).immediate();
  }

  private expireOperation(operationId: string, now: number): boolean {
    const op = this.operation(operationId); if (!op || op.deadline_at > now || ['accepted', 'suppressed', 'expired'].includes(op.state)) return false;
    this.db.prepare("UPDATE telegram_origin_operations SET state='expired' WHERE operation_id=?").run(operationId);
    this.db.prepare("UPDATE telegram_origin_children SET state='expired-unresolved' WHERE operation_id=? AND state NOT IN ('accepted','suppressed','known-failed')").run(operationId);
    this.db.prepare("UPDATE entries SET state='dead-letter',claimed_by=NULL,lease_until=NULL WHERE origin_child_id IN (SELECT child_id FROM telegram_origin_children WHERE operation_id=?) AND state IN ('queued','claimed')").run(operationId);
    this.event(`${operationId}:expired`, 'operation:expired');
    return true;
  }

  reserveNotice(input: NoticeReservationInput): NoticeReservation {
    id(input.ownerBootId); id(input.generation); id(input.alertDestinationId);
    const bytes = this.validateAdmission(input.admission, true);
    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM telegram_origin_notices WHERE alert_destination_id=? AND generation=?').get(input.alertDestinationId, input.generation) as { child_id: string; owner_boot_id: string; claim_token: string; state: string } | undefined;
      if (existing) fail('notice-generation-already-reserved'); // no permit reissuance, even to the same boot
      const active = this.db.prepare("SELECT count(*) n,coalesce(sum(request_bytes),0) bytes FROM telegram_origin_notices WHERE state='reserved'").get() as { n: number; bytes: number };
      if (active.n >= this.options.maxNoticeReservations || active.bytes + bytes > this.options.maxNoticeBytes) fail('notice-capacity-unavailable');
      this.admitInternal(input.admission, true);
      const child = input.admission.children[0]; const claimToken = randomUUID();
      this.db.prepare("INSERT INTO telegram_origin_notices VALUES (?,?,?,?,?,?,'reserved')").run(child.childId, input.alertDestinationId, input.generation, input.ownerBootId, claimToken, bytes);
      this.db.prepare("UPDATE entries SET state='claimed',claimed_by=?,owner_boot_id=? WHERE delivery_id=? AND entry_kind='telegram-origin-notice' AND state='queued'").run(claimToken, input.ownerBootId, child.deliveryId);
      this.db.prepare("UPDATE telegram_origin_children SET state='notice-reserved' WHERE child_id=?").run(child.childId);
      this.event(child.childId, 'notification:reserved');
      return { childId: child.childId, claimToken, ownerBootId: input.ownerBootId, generation: input.generation, alertDestinationId: input.alertDestinationId, materializations: child.materializations };
    }).immediate();
  }

  /** Flushes the notifier's one consumed in-memory result after storage recovery.
   * This does not consume or grant a callable send capability.
   */
  recordNoticeOutcome(input: ClaimFence & { ownerBootId: string; materializationId: string; outcome: ChildOutcome | 'unavailable'; receiptJson?: string; now?: number }): OutcomeWriteResult {
    if (input.receiptJson !== undefined) json(input.receiptJson, 64 * 1024);
    if (input.outcome === 'accepted' && !input.receiptJson) return { recorded: false, reason: 'receipt-required' };
    return this.db.transaction((): OutcomeWriteResult => {
      const notice = this.db.prepare("SELECT * FROM telegram_origin_notices WHERE child_id=? AND claim_token=? AND owner_boot_id=? AND state='reserved'").get(input.childId, input.claimToken, input.ownerBootId);
      if (!notice) return { recorded: false, reason: 'stale-fence' };
      const materialization = this.db.prepare('SELECT 1 FROM telegram_origin_materializations WHERE materialization_id=? AND child_id=?').get(input.materializationId, input.childId);
      if (!materialization) return { recorded: false, reason: 'invalid-transition' };
      const now = input.now ?? Date.now(); const child = this.child(input.childId)!;
      if (input.receiptJson && input.outcome === 'accepted') this.indexReceipt(child, input.receiptJson);
      this.db.prepare('UPDATE telegram_origin_notices SET state=? WHERE child_id=?').run(input.outcome, input.childId);
      this.db.prepare('UPDATE telegram_origin_children SET state=? WHERE child_id=?').run(input.outcome, input.childId);
      this.db.prepare("UPDATE entries SET state='delivered-ambiguous',claimed_by=NULL WHERE origin_child_id=? AND claimed_by=?").run(input.childId, input.claimToken);
      this.db.prepare('INSERT INTO telegram_origin_attempts VALUES (?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), input.childId, input.materializationId, input.claimToken, input.ownerBootId, input.outcome === 'unavailable' || input.outcome === 'suppressed' ? 'not-attempted' : 'dispatched', input.outcome, input.receiptJson ?? null, now, now);
      if (input.outcome !== 'unavailable' && input.outcome !== 'suppressed') this.event(input.childId, 'notification:attempted');
      this.event(input.childId, `notification:${input.outcome}`);
      this.refreshOperation(child.operation_id);
      return { recorded: true };
    }).immediate();
  }

  /** Only lifecycle code with evidence that this boot is dead may retire its
   * reservations. Retirement destroys availability; it never transfers permits.
   */
  retireNoticeOwner(ownerBootId: string): number {
    return this.db.transaction(() => {
      const rows = this.db.prepare("SELECT child_id FROM telegram_origin_notices WHERE owner_boot_id=? AND state='reserved'").all(ownerBootId) as { child_id: string }[];
      for (const row of rows) {
        this.db.prepare("UPDATE telegram_origin_notices SET state='unavailable' WHERE child_id=?").run(row.child_id);
        this.db.prepare("UPDATE entries SET state='dead-letter',claimed_by=NULL WHERE origin_child_id=? AND entry_kind='telegram-origin-notice'").run(row.child_id);
        this.db.prepare("UPDATE telegram_origin_children SET state='unavailable' WHERE child_id=?").run(row.child_id);
        this.event(row.child_id, 'notification:unavailable');
      }
      return rows.length;
    }).immediate();
  }

  /** Receipt validators may resolve existing uncertain evidence; this method
   * never makes a child claimable and never accepts changed receipt evidence.
   */
  reconcileReceipt(input: { childId: string; attemptId: string; receiptJson: string; outcome: 'accepted' | 'scheduled'; now?: number }): boolean {
    json(input.receiptJson, 64 * 1024);
    if (!['accepted', 'scheduled'].includes(input.outcome)) fail('invalid-outcome');
    return this.db.transaction(() => {
      const attempt = this.db.prepare('SELECT * FROM telegram_origin_attempts WHERE attempt_id=? AND child_id=?').get(input.attemptId, input.childId) as DbAttempt | undefined;
      if (!attempt) return false;
      if (attempt.outcome === input.outcome && attempt.receipt_json === input.receiptJson) return true;
      if (attempt.outcome !== 'outcome-unknown') return false;
      const child = this.child(input.childId)!;
      this.db.prepare('UPDATE telegram_origin_attempts SET outcome=?,receipt_json=?,resolved_at=? WHERE attempt_id=?').run(input.outcome, input.receiptJson, input.now ?? Date.now(), input.attemptId);
      this.indexReceipt(child, input.receiptJson);
      this.db.prepare('UPDATE telegram_origin_children SET state=? WHERE child_id=?').run(input.outcome, input.childId);
      this.db.prepare("UPDATE entries SET state='delivered-recovered',claimed_by=NULL,lease_until=NULL WHERE origin_child_id=?").run(input.childId);
      this.event(`${input.childId}:${input.outcome}`, `child:${input.outcome}`);
      this.refreshOperation(child.operation_id);
      return true;
    }).immediate();
  }

  getOrigin(originId: string): OriginAuditRecord | null {
    return this.withArchiveReads(() => this.getOriginInReadScope(originId));
  }
  private getOriginInReadScope(originId: string): OriginAuditRecord | null {
    const row = this.db.prepare('SELECT * FROM telegram_origins WHERE origin_id=?').get(originId) as DbOrigin | undefined;
    if (!row) return null;
    const diagnostic = this.db.prepare('SELECT state,reason,created_at createdAt,resolved_at resolvedAt,diagnosis FROM telegram_origin_diagnostics WHERE origin_id=?').get(originId) as OriginAuditRecord['diagnostic'];
    const storedRecord: StoredOriginInput = row.record_json === null && row.archive_id ? this.readArchive(row.archive_id, originId).record : JSON.parse(row.record_json!);
    const op = this.db.prepare('SELECT * FROM telegram_origin_operations WHERE origin_id=?').get(originId) as DbOperation | undefined;
    const children = op ? this.db.prepare('SELECT * FROM telegram_origin_children WHERE operation_id=? ORDER BY rowid').all(op.operation_id) as DbChild[] : [];
    const attempts = op ? this.db.prepare('SELECT a.* FROM telegram_origin_attempts a JOIN telegram_origin_children c ON c.child_id=a.child_id WHERE c.operation_id=? ORDER BY a.created_at,a.attempt_id').all(op.operation_id) as DbAttempt[] : [];
    const verification = this.db.prepare('SELECT evidence_json FROM telegram_origin_verifications WHERE origin_id=?').get(originId) as { evidence_json: string } | undefined;
    return { sequence: row.sequence, record: storedRecord, ...(verification ? { acceptanceVerification: JSON.parse(verification.evidence_json) } : {}), ...(diagnostic ? { diagnostic: {
      ...diagnostic, state: diagnostic.state === 'pending' && diagnostic.createdAt + 30_000 < Date.now() ? 'unavailable' : diagnostic.state,
    } } : {}), operation: op ? { operationId: op.operation_id, preparedAt: op.prepared_at, deadlineAt: op.deadline_at, maxAttempts: op.max_attempts, state: op.state } : null,
      children: children.map(child => ({ childId: child.child_id, deliveryId: child.delivery_id, destinationJson: child.destination_json, generation: child.generation, state: child.state, attempts: this.entry(child.delivery_id)?.attempts ?? 0 })),
      attempts: attempts.map(a => ({ attemptId: a.attempt_id, childId: a.child_id, materializationId: a.materialization_id, ownerBootId: a.owner_boot_id,
        ...(this.db.prepare('SELECT reason,next_attempt_at nextAttemptAt FROM telegram_origin_outcome_details WHERE attempt_id=?').get(a.attempt_id) ?? {}),
        deliveryMachineId: (this.db.prepare('SELECT machine_id FROM telegram_origin_owners WHERE owner_boot_id=?').get(a.owner_boot_id) as { machine_id: string } | undefined)?.machine_id ?? null,
        phase: a.phase, outcome: a.outcome, receiptJson: a.receipt_json, createdAt: a.created_at, resolvedAt: a.resolved_at })) };
  }

  listOrigins(query: OriginListQuery = {}): OriginListPage {
    return this.withArchiveReads(() => this.listOriginsInReadScope(query));
  }
  private listOriginsInReadScope(query: OriginListQuery): OriginListPage {
    const limit = query.limit ?? 50; integer(limit, 1, 200);
    const filter = { machineId: query.machineId ?? null, originId: query.originId ?? null,
      transport: query.transport ?? null, accountId: query.accountId ?? null, chatId: query.chatId ?? null,
      topicId: query.topicId ?? null, messageId: query.messageId ?? null };
    for (const value of Object.values(filter)) if (value !== null) id(value);
    let upperSequence = (this.db.prepare('SELECT coalesce(max(sequence),0) n FROM telegram_origins').get() as { n: number }).n;
    let after: [number, string, string] | null = null;
    if (query.cursor) {
      if (query.cursor.length > 8192) fail('invalid-cursor');
      const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')) as { v: number; upper: number; after: [number, string, string]; filter: typeof filter };
      if (cursor.v !== 1 || JSON.stringify(cursor.filter) !== JSON.stringify(filter) || !Array.isArray(cursor.after) || cursor.after.length !== 3) fail('invalid-cursor');
      integer(cursor.upper, 0, Number.MAX_SAFE_INTEGER); integer(cursor.after[0], 0, Number.MAX_SAFE_INTEGER); id(cursor.after[1]); id(cursor.after[2]);
      upperSequence = cursor.upper; after = cursor.after;
    }
    const rows = this.db.prepare(`SELECT origin_id,created_at,machine_id FROM telegram_origins WHERE sequence<=@upper
      AND (@machine IS NULL OR machine_id=@machine) AND (@origin IS NULL OR origin_id=@origin)
      AND ((@transport IS NULL AND @account IS NULL AND @chat IS NULL AND @topic IS NULL AND @message IS NULL)
        OR origin_id IN (SELECT origin_id FROM telegram_origin_platform_receipts WHERE
          (@transport IS NULL OR transport=@transport) AND (@account IS NULL OR account_id=@account)
          AND (@chat IS NULL OR chat_id=@chat) AND (@topic IS NULL OR topic_id=@topic) AND (@message IS NULL OR message_id=@message))
        OR (@message IS NULL AND origin_id IN (SELECT origin_id FROM telegram_origin_destinations WHERE
          (@transport IS NULL OR transport=@transport) AND (@account IS NULL OR account_id=@account)
          AND (@chat IS NULL OR chat_id=@chat) AND (@topic IS NULL OR topic_id=@topic))))
      AND (@afterTime IS NULL OR (created_at,machine_id,origin_id)>(@afterTime,@afterMachine,@afterOrigin))
      ORDER BY created_at,machine_id,origin_id LIMIT @limit`).all({ upper: upperSequence, machine: filter.machineId, origin: filter.originId,
        transport: filter.transport, account: filter.accountId, chat: filter.chatId, topic: filter.topicId, message: filter.messageId,
        afterTime: after?.[0] ?? null, afterMachine: after?.[1] ?? null, afterOrigin: after?.[2] ?? null, limit: limit + 1 }) as Array<{ origin_id: string; created_at: number; machine_id: string }>;
    const records: OriginAuditRecord[] = []; let recordBytes = 0;
    for (const row of rows.slice(0, limit)) {
      let record: OriginAuditRecord;
      try { record = this.getOrigin(row.origin_id)!; }
      catch (error) {
        if (records.length && error instanceof Error && error.message === 'origin-store:archive-read-budget') break;
        throw error;
      }
      const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
      // Keep room for the filter-bound cursor and response metadata.
      if (recordBytes + bytes > MAX_AUDIT_PAGE_BYTES - 16 * 1024) {
        if (!records.length) fail('audit-record-too-large');
        break;
      }
      records.push(record); recordBytes += bytes;
    }
    const more = rows.length > records.length, last = rows[records.length - 1];
    return { records, upperSequence, coverage: 'complete', cursor: more && last ? Buffer.from(JSON.stringify({ v: 1, upper: upperSequence, after: [last.created_at, last.machine_id, last.origin_id], filter })).toString('base64url') : null };
  }

  getMetrics(): OriginMetrics {
    const counts: Record<string, number> = {};
    for (const row of this.db.prepare('SELECT metric,count FROM telegram_origin_metrics ORDER BY metric').all() as Array<{ metric: string; count: number }>) counts[row.metric] = row.count;
    return { sampledAt: Date.now(), coverage: 'complete', stale: false, counts };
  }
  getFederatedMetrics(machineId: string): OriginMetrics {
    id(machineId);
    // Prepared/evidence events belong to the source shard; execution events
    // belong to the one outbox. Inert evidence copies cannot inflate a pool.
    const rows = this.db.prepare(`SELECT e.metric,count(*) count FROM telegram_origin_metric_events e
      LEFT JOIN telegram_origins o ON o.origin_id=e.event_id
      WHERE (e.metric!='operation:prepared' AND e.metric NOT LIKE 'evidence:%')
        OR o.machine_id=? OR (o.machine_id='legacy-unattributed' AND EXISTS
          (SELECT 1 FROM telegram_origin_operations p WHERE p.origin_id=o.origin_id))
      GROUP BY e.metric`).all(machineId) as Array<{ metric: string; count: number }>;
    return { sampledAt: Date.now(), coverage: 'complete', stale: false,
      counts: Object.fromEntries(rows.map(row => [row.metric, row.count])) };
  }

  /** Archive at most 200 terminal origins/16 MiB per call; all index rows remain.
   * Artifact is fsynced BEFORE the transactional manifest redirects any lookup.
   */
  archive(input: { before: number; limit?: number }): ArchiveResult {
    const limit = input.limit ?? 100; integer(limit, 1, 200);
    const rows = this.db.prepare(`SELECT o.origin_id,o.sequence FROM telegram_origins o JOIN telegram_origin_operations p ON p.origin_id=o.origin_id
      WHERE o.archive_id IS NULL AND o.created_at<? AND p.state IN ('accepted','suppressed','expired','known-failed') ORDER BY o.sequence LIMIT ?`).all(input.before, limit) as Array<{ origin_id: string; sequence: number }>;
    if (!rows.length) return { archived: 0, archiveId: null, digest: null };
    const records: OriginAuditRecord[] = []; let bytes = 0;
    for (const row of rows) { const record = this.getOrigin(row.origin_id)!; const size = Buffer.byteLength(JSON.stringify(record)); if (bytes + size > 16 * 1024 * 1024) break; records.push(record); bytes += size; }
    if (!records.length) fail('archive-record-too-large');
    fs.mkdirSync(this.archiveDir, { recursive: true, mode: 0o700 });
    const archiveId = randomUUID(); const filename = `${archiveId}.sqlite`; const filenameAbsolute = path.join(this.archiveDir, filename);
    const archive = new Database(filenameAbsolute);
    try {
      fs.chmodSync(filenameAbsolute, 0o600); archive.pragma('synchronous = FULL');
      archive.exec('CREATE TABLE records(origin_id TEXT PRIMARY KEY,record_json TEXT NOT NULL)');
      archive.transaction(() => { const insert = archive.prepare('INSERT INTO records VALUES (?,?)'); for (const record of records) insert.run(record.record.originId, JSON.stringify(record)); })();
    } finally { archive.close(); }
    const fd = fs.openSync(filenameAbsolute, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const dir = fs.openSync(this.archiveDir, 'r'); try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    const hash = digest(fs.readFileSync(filenameAbsolute));
    this.db.transaction(() => {
      for (const record of records) {
        const current = this.db.prepare('SELECT archive_id FROM telegram_origins WHERE origin_id=?').get(record.record.originId) as { archive_id: string | null };
        if (current.archive_id !== null) fail('archive-race');
      }
      this.db.prepare('INSERT INTO telegram_origin_archives VALUES (?,?,?,?,?,?,?)').run(archiveId, filename, hash, records.length, records[0].sequence, records.at(-1)!.sequence, Date.now());
      for (const record of records) this.db.prepare('UPDATE telegram_origins SET record_json=NULL,archive_id=? WHERE origin_id=?').run(archiveId, record.record.originId);
    }).immediate();
    return { archived: records.length, archiveId, digest: hash };
  }

  private withArchiveReads<T>(read: () => T): T {
    if (this.archiveReadScope) return read();
    const scope = { handles: new Map<string, Database.Database>(), bytes: 0 };
    this.archiveReadScope = scope;
    try { return read(); }
    finally {
      this.archiveReadScope = undefined;
      for (const handle of scope.handles.values()) handle.close();
    }
  }
  private readArchive(archiveId: string, originId: string): OriginAuditRecord {
    const scope = this.archiveReadScope;
    if (!scope) return this.withArchiveReads(() => this.readArchive(archiveId, originId));
    const cached = scope.handles.get(archiveId);
    if (cached) {
      const row = cached.prepare('SELECT record_json FROM records WHERE origin_id=?').get(originId) as { record_json: string } | undefined;
      if (!row) return fail('archive-incomplete');
      return JSON.parse(row.record_json);
    }
    const manifest = this.db.prepare('SELECT filename,digest FROM telegram_origin_archives WHERE archive_id=?').get(archiveId) as { filename: string; digest: string } | undefined;
    if (!manifest || path.basename(manifest.filename) !== manifest.filename) return fail('archive-unavailable');
    const filename = path.join(this.archiveDir, manifest.filename);
    const fd = fs.openSync(filename, 'r');
    let bytes: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_ARCHIVE_BYTES) return fail('archive-file-bound');
      if (scope.bytes + stat.size > MAX_ARCHIVE_READ_BYTES) return fail('archive-read-budget');
      bytes = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < bytes.length) {
        const read = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
        if (!read) return fail('archive-integrity');
        offset += read;
      }
      if (fs.fstatSync(fd).size !== stat.size) return fail('archive-integrity');
      scope.bytes += bytes.length;
      this.archiveReadStats.filesVerified++; this.archiveReadStats.bytesHashed += bytes.length;
    } finally { fs.closeSync(fd); }
    if (digest(bytes) !== manifest.digest) return fail('archive-integrity');
    const archive = new Database(filename, { readonly: true, fileMustExist: true });
    if (scope.handles.size >= 16) {
      const oldest = scope.handles.entries().next().value!;
      oldest[1].close(); scope.handles.delete(oldest[0]);
    }
    scope.handles.set(archiveId, archive);
    const record = archive.prepare('SELECT record_json FROM records WHERE origin_id=?').get(originId) as { record_json: string } | undefined;
    if (!record) return fail('archive-incomplete');
    return JSON.parse(record.record_json);
  }

  cleanupPayloads(now = Date.now()): number {
    return this.db.transaction(() => {
      const expired = this.db.prepare("SELECT operation_id FROM telegram_origin_operations WHERE deadline_at<=? AND state NOT IN ('accepted','suppressed','expired','known-failed') LIMIT 1000").all(now) as { operation_id: string }[];
      for (const op of expired) this.expireOperation(op.operation_id, now);
      this.db.prepare(`UPDATE entries SET text=X'' WHERE delivery_id IN
        (SELECT e.delivery_id FROM entries e JOIN telegram_origin_children c ON c.delivery_id=e.delivery_id
          JOIN telegram_origin_operations p ON p.operation_id=c.operation_id WHERE length(e.text)>0
          AND e.entry_kind='telegram-origin' AND p.state IN ('accepted','suppressed','expired','known-failed') LIMIT 1000)`).run();
      this.db.prepare(`UPDATE telegram_origin_payloads SET data=NULL WHERE rowid IN
        (SELECT b.rowid FROM telegram_origin_payloads b JOIN telegram_origin_operations p ON p.operation_id=b.operation_id
          WHERE b.data IS NOT NULL AND p.state IN ('accepted','suppressed','expired','known-failed') AND p.kind='ordinary' LIMIT 1000)`).run();
      return this.db.prepare(`UPDATE telegram_origin_materializations SET request_json=NULL WHERE rowid IN
        (SELECT m.rowid FROM telegram_origin_materializations m JOIN telegram_origin_children c ON c.child_id=m.child_id
          JOIN telegram_origin_operations p ON p.operation_id=c.operation_id WHERE m.request_json IS NOT NULL
          AND p.state IN ('accepted','suppressed','expired','known-failed') AND p.kind='ordinary' LIMIT 1000)`).run().changes;
    }).immediate();
  }

  diagnostics(): { path: string; synchronous: number; journalMode: string; archiveReads: { filesVerified: number; bytesHashed: number } } {
    return { path: this.queue.pathOnDisk(), synchronous: this.db.pragma('synchronous', { simple: true }) as number, journalMode: this.db.pragma('journal_mode', { simple: true }) as string, archiveReads: { ...this.archiveReadStats } };
  }
  getPayload(payloadId: string): Uint8Array {
    id(payloadId);
    const row = this.db.prepare('SELECT digest,size,data FROM telegram_origin_payloads WHERE payload_id=?').get(payloadId) as { digest: string; size: number; data: Buffer | null } | undefined;
    if (!row?.data || row.data.byteLength !== row.size || digest(row.data) !== row.digest) fail('attachment-custody-unavailable');
    return row!.data!;
  }
  consumeAuditAssertion(input: { jti: string; expiresAt: number }): boolean {
    const now = Date.now(); id(input.jti); integer(input.expiresAt, now + 1, now + 10_000);
    return this.db.transaction(() => {
      if (this.db.prepare('SELECT 1 FROM telegram_origin_audit_assertions WHERE jti=?').get(input.jti)) return false;
      const expired = this.db.prepare('SELECT slot FROM telegram_origin_audit_assertions WHERE expires_at<=? ORDER BY slot LIMIT 1').get(now) as { slot: number } | undefined;
      if (expired) {
        this.db.prepare('UPDATE telegram_origin_audit_assertions SET jti=?,expires_at=? WHERE slot=? AND expires_at<=?')
          .run(input.jti, input.expiresAt, expired.slot, now);
        return true;
      }
      const count = (this.db.prepare('SELECT count(*) n FROM telegram_origin_audit_assertions').get() as { n: number }).n;
      if (count >= 1000) return false; // Never evict an unexpired replay fence.
      this.db.prepare('INSERT INTO telegram_origin_audit_assertions VALUES (?,?,?)').run(count, input.jti, input.expiresAt);
      return true;
    }).immediate();
  }
  close(): void { this.queue.close(); }
}
