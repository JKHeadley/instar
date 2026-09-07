/** Async owner of a long-lived worker. Never falls back to synchronous DB work.
 * A timed-out mutation may have committed: callers must read the same outbox
 * after recovery, never acquire execution authority from an evidence mirror.
 */
import { Worker } from 'node:worker_threads';
import type {
  AdmissionResult, ArchiveResult, ClaimFence, ClaimInput, ClaimResult, DerivedMaterializationInput,
  EvidenceReceipt, NoticeReservation, NoticeReservationInput, OriginAdmission, OriginAuditRecord,
  OriginListPage, OriginListQuery, OriginMetrics, OriginStoreOptions, OutcomeInput, OutcomeWriteResult,
  StoredChild, StoredOriginInput,
} from './StoreTypes.js';

export class OriginStoreUnavailableError extends Error {
  readonly code = 'origin-store-unavailable';
  constructor(message: string, readonly mutationMayHaveCommitted: boolean) { super(message); this.name = 'OriginStoreUnavailableError'; }
}
export class OriginStoreOperationError extends Error {
  readonly code: string;
  constructor(message: string) { super(message); this.name = 'OriginStoreOperationError'; this.code = message.replace(/^origin-(?:store|spool):/, ''); }
}
export class OriginStoreBackpressureError extends Error {
  readonly code = 'origin-store-backpressure';
  readonly mutationMayHaveCommitted = false;
  constructor() { super('origin worker request capacity exhausted'); this.name = 'OriginStoreBackpressureError'; }
}
/** Count clone storage before postMessage can allocate another copy. Views
 * count their whole backing buffer, because structured clone retains it. */
function workerInputBytes(input: unknown, maximum: number): number {
  let bytes = 128, nodes = 0;
  const pending: unknown[] = [input], seen = new WeakSet<object>();
  while (pending.length) {
    if (++nodes > 100_000) throw new OriginStoreBackpressureError();
    const value = pending.pop();
    if (typeof value === 'string') bytes += value.length * 2 + 16;
    else if (value && typeof value === 'object') {
      if (seen.has(value)) continue;
      seen.add(value); bytes += 64;
      if (ArrayBuffer.isView(value)) pending.push(value.buffer);
      else if (value instanceof ArrayBuffer || typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) bytes += value.byteLength;
      else {
        const prototype = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) throw new OriginStoreOperationError('origin-store:unsupported-worker-input');
        for (const key in value) if (Object.hasOwn(value, key)) {
          bytes += key.length * 2 + 8;
          if (pending.length >= 100_000 || bytes > maximum) throw new OriginStoreBackpressureError();
          pending.push((value as Record<string, unknown>)[key]);
        }
      }
    } else bytes += 8;
    if (bytes > maximum) throw new OriginStoreBackpressureError();
  }
  return bytes;
}
const READS = new Set(['getOrigin', 'getChild', 'getOperation', 'getPayload', 'listOrigins', 'getMetrics', 'diagnostics', 'recoverableAdmissions', 'legacyCandidates', 'undiagnosedOrigins', 'getFederatedMetrics', 'getBrowserRecoveryStates']);

export class OriginStore {
  private readonly worker: Worker;
  private readonly requests = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout; write: boolean; bytes: number }>();
  private pendingBytes = 0;
  private readonly maxPendingBytes: number;
  private nextId = 0;
  private unavailable = false;
  private readonly ready: Promise<void>;
  private readonly timeoutMs: number;
  private constructor(options: OriginStoreOptions, mode?: 'spool', workerUrl = new URL('./OriginStore.worker.js', import.meta.url)) {
    this.timeoutMs = options.requestTimeoutMs ?? 2000;
    this.maxPendingBytes = options.maxPendingBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes < 1024 || this.maxPendingBytes > 256 * 1024 * 1024) throw new Error('origin-store:invalid-pending-byte-budget');
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error('origin-store:invalid-timeout');
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) if (process.env[key]) env[key] = process.env[key];
    // A file worker must not inherit stdin/eval-only flags or parent preload hooks.
    this.worker = new Worker(workerUrl, { workerData: { options, mode }, env, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 384 } });
    this.ready = new Promise<void>((resolve, reject) => {
      const startup = setTimeout(() => { reject(new OriginStoreUnavailableError('origin worker startup timed out', false)); this.fail(); }, this.timeoutMs);
      this.worker.once('message', (message: { ready?: boolean; error?: string }) => {
        clearTimeout(startup);
        if (message.ready) resolve();
        else { reject(new OriginStoreUnavailableError(message.error ?? 'origin worker startup failed', false)); this.fail(); }
      });
      this.worker.once('error', error => { clearTimeout(startup); reject(new OriginStoreUnavailableError(error.message, false)); });
      this.worker.once('exit', code => { clearTimeout(startup); reject(new OriginStoreUnavailableError(`origin worker exited (${code})`, false)); });
    });
    this.worker.on('message', (message: { id?: number; result?: unknown; error?: string }) => {
      if (message.id === undefined) return;
      const pending = this.requests.get(message.id); if (!pending) return;
      clearTimeout(pending.timer); this.requests.delete(message.id); this.pendingBytes -= pending.bytes;
      if (message.error) pending.reject(new OriginStoreOperationError(message.error)); else pending.resolve(message.result);
    });
    this.worker.on('error', () => this.fail());
    this.worker.on('exit', () => this.fail());
  }
  /** workerUrl exists for tests exercising the same compiled worker in isolation. */
  static async open(options: OriginStoreOptions, workerUrl?: URL): Promise<OriginStore> {
    const store = new OriginStore(options, undefined, workerUrl); await store.ready; return store;
  }
  static async openSpool(options: OriginStoreOptions, workerUrl?: URL): Promise<OriginStore> {
    const store = new OriginStore(options, 'spool', workerUrl); await store.ready; return store;
  }
  /** Production boot must preserve health/hold visibility during a storage
   * outage. This facade remains explicitly unavailable until the existing
   * recovery authority replaces it; it never falls back to in-memory writes. */
  static async openForRuntime(options: OriginStoreOptions, mode?: 'spool', workerUrl?: URL): Promise<OriginStore> {
    const store = new OriginStore(options, mode, workerUrl);
    try { await store.ready; }
    catch { store.fail(); }
    return store;
  }
  private fail(): void {
    if (this.unavailable) return; this.unavailable = true;
    for (const pending of this.requests.values()) { clearTimeout(pending.timer); pending.reject(new OriginStoreUnavailableError('origin worker unavailable; resolve committed state before retry', pending.write)); }
    this.requests.clear();
    this.pendingBytes = 0;
    void this.worker.terminate().catch(() => { /* Worker is already exited; callers received the explicit unavailable result. */ });
  }
  private async call<T>(method: string, input?: unknown): Promise<T> {
    await this.ready;
    if (this.unavailable) throw new OriginStoreUnavailableError('origin worker is closed/unavailable', false);
    if (this.requests.size >= 1000) throw new OriginStoreBackpressureError();
    const bytes = workerInputBytes(input, this.maxPendingBytes - this.pendingBytes);
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(), this.timeoutMs);
      this.pendingBytes += bytes;
      this.requests.set(id, { resolve: value => resolve(value as T), reject, timer, write: !READS.has(method), bytes });
      try { this.worker.postMessage({ id, method, input }); } catch (error) { clearTimeout(timer); this.requests.delete(id); this.pendingBytes -= bytes; reject(error); }
    });
  }
  putEvidence(input: StoredOriginInput): Promise<EvidenceReceipt> { return this.call('putEvidence', input); }
  putVerifiedEvidence(input: Parameters<import('./OriginStoreBackend.js').OriginStoreBackend['putVerifiedEvidence']>[0]): Promise<EvidenceReceipt> { return this.call('putVerifiedEvidence', input); }
  admit(input: OriginAdmission): Promise<AdmissionResult> { return this.call('admit', input); }
  browserRecovery(input: Parameters<import('./OriginStoreBackend.js').OriginStoreBackend['browserRecovery']>[0]): Promise<import('./OriginBrowserRecovery.js').BrowserRecoveryDecision> { return this.call('browserRecovery', input); }
  reserveDiagnostic(input: { originId: string; reason: string }): Promise<boolean> { return this.call('reserveDiagnostic', input); }
  completeDiagnostic(input: { originId: string; diagnosis?: string }): Promise<boolean> { return this.call('completeDiagnostic', input); }
  legacyCandidates(): Promise<import('./OriginLegacy.js').OriginLegacySnapshot[]> { return this.call('legacyCandidates'); }
  importLegacy(input: { snapshot: import('./OriginLegacy.js').OriginLegacySnapshot; admission: OriginAdmission }): Promise<boolean> { return this.call('importLegacy', input); }
  getOrigin(originId: string): Promise<OriginAuditRecord | null> { return this.call('getOrigin', originId); }
  getOperation(operationId: string): Promise<OriginAuditRecord | null> { return this.call('getOperation', operationId); }
  recoverableAdmissions(input: { limit?: number; now?: number } = {}): Promise<OriginAdmission[]> { return this.call('recoverableAdmissions', input); }
  /** Advances a durable scan cursor; selection grants no execution claim. */
  takeRecoverableAdmissions(input: { limit?: number; now?: number } = {}): Promise<OriginAdmission[]> { return this.call('takeRecoverableAdmissions', input); }
  isUnavailable(): boolean { return this.unavailable; }
  getChild(childId: string): Promise<StoredChild | null> { return this.call('getChild', childId); }
  getPayload(payloadId: string): Promise<Uint8Array> { return this.call('getPayload', payloadId); }
  consumeAuditAssertion(input: { jti: string; expiresAt: number }): Promise<boolean> { return this.call('consumeAuditAssertion', input); }
  listOrigins(query: OriginListQuery = {}): Promise<OriginListPage> { return this.call('listOrigins', query); }
  getMetrics(): Promise<OriginMetrics> { return this.call('getMetrics'); }
  undiagnosedOrigins(): Promise<Array<{ originId: string; reason: string }>> { return this.call('undiagnosedOrigins'); }
  getBrowserRecoveryStates(): Promise<ReturnType<import('./OriginStoreBackend.js').OriginStoreBackend['getBrowserRecoveryStates']>> { return this.call('getBrowserRecoveryStates'); }
  getFederatedMetrics(machineId: string): Promise<OriginMetrics> { return this.call('getFederatedMetrics', machineId); }
  healthTransaction(): Promise<void> { return this.call('healthTransaction'); }
  registerOwner(input: { ownerBootId: string; machineId: string }): Promise<void> { return this.call('registerOwner', input); }
  claim(input: ClaimInput): Promise<ClaimResult> { return this.call('claim', input); }
  markDispatched(input: ClaimFence & { now?: number }): Promise<boolean> { return this.call('markDispatched', input); }
  releaseUndispatchedClaim(input: ClaimFence & { now?: number }): Promise<boolean> { return this.call('releaseUndispatchedClaim', input); }
  renewClaim(input: ClaimFence & { leaseMs: number; now?: number }): Promise<boolean> { return this.call('renewClaim', input); }
  recordOutcome(input: OutcomeInput): Promise<OutcomeWriteResult> { return this.call('recordOutcome', input); }
  reapAbandoned(now?: number): Promise<number> { return this.call('reapAbandoned', now); }
  addMaterialization(input: DerivedMaterializationInput): Promise<boolean> { return this.call('addMaterialization', input); }
  recordOperationState(input: { operationId: string; state: 'held' | 'suppressed' | 'expired' | 'admitted'; now?: number }): Promise<boolean> { return this.call('recordOperationState', input); }
  reserveNotice(input: NoticeReservationInput): Promise<NoticeReservation> { return this.call('reserveNotice', input); }
  recordNoticeOutcome(input: Parameters<import('./OriginStoreBackend.js').OriginStoreBackend['recordNoticeOutcome']>[0]): Promise<OutcomeWriteResult> { return this.call('recordNoticeOutcome', input); }
  retireNoticeOwner(ownerBootId: string): Promise<number> { return this.call('retireNoticeOwner', ownerBootId); }
  reconcileReceipt(input: { childId: string; attemptId: string; receiptJson: string; outcome: 'accepted' | 'scheduled'; now?: number }): Promise<boolean> { return this.call('reconcileReceipt', input); }
  archive(input: { before: number; limit?: number }): Promise<ArchiveResult> { return this.call('archive', input); }
  cleanupPayloads(now?: number): Promise<number> { return this.call('cleanupPayloads', now); }
  diagnostics(): Promise<{ path: string; synchronous: number; journalMode: string; archiveReads: { filesVerified: number; bytesHashed: number } }> { return this.call('diagnostics'); }
  async close(): Promise<void> { if (this.unavailable) return; try { await this.call('close'); } finally { this.fail(); } }
}
