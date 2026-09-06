import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { WindowRunLivenessDocument, WindowRunWorkReceipt } from './WindowRunLivenessAuthority.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import { sign as signEd25519, verify as verifyEd25519 } from '../threadline/ThreadlineCrypto.js';

export const WINDOW_RUN_CADENCE_VERSION = 1 as const;
export const WINDOW_RUN_CADENCE_DEFAULTS = {
  receiptIntervalMs: 30 * 60_000,
  reportIntervalMs: 3 * 60 * 60_000,
  checkpointLeadMs: 5 * 60_000,
  receiptGraceMs: 5 * 60_000,
  checkpointRetryMaxAttempts: 2,
  checkpointRetryBackoffMs: 60_000,
  reportRetryMaxAttempts: 3,
  reportRetryBackoffMs: 60_000,
} as const;

export interface WindowRunCadenceConfig {
  enabled?: boolean;
  /** Observe and persist due actions without injecting or delivering. */
  dryRun?: boolean;
  receiptIntervalMs?: number;
  reportIntervalMs?: number;
  checkpointLeadMs?: number;
  receiptGraceMs?: number;
  checkpointRetryMaxAttempts?: number;
  checkpointRetryBackoffMs?: number;
  reportRetryMaxAttempts?: number;
  reportRetryBackoffMs?: number;
}

export interface WindowCadenceIntervalReceipt {
  number: number;
  dueAt: string;
  evaluatedAt: string;
  outcome: 'passed' | 'missed';
  workReceiptId?: string;
  workSequence?: number;
  workObservedAt?: string;
}

export interface WindowCadenceCheckpointRequest {
  dueAt: string;
  requestedAt: string;
  taskRef: string;
  outcome: 'would-request' | 'attempting' | 'delivered' | 'failed';
  attemptCount: number;
  nextAttemptAt?: string;
  deliveryReceipt?: string;
}

export interface WindowCadenceReportReceipt {
  reportId: string;
  dueAt: string;
  attemptedAt: string;
  status: 'would-deliver' | 'attempting' | 'delivered' | 'failed';
  messageId?: number;
  deliveredAt?: string;
  error?: string;
  attemptCount: number;
  nextAttemptAt?: string;
  /** SHA-256 of the exact synthesis body before the visible signature line. */
  bodyHash?: string;
  /** Immutable synthesis body; retries must send byte-identical signed content. */
  body?: string;
  /** Ed25519 signature over the exact run/report binding and body hash. */
  producerSignature?: string;
}

export interface WindowRunCadenceDocument {
  version: 1;
  windowId: string;
  topicId: number;
  autonomousRunId: string;
  lifecycleRunId: string;
  executorId: string;
  status: 'running' | 'failed' | 'closed';
  startedAt: string;
  nextReceiptDueAt: string;
  nextReportDueAt: string;
  lastTickAt?: string;
  lastReceiptedSequence: number;
  intervals: WindowCadenceIntervalReceipt[];
  checkpoints: WindowCadenceCheckpointRequest[];
  reports: WindowCadenceReportReceipt[];
  failure?: {
    at: string;
    reason: string;
    notified: boolean;
    notificationId: string;
    notificationAttemptCount: number;
    notificationNextAttemptAt?: string;
    notificationMessageId?: number;
  };
  closedAt?: string;
}

export interface WindowRunCadenceDeps {
  getLiveness: () => WindowRunLivenessDocument | null;
  /** Cross-machine actuation authority. Single-machine deployments return true. */
  canAct?: (state: Readonly<WindowRunLivenessDocument>) => boolean;
  resolveFirstUnreceiptedTask: (state: Readonly<WindowRunLivenessDocument>) => string | null;
  requestCheckpoint?: (request: {
    state: Readonly<WindowRunLivenessDocument>;
    dueAt: string;
    taskRef: string;
  }) => Promise<{ delivered: boolean; receipt: string }>;
  deliverSynthesis?: (request: {
    state: Readonly<WindowRunLivenessDocument>;
    reportId: string;
    dueAt: string;
    text: string;
  }) => Promise<{ messageId: number }>;
  /** Sign the immutable report/run binding before any delivery attempt. */
  signSynthesis?: (request: {
    state: Readonly<WindowRunLivenessDocument>;
    reportId: string;
    dueAt: string;
    bodyHash: string;
  }) => string;
  /** Re-query the adapter's local durable outbound history before retrying an ambiguous send. */
  findDeliveredSynthesis?: (request: {
    topicId: number;
    report: Readonly<WindowCadenceReportReceipt>;
    expectedText: string;
  }) => { messageId: number } | null;
  findDeliveredFailureNotification?: (topicId: number, notificationId: string) => number | null;
  notifyFailure?: (state: Readonly<WindowRunLivenessDocument>, message: string) => Promise<{ messageId: number }>;
  now?: () => string;
}

function validIso(value: string | undefined): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function boundedAttempts(value: number | undefined, fallback: number, hardCeiling: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? Math.min(value, hardCeiling) : fallback;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function cadenceReportProducerPayload(input: {
  windowId: string;
  topicId: number;
  autonomousRunId: string;
  lifecycleRunId: string;
  reportId: string;
  dueAt: string;
  bodyHash: string;
}): Buffer {
  return Buffer.from(JSON.stringify([
    'instar-window-run-cadence-report-v1',
    input.windowId,
    input.topicId,
    input.autonomousRunId,
    input.lifecycleRunId,
    input.reportId,
    input.dueAt,
    input.bodyHash,
  ]), 'utf8');
}

export function signCadenceReportProducer(payload: Buffer, privateKey: Buffer, publicKey: Buffer): string {
  if (privateKey.length !== 32 || publicKey.length !== 32) throw new Error('window-run-cadence-signing-key-invalid');
  const signature = signEd25519(privateKey, payload);
  if (!verifyEd25519(publicKey, payload, signature)) throw new Error('window-run-cadence-signing-keypair-mismatch');
  return signature.toString('base64url');
}

function livenessTerminal(status: WindowRunLivenessDocument['status']): boolean {
  return status === 'failed' || status === 'stalled' || status === 'closed';
}

export class WindowRunCadenceStore {
  readonly file: string;
  private readonly mutationTarget: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'window-run-cadence', 'state.json');
    this.mutationTarget = path.join(stateDir, 'window-run-cadence', 'mutation-target');
  }

  load(): WindowRunCadenceDocument | null {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8')) as WindowRunCadenceDocument;
      this.validate(value);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  save(value: WindowRunCadenceDocument): void {
    this.validate(value);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try { fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(tmp, this.file);
    } finally {
      try { if (fs.existsSync(tmp)) SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'WindowRunCadenceStore.save.cleanup' }); } catch { /* best-effort temp cleanup */ }
    }
  }

  async withMutation<T>(fn: () => Promise<T>): Promise<T> {
    fs.mkdirSync(path.dirname(this.mutationTarget), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.mutationTarget)) fs.writeFileSync(this.mutationTarget, '', { mode: 0o600 });
    const release = await lockfile.lock(this.mutationTarget, {
      realpath: false, stale: 120_000, update: 30_000,
      retries: { retries: 100, factor: 1, minTimeout: 5, maxTimeout: 20 },
    });
    try { return await fn(); } finally { await release(); }
  }

  private validate(value: WindowRunCadenceDocument): void {
    if (value?.version !== WINDOW_RUN_CADENCE_VERSION) throw new Error('window-run-cadence-version-invalid');
    if (!value.windowId || !value.autonomousRunId || !value.lifecycleRunId || !value.executorId) throw new Error('window-run-cadence-binding-invalid');
    if (!Number.isSafeInteger(value.topicId) || value.topicId < 0 || !validIso(value.startedAt) || !validIso(value.nextReceiptDueAt) || !validIso(value.nextReportDueAt)) throw new Error('window-run-cadence-state-invalid');
    if (!Number.isSafeInteger(value.lastReceiptedSequence) || value.lastReceiptedSequence < 0 || value.intervals.length > 64 || value.checkpoints.length > 64 || value.reports.length > 16) throw new Error('window-run-cadence-capacity-invalid');
  }
}

/* @self-action-controller: window-run-cadence-delivery-redrive */
export class WindowRunCadenceExecutor {
  private readonly cfg: Required<WindowRunCadenceConfig>;
  private ticking = false;

  constructor(
    private readonly store: WindowRunCadenceStore,
    private readonly deps: WindowRunCadenceDeps,
    config: WindowRunCadenceConfig = {},
  ) {
    this.cfg = {
      enabled: config.enabled === true,
      dryRun: config.dryRun !== false,
      receiptIntervalMs: positiveMs(config.receiptIntervalMs, WINDOW_RUN_CADENCE_DEFAULTS.receiptIntervalMs),
      reportIntervalMs: positiveMs(config.reportIntervalMs, WINDOW_RUN_CADENCE_DEFAULTS.reportIntervalMs),
      checkpointLeadMs: positiveMs(config.checkpointLeadMs, WINDOW_RUN_CADENCE_DEFAULTS.checkpointLeadMs),
      receiptGraceMs: positiveMs(config.receiptGraceMs, WINDOW_RUN_CADENCE_DEFAULTS.receiptGraceMs),
      checkpointRetryMaxAttempts: boundedAttempts(config.checkpointRetryMaxAttempts, WINDOW_RUN_CADENCE_DEFAULTS.checkpointRetryMaxAttempts, WINDOW_RUN_CADENCE_DEFAULTS.checkpointRetryMaxAttempts),
      checkpointRetryBackoffMs: positiveMs(config.checkpointRetryBackoffMs, WINDOW_RUN_CADENCE_DEFAULTS.checkpointRetryBackoffMs),
      reportRetryMaxAttempts: boundedAttempts(config.reportRetryMaxAttempts, WINDOW_RUN_CADENCE_DEFAULTS.reportRetryMaxAttempts, WINDOW_RUN_CADENCE_DEFAULTS.reportRetryMaxAttempts),
      reportRetryBackoffMs: positiveMs(config.reportRetryBackoffMs, WINDOW_RUN_CADENCE_DEFAULTS.reportRetryBackoffMs),
    };
    this.cfg.checkpointLeadMs = Math.min(this.cfg.checkpointLeadMs, this.cfg.receiptIntervalMs);
    this.cfg.receiptGraceMs = Math.min(this.cfg.receiptGraceMs, this.cfg.receiptIntervalMs);
  }

  status(): { enabled: boolean; dryRun: boolean; config: Omit<Required<WindowRunCadenceConfig>, 'enabled' | 'dryRun'>; state: WindowRunCadenceDocument | null } {
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      config: {
        receiptIntervalMs: this.cfg.receiptIntervalMs,
        reportIntervalMs: this.cfg.reportIntervalMs,
        checkpointLeadMs: this.cfg.checkpointLeadMs,
        receiptGraceMs: this.cfg.receiptGraceMs,
        checkpointRetryMaxAttempts: this.cfg.checkpointRetryMaxAttempts,
        checkpointRetryBackoffMs: this.cfg.checkpointRetryBackoffMs,
        reportRetryMaxAttempts: this.cfg.reportRetryMaxAttempts,
        reportRetryBackoffMs: this.cfg.reportRetryBackoffMs,
      },
      state: this.store.load(),
    };
  }

  async tick(): Promise<WindowRunCadenceDocument | null> {
    if (!this.cfg.enabled || this.ticking) return this.store.load();
    this.ticking = true;
    try {
      return await this.store.withMutation(async () => {
        const liveness = this.deps.getLiveness();
        if (!liveness) return this.store.load();
        const now = this.now();
        let state = this.store.load();
        // Registration/preparation is not window execution. Do not start a
        // clock, prompt, miss an interval, or report until the five-predicate
        // authority has actually promoted the run and stamped activation.
        if (!state && (liveness.status !== 'active' || !liveness.activatedAt)) return null;
        if (this.deps.canAct && !this.deps.canAct(liveness)) return state;
        if (!state || !this.sameBinding(state, liveness)) {
          if (state && state.status !== 'closed') throw new Error('window-run-cadence-active-binding-exists');
          state = this.initialize(liveness);
          this.store.save(state);
        }
        if (livenessTerminal(liveness.status)) {
          state.status = 'closed';
          state.closedAt ??= now;
          state.lastTickAt = now;
          this.store.save(state);
          return state;
        }

        // A verified authority rebind changes only the executor identity, not
        // the cadence binding or its elapsed clock/history.
        state.executorId = liveness.executorId;

        if (state.status === 'failed') {
          await this.notifyFailure(state, liveness);
          state.lastTickAt = now;
          this.store.save(state);
          return state;
        }

        await this.maybeRequestCheckpoint(state, liveness, now);
        this.materializeDueIntervals(state, liveness, now);
        await this.materializeDueReports(state, liveness, now);
        state.lastTickAt = now;
        this.store.save(state);
        return state;
      });
    } finally {
      this.ticking = false;
    }
  }

  private initialize(liveness: WindowRunLivenessDocument): WindowRunCadenceDocument {
    const startedAt = liveness.activatedAt;
    if (!startedAt) throw new Error('window-run-cadence-activation-missing');
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs)) throw new Error('window-run-cadence-start-invalid');
    return {
      version: WINDOW_RUN_CADENCE_VERSION,
      windowId: liveness.windowId,
      topicId: liveness.topicId,
      autonomousRunId: liveness.autonomousRunId,
      lifecycleRunId: liveness.lifecycleRunId,
      executorId: liveness.executorId,
      status: 'running',
      startedAt,
      nextReceiptDueAt: new Date(startedMs + this.cfg.receiptIntervalMs).toISOString(),
      nextReportDueAt: new Date(startedMs + this.cfg.reportIntervalMs).toISOString(),
      lastReceiptedSequence: 0,
      intervals: [], checkpoints: [], reports: [],
    };
  }

  private async maybeRequestCheckpoint(state: WindowRunCadenceDocument, liveness: WindowRunLivenessDocument, now: string): Promise<void> {
    const dueMs = Date.parse(state.nextReceiptDueAt);
    if (Date.parse(now) < dueMs - this.cfg.checkpointLeadMs) return;
    let request = state.checkpoints.find(item => item.dueAt === state.nextReceiptDueAt);
    if (request?.outcome === 'delivered' || request?.outcome === 'would-request') return;
    if (request && (request.attemptCount >= this.cfg.checkpointRetryMaxAttempts
      || request.nextAttemptAt && Date.parse(now) < Date.parse(request.nextAttemptAt))) return;
    const taskRef = this.deps.resolveFirstUnreceiptedTask(liveness);
    if (!taskRef) return;
    if (!request) {
      request = { dueAt: state.nextReceiptDueAt, requestedAt: now, taskRef, outcome: this.cfg.dryRun ? 'would-request' : 'failed', attemptCount: 0 };
      state.checkpoints.push(request);
    }
    if (this.cfg.dryRun || !this.deps.requestCheckpoint) return;
    request.taskRef = taskRef;
    request.requestedAt = now;
    request.attemptCount += 1;
    request.outcome = 'attempting';
    request.nextAttemptAt = new Date(Date.parse(now) + this.cfg.checkpointRetryBackoffMs * 2 ** (request.attemptCount - 1)).toISOString();
    this.store.save(state); // persist the bounded attempt before crossing the session boundary
    try {
      const result = await this.deps.requestCheckpoint({ state: liveness, dueAt: request.dueAt, taskRef });
      request.outcome = result.delivered ? 'delivered' : 'failed';
      request.deliveryReceipt = result.receipt;
    } catch (error) {
      request.outcome = 'failed';
      request.deliveryReceipt = `error:${digest(String(error))}`;
    }
    this.store.save(state);
  }

  private materializeDueIntervals(state: WindowRunCadenceDocument, liveness: WindowRunLivenessDocument, now: string): void {
    const receipts = liveness.audit.entries
      .filter((entry): entry is typeof entry & { workReceipt: WindowRunWorkReceipt } => entry.kind === 'work-receipt' && !!entry.workReceipt)
      .map(entry => entry.workReceipt)
      .sort((a, b) => a.sequence - b.sequence);
    for (let guard = 0; guard < 64 && Date.parse(now) >= Date.parse(state.nextReceiptDueAt); guard++) {
      const dueAt = state.nextReceiptDueAt;
      const dueMs = Date.parse(dueAt);
      const intervalStart = dueMs - this.cfg.receiptIntervalMs;
      const receipt = receipts.find(item => item.sequence > state.lastReceiptedSequence
        && Date.parse(item.observedAt) > intervalStart
        && Date.parse(item.observedAt) <= dueMs + this.cfg.receiptGraceMs);
      if (!receipt && Date.parse(now) <= dueMs + this.cfg.receiptGraceMs) break;
      if (receipt) {
        state.intervals.push({
          number: state.intervals.length + 1, dueAt, evaluatedAt: now, outcome: 'passed',
          workReceiptId: receipt.receiptId, workSequence: receipt.sequence, workObservedAt: receipt.observedAt,
        });
        state.lastReceiptedSequence = receipt.sequence;
      } else {
        state.intervals.push({ number: state.intervals.length + 1, dueAt, evaluatedAt: now, outcome: 'missed' });
        state.status = 'failed';
        this.fail(state, now, `receipt-interval-missed:${dueAt}`);
      }
      state.nextReceiptDueAt = new Date(dueMs + this.cfg.receiptIntervalMs).toISOString();
    }
  }

  private async materializeDueReports(state: WindowRunCadenceDocument, liveness: WindowRunLivenessDocument, now: string): Promise<void> {
    for (let guard = 0; guard < 16 && Date.parse(now) >= Date.parse(state.nextReportDueAt); guard++) {
      const dueAt = state.nextReportDueAt;
      const reportId = digest({ windowId: state.windowId, autonomousRunId: state.autonomousRunId, dueAt }).slice(0, 24);
      let report = state.reports.find(item => item.reportId === reportId);
      if (!report) {
        const body = this.synthesis(state, liveness, reportId);
        const bodyHash = createHash('sha256').update(body).digest('hex');
        let producerSignature: string | undefined;
        let signatureError: string | undefined;
        if (!this.cfg.dryRun) {
          try {
            producerSignature = this.deps.signSynthesis?.({ state: liveness, reportId, dueAt, bodyHash });
            if (!producerSignature) signatureError = 'synthesis-producer-signature-unavailable';
          } catch (error) {
            signatureError = `synthesis-producer-signature-error:${digest(String(error)).slice(0, 24)}`;
          }
        }
        report = {
          reportId, dueAt, attemptedAt: now,
          status: this.cfg.dryRun ? 'would-deliver' : signatureError ? 'failed' : 'attempting',
          attemptCount: 0, body, bodyHash, producerSignature, error: signatureError,
        };
        state.reports.push(report);
        if (signatureError) this.fail(state, now, `synthesis-producer-signature-unavailable:${reportId}`);
        this.store.save(state); // crash-open send becomes an explicit ambiguous attempt
      }
      if (!this.cfg.dryRun && report.status !== 'delivered') {
        const body = report.body ?? '';
        if (!report.bodyHash || createHash('sha256').update(body).digest('hex') !== report.bodyHash || !report.producerSignature) {
          report.status = 'failed'; report.error ??= 'synthesis-producer-signature-unavailable';
          this.fail(state, now, `synthesis-producer-signature-unavailable:${reportId}`);
          this.store.save(state);
          break;
        }
        const text = `${body}\nW32 cadence producer signature: ${report.producerSignature}`;
        const observed = this.deps.findDeliveredSynthesis?.({ topicId: state.topicId, report, expectedText: text }) ?? null;
        if (observed !== null) {
          report.status = 'delivered'; report.messageId = observed.messageId; report.deliveredAt = now;
        } else if (report.attemptCount >= this.cfg.reportRetryMaxAttempts) {
          report.status = 'failed';
          report.error ??= 'synthesis-delivery-attempts-exhausted';
          state.status = 'failed';
          this.fail(state, now, `synthesis-delivery-exhausted:${reportId}`);
        } else if (report.nextAttemptAt && Date.parse(now) < Date.parse(report.nextAttemptAt)) {
          break;
        } else if (this.deps.deliverSynthesis) {
          report.attemptCount += 1;
          report.attemptedAt = now;
          report.status = 'attempting';
          report.nextAttemptAt = new Date(Date.parse(now) + this.cfg.reportRetryBackoffMs * 2 ** (report.attemptCount - 1)).toISOString();
          this.store.save(state); // persist the bounded attempt before crossing the delivery boundary
          try {
            const delivered = await this.deps.deliverSynthesis({ state: liveness, reportId, dueAt, text });
            report.status = 'delivered'; report.messageId = delivered.messageId; report.deliveredAt = this.now(); report.error = undefined;
          } catch (error) {
            report.status = 'failed'; report.error = String(error).slice(0, 300);
            if (report.attemptCount >= this.cfg.reportRetryMaxAttempts) {
              state.status = 'failed';
              this.fail(state, now, `synthesis-delivery-exhausted:${reportId}`);
            }
          }
        } else {
          report.status = 'failed'; report.error = 'synthesis-delivery-unavailable';
        }
        this.store.save(state);
      }
      // A failed attempt stays due and is retried after durable-history requery.
      if (report.status === 'failed' || report.status === 'attempting') break;
      state.nextReportDueAt = new Date(Date.parse(dueAt) + this.cfg.reportIntervalMs).toISOString();
    }

    await this.notifyFailure(state, liveness);
  }

  private async notifyFailure(state: WindowRunCadenceDocument, liveness: WindowRunLivenessDocument): Promise<void> {
    if (!state.failure || state.failure.notified || this.cfg.dryRun || !this.deps.notifyFailure) return;
    const observed = this.deps.findDeliveredFailureNotification?.(state.topicId, state.failure.notificationId) ?? null;
    if (observed !== null) {
      state.failure.notified = true;
      state.failure.notificationMessageId = observed;
      return;
    }
    if (state.failure.notificationAttemptCount >= this.cfg.reportRetryMaxAttempts) return;
    const now = this.now();
    if (state.failure.notificationNextAttemptAt && Date.parse(now) < Date.parse(state.failure.notificationNextAttemptAt)) return;
    const detail = state.failure.reason.startsWith('receipt-interval-missed:')
      ? `missed its advancing durable-work receipt due at ${state.failure.reason.slice('receipt-interval-missed:'.length)}`
      : state.failure.reason.startsWith('synthesis-delivery-exhausted:')
        ? `exhausted bounded Telegram synthesis delivery for ${state.failure.reason.slice('synthesis-delivery-exhausted:'.length)}`
        : `could not produce an authenticated synthesis for ${state.failure.reason.split(':').at(-1) ?? 'the due report'}`;
    state.failure.notificationAttemptCount += 1;
    state.failure.notificationNextAttemptAt = new Date(Date.parse(now) + this.cfg.reportRetryBackoffMs * 2 ** (state.failure.notificationAttemptCount - 1)).toISOString();
    this.store.save(state); // crash-open notification becomes a bounded ambiguous attempt
    try {
      const result = await this.deps.notifyFailure(liveness, `Window ${state.windowId} ${detail}. Cadence is failed; active liveness must not be inferred. W32 cadence failure receipt: ${state.failure.notificationId}`);
      state.failure.notified = true;
      state.failure.notificationMessageId = result.messageId;
    } catch {
      // The next bounded attempt first re-queries the stable marker.
    }
  }

  private fail(state: WindowRunCadenceDocument, at: string, reason: string): void {
    state.status = 'failed';
    state.failure ??= {
      at,
      reason,
      notified: false,
      notificationId: digest({ windowId: state.windowId, autonomousRunId: state.autonomousRunId, reason }).slice(0, 24),
      notificationAttemptCount: 0,
    };
  }

  private synthesis(state: WindowRunCadenceDocument, liveness: WindowRunLivenessDocument, reportId: string): string {
    const passed = state.intervals.filter(item => item.outcome === 'passed').length;
    const missed = state.intervals.filter(item => item.outcome === 'missed').length;
    const recovery = liveness.recoveryAttempt
      ? `${liveness.recoveryAttempt.outcome} (${liveness.recoveryAttempt.number}/1; task ${liveness.recoveryAttempt.requestedTaskRef ?? 'unresolved'})`
      : 'not used (0/1)';
    const blocker = state.failure?.reason ?? (liveness.status === 'active' ? 'none observed' : `liveness is ${liveness.status}`);
    return [
      `W32 liveness: ${liveness.status}.`,
      `Progress: ${liveness.lastWorkReceipt?.sequence ?? 0} durable work receipt(s); ${passed} advancing 30-minute interval(s), ${missed} missed.`,
      `Recovery: ${recovery}.`,
      `Blockers: ${blocker}.`,
      `Next: continue the first unreceipted task and preserve the 30-minute receipt cadence.`,
      `W32 synthesis receipt: ${reportId}`,
    ].join(' ');
  }

  private sameBinding(state: WindowRunCadenceDocument, liveness: WindowRunLivenessDocument): boolean {
    return state.windowId === liveness.windowId
      && state.topicId === liveness.topicId
      && state.autonomousRunId === liveness.autonomousRunId
      && state.lifecycleRunId === liveness.lifecycleRunId;
  }

  private now(): string {
    const now = this.deps.now?.() ?? new Date().toISOString();
    if (!validIso(now)) throw new Error('window-run-cadence-clock-invalid');
    return now;
  }
}
