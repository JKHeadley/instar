/** Async owner of a long-lived worker. Never falls back to synchronous DB work.
 * A timed-out mutation may have committed: callers must read the same outbox
 * after recovery, never acquire execution authority from an evidence mirror.
 */
import { Worker } from 'node:worker_threads';
import { DegradationReporter } from '../../monitoring/DegradationReporter.js';
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
// Request deadlines protect an already-running worker operation. Starting a
// fresh worker is a different boundary: under host pressure Node can defer the
// worker bootstrap well beyond an ordinary DB request without the worker being
// unhealthy. Keep startup bounded, but do not let the shorter request budget
// misclassify scheduler delay as a storage outage.
const WORKER_STARTUP_TIMEOUT_MS = 30_000;
// A caller deadline answers one caller; it never condemns the worker. Only a
// worker that makes no progress (answers nothing) for the stall deadline while
// work is outstanding is stuck; time queued behind progressing work is not
// (2026-09-26: one 2s boot-time request latched every Telegram send until a
// manual server restart).
const DEFAULT_STALL_TIMEOUT_MS = 30_000;
// The restart budget and outage episode close only after a generation has
// stayed failure-free this long; one served response between recurring stalls
// must not buy a fresh budget (or a fresh report).
const DEFAULT_RESTART = { baseDelayMs: 1000, maxDelayMs: 30_000, maxAttempts: 6, healthyWindowMs: 5 * 60_000 };

export type OriginStoreState = 'starting' | 'ready' | 'restarting' | 'exhausted' | 'closed';
export interface OriginStoreHealth {
  mode: 'store' | 'spool';
  state: OriginStoreState;
  generation: number;
  restarts: number;
  consecutiveFailures: number;
  maxRestartAttempts: number;
  downSince: number | null;
  lastFailure: { reason: string; at: number } | null;
  lastRecoveredAt: number | null;
}
interface PendingRequest {
  resolve: (value: unknown) => void; reject: (error: Error) => void;
  deadline: NodeJS.Timeout | null; method: string; write: boolean; bytes: number; settled: boolean;
}

/** Owns one worker generation at a time. A failed generation rejects its
 * in-flight callers (writes as outcome-unknown, never replayed here) and is
 * replaced after a bounded backoff; while no generation is ready every call
 * fails closed. Past the restart cap the store stays down and reports
 * needsReplacement() to the runtime's slower recovery reopen, whose
 * replacement inherits the spent budget and the open outage episode.
 * @self-action-controller: origin-store-worker-restart */
export class OriginStore {
  private worker!: Worker;
  private readonly requests = new Map<number, PendingRequest>();
  private pendingBytes = 0;
  private readonly maxPendingBytes: number;
  private nextId = 0;
  private state: OriginStoreState = 'starting';
  private closing = false;
  private ready!: Promise<void>;
  private readonly timeoutMs: number;
  private readonly stallTimeoutMs: number;
  private readonly restart: { baseDelayMs: number; maxDelayMs: number; maxAttempts: number; healthyWindowMs: number };
  private stallTimer: NodeJS.Timeout | null = null;
  private readyAt = 0;
  private generation = 0;
  private restarts = 0;
  private consecutiveFailures = 0;
  private downSince: number | null = null;
  private lastFailure: { reason: string; at: number } | null = null;
  private lastRecoveredAt: number | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private readonly env: NodeJS.ProcessEnv = {};
  private constructor(private readonly options: OriginStoreOptions, private readonly mode?: 'spool', private readonly workerUrl = new URL('./OriginStore.worker.js', import.meta.url),
    carry?: { consecutiveFailures: number; downSince: number | null }) {
    this.timeoutMs = options.requestTimeoutMs ?? 2000;
    this.stallTimeoutMs = options.stallTimeoutMs ?? Math.max(DEFAULT_STALL_TIMEOUT_MS, this.timeoutMs);
    this.restart = { baseDelayMs: options.restart?.baseDelayMs ?? DEFAULT_RESTART.baseDelayMs,
      maxDelayMs: options.restart?.maxDelayMs ?? DEFAULT_RESTART.maxDelayMs, maxAttempts: options.restart?.maxAttempts ?? DEFAULT_RESTART.maxAttempts,
      healthyWindowMs: options.restart?.healthyWindowMs ?? DEFAULT_RESTART.healthyWindowMs };
    this.maxPendingBytes = options.maxPendingBytes ?? 256 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxPendingBytes) || this.maxPendingBytes < 1024 || this.maxPendingBytes > 256 * 1024 * 1024) throw new Error('origin-store:invalid-pending-byte-budget');
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 30_000) throw new Error('origin-store:invalid-timeout');
    if (!Number.isSafeInteger(this.stallTimeoutMs) || this.stallTimeoutMs < this.timeoutMs || this.stallTimeoutMs > 300_000) throw new Error('origin-store:invalid-stall-timeout');
    const { baseDelayMs, maxDelayMs, maxAttempts, healthyWindowMs } = this.restart;
    if (![baseDelayMs, maxDelayMs, maxAttempts, healthyWindowMs].every(Number.isSafeInteger) || baseDelayMs < 1 || maxDelayMs < baseDelayMs ||
      maxDelayMs > 15 * 60_000 || maxAttempts < 0 || maxAttempts > 100 || healthyWindowMs < 1 || healthyWindowMs > 24 * 60 * 60_000) throw new Error('origin-store:invalid-restart-policy');
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot']) if (process.env[key]) this.env[key] = process.env[key];
    if (carry) { this.consecutiveFailures = carry.consecutiveFailures; this.downSince = carry.downSince; }
    this.spawn();
  }
  /** workerUrl exists for tests exercising the same compiled worker in isolation. */
  static async open(options: OriginStoreOptions, workerUrl?: URL): Promise<OriginStore> {
    const store = new OriginStore(options, undefined, workerUrl);
    try { await store.ready; } catch (error) { await store.close(); throw error; }
    return store;
  }
  static async openSpool(options: OriginStoreOptions, workerUrl?: URL): Promise<OriginStore> {
    const store = new OriginStore(options, 'spool', workerUrl);
    try { await store.ready; } catch (error) { await store.close(); throw error; }
    return store;
  }
  /** The runtime's recovery reopen. Only a served response restores the
   * restart budget, so a sustained outage cannot earn a fresh burst of
   * restarts (or a fresh report) from each slow reopen. */
  static async openReplacement(previous: OriginStore, options: OriginStoreOptions, mode?: 'spool', workerUrl?: URL): Promise<OriginStore> {
    const { consecutiveFailures, downSince } = previous.health();
    const store = new OriginStore(options, mode, workerUrl, { consecutiveFailures, downSince });
    try { await store.ready; } catch (error) { await store.close(); throw error; }
    return store;
  }
  /** Production boot must preserve health/hold visibility during a storage
   * outage. A failed first generation restarts under the same bounded policy
   * as any later one; it never falls back to in-memory writes. */
  static async openForRuntime(options: OriginStoreOptions, mode?: 'spool', workerUrl?: URL): Promise<OriginStore> {
    const store = new OriginStore(options, mode, workerUrl);
    try { await store.ready; } catch { /* The failed generation already scheduled its bounded restart. */ }
    return store;
  }
  private spawn(): void {
    // A file worker must not inherit stdin/eval-only flags or parent preload hooks.
    const worker = new Worker(this.workerUrl, { workerData: { options: this.options, mode: this.mode }, env: this.env, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 384 } });
    this.worker = worker; this.generation++; this.state = 'starting';
    this.ready = new Promise<void>((resolve, reject) => {
      const startup = setTimeout(() => { reject(new OriginStoreUnavailableError('origin worker startup timed out', false)); this.fail(worker, 'startup-timeout'); }, WORKER_STARTUP_TIMEOUT_MS);
      worker.once('message', (message: { ready?: boolean; error?: string }) => {
        clearTimeout(startup);
        if (message.ready) {
          if (worker === this.worker && this.state === 'starting') { this.state = 'ready'; this.readyAt = Date.now(); }
          resolve();
        } else { reject(new OriginStoreUnavailableError(message.error ?? 'origin worker startup failed', false)); this.fail(worker, `startup-failed: ${message.error ?? 'unknown'}`); }
      });
      worker.once('error', error => { clearTimeout(startup); reject(new OriginStoreUnavailableError(error.message, false)); });
      worker.once('exit', code => { clearTimeout(startup); reject(new OriginStoreUnavailableError(`origin worker exited (${code})`, false)); });
    });
    this.ready.catch(() => { /* Observed by open()/call(); a restart owns the recovery. */ });
    worker.on('message', (message: { id?: number; result?: unknown; error?: string }) => {
      if (message.id === undefined || worker !== this.worker) return;
      const pending = this.requests.get(message.id); if (!pending) return;
      this.requests.delete(message.id); this.pendingBytes -= pending.bytes;
      if (pending.deadline) clearTimeout(pending.deadline);
      this.markResponsive();
      this.armStallWatch(worker, true);
      if (pending.settled) return; // The caller already holds an outcome-unknown result.
      pending.settled = true;
      if (message.error) pending.reject(new OriginStoreOperationError(message.error)); else pending.resolve(message.result);
    });
    worker.on('error', error => this.fail(worker, `worker-error: ${error.message}`));
    worker.on('exit', code => this.fail(worker, `worker-exited (${code})`));
  }
  /** A served response closes the outage episode and restores the restart
   * budget only once this generation has stayed failure-free for the healthy
   * window; recurring stalls keep accumulating toward the cap. */
  private markResponsive(): void {
    if (Date.now() - this.readyAt < this.restart.healthyWindowMs) return;
    this.consecutiveFailures = 0;
    if (this.downSince === null) return;
    console.warn(`[telegram-origin] ${this.mode ?? 'store'} worker recovered after ${Date.now() - this.downSince}ms (generation ${this.generation})`);
    this.downSince = null; this.lastRecoveredAt = Date.now();
  }
  /** One progress watchdog: fires only when the worker has answered nothing
   * for the stall deadline while requests are outstanding. Each response
   * restarts it, so queue wait behind progressing work never counts. */
  private armStallWatch(worker: Worker, progressed: boolean): void {
    if (progressed && this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
    if (this.stallTimer || this.requests.size === 0) return;
    this.stallTimer = setTimeout(() => {
      this.stallTimer = null;
      const oldest = this.requests.values().next().value;
      if (worker === this.worker && oldest) this.fail(worker, `request-stalled: ${oldest.method} with no worker progress for ${this.stallTimeoutMs}ms`);
    }, this.stallTimeoutMs);
  }
  private rejectPending(): void {
    if (this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
    for (const pending of this.requests.values()) {
      if (pending.deadline) clearTimeout(pending.deadline);
      if (!pending.settled) { pending.settled = true; pending.reject(new OriginStoreUnavailableError('origin worker unavailable; resolve committed state before retry', pending.write)); }
    }
    this.requests.clear();
    this.pendingBytes = 0;
  }
  private fail(worker: Worker, reason: string): void {
    // Stale generations, and the exit that follows our own terminate, are already handled.
    if (worker !== this.worker || this.state === 'restarting' || this.state === 'exhausted' || this.state === 'closed') return;
    this.rejectPending();
    void worker.terminate().catch(() => { /* Worker is already exited; callers received the explicit unavailable result. */ });
    if (this.closing) { this.state = 'closed'; return; }
    const now = Date.now();
    this.consecutiveFailures++; this.lastFailure = { reason, at: now };
    if (this.downSince === null) {
      this.downSince = now;
      // One report per outage episode; restarts inside the episode stay quiet.
      DegradationReporter.getInstance().report({ feature: `telegram-origin.${this.mode ?? 'store'}-worker`,
        primary: 'Durable origin worker records and admits every outbound Telegram send',
        fallback: 'Sends are held (fail-closed, nothing sent unrecorded) while the worker restarts with bounded backoff',
        reason, impact: 'Outbound Telegram messages are held until the origin worker recovers; held work drains through the existing recovery tick.' });
    }
    if (this.consecutiveFailures > this.restart.maxAttempts) {
      this.state = 'exhausted';
      console.error(`[telegram-origin] ${this.mode ?? 'store'} worker restart cap (${this.restart.maxAttempts}) reached; held until the recovery reopen (${reason})`);
      return;
    }
    this.state = 'restarting'; this.restarts++;
    const delay = Math.min(this.restart.baseDelayMs * 2 ** (this.consecutiveFailures - 1), this.restart.maxDelayMs);
    console.warn(`[telegram-origin] ${this.mode ?? 'store'} worker failed (${reason}); restart ${this.consecutiveFailures}/${this.restart.maxAttempts} in ${delay}ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.state === 'restarting' && !this.closing) this.spawn();
    }, delay);
    this.restartTimer.unref();
  }
  private async call<T>(method: string, input?: unknown): Promise<T> {
    if (this.state === 'starting') { try { await this.ready; } catch { /* Reported below as unavailable. */ } }
    if (this.state !== 'ready') throw new OriginStoreUnavailableError(`origin worker is closed/unavailable (${this.state})`, false);
    if (this.requests.size >= 1000) throw new OriginStoreBackpressureError();
    const bytes = workerInputBytes(input, this.maxPendingBytes - this.pendingBytes);
    const id = ++this.nextId, worker = this.worker;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest = { resolve: value => resolve(value as T), reject, method, write: !READS.has(method), bytes, settled: false,
        deadline: setTimeout(() => {
          pending.deadline = null;
          if (pending.settled) return;
          // The worker keeps the request and serializes later reads behind it,
          // so a caller that re-reads after this sees whatever it committed.
          pending.settled = true;
          reject(new OriginStoreUnavailableError('origin request deadline exceeded; resolve committed state before retry', pending.write));
        }, this.timeoutMs) };
      this.pendingBytes += bytes;
      this.requests.set(id, pending);
      this.armStallWatch(worker, false);
      try { worker.postMessage({ id, method, input }); } catch (error) {
        if (pending.deadline) clearTimeout(pending.deadline);
        this.requests.delete(id); this.pendingBytes -= bytes; pending.settled = true; reject(error);
        if (this.requests.size === 0 && this.stallTimer) { clearTimeout(this.stallTimer); this.stallTimer = null; }
      }
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
  reserveRecoveryAttempt(input: { operationId: string; now?: number }): Promise<boolean> { return this.call('reserveRecoveryAttempt', input); }
  isUnavailable(): boolean { return this.state !== 'ready'; }
  /** The runtime recovery tick asks for the next attempt now instead of
   * waiting out the backoff. It counts against the same restart cap. */
  async restartNow(): Promise<void> {
    if (this.state === 'restarting' && !this.closing) {
      if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
      this.spawn();
    }
    if (this.state === 'starting') await this.ready;
    if (this.state !== 'ready') throw new OriginStoreUnavailableError(`origin worker is closed/unavailable (${this.state})`, false);
  }
  /** True only once this store will not recover by itself: closed, or past its restart cap. */
  needsReplacement(): boolean { return this.state === 'exhausted' || this.state === 'closed'; }
  health(): OriginStoreHealth {
    return { mode: this.mode ?? 'store', state: this.state, generation: this.generation, restarts: this.restarts,
      consecutiveFailures: this.consecutiveFailures, maxRestartAttempts: this.restart.maxAttempts, downSince: this.downSince,
      lastFailure: this.lastFailure, lastRecoveredAt: this.lastRecoveredAt };
  }
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
  async close(): Promise<void> {
    if (this.closing || this.state === 'closed') return;
    this.closing = true;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    const serving = this.state === 'ready';
    try { if (serving) await this.call('close'); }
    finally {
      this.rejectPending(); this.state = 'closed';
      void this.worker.terminate().catch(() => { /* Already exited after its close response. */ });
    }
  }
}
