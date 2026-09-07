import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import { SafeFsExecutor } from './SafeFsExecutor.js';

export const WINDOW_RUN_LIVENESS_VERSION = 1 as const;
export const WINDOW_RUN_LIVENESS_DEFAULTS = {
  heartbeatMaxAgeMs: 90_000,
  workEvidenceMaxAgeMs: 30 * 60_000,
  recoveryCeilingMs: 15 * 60_000,
} as const;
/** 24h at one sample/minute plus ample recovery/work headroom. Overflow fails closed. */
export const WINDOW_RUN_LIVENESS_MAX_AUDIT_ENTRIES = 4_096;

export type WindowRunLivenessStatus = 'preparing' | 'active' | 'at-risk' | 'stalled' | 'failed' | 'closed';
export type WindowRunLivenessPredicate =
  | 'executor-bound-running'
  | 'heartbeat-fresh'
  | 'delivery-reachable'
  | 'durable-work-advanced'
  | 'lifecycle-admitted-unexpired';

export interface WindowRunLivenessConfig {
  enabled?: boolean;
  /** Observe and persist verdicts, but never actuate recovery or notify. Default true. */
  dryRun?: boolean;
  heartbeatMaxAgeMs?: number;
  workEvidenceMaxAgeMs?: number;
  recoveryCeilingMs?: number;
}

export interface WindowRunWorkReceipt {
  receiptId: string;
  sequence: number;
  digest: string;
  observedAt: string;
  artifact: string;
  taskRef: string;
}

export interface WindowRunLivenessSample {
  sampledAt: string;
  executor: { id: string | null; running: boolean; heartbeatAt: string | null };
  deliveryReachable: boolean;
  work: WindowRunWorkReceipt | null;
  lifecycle: {
    lifecycleRunId: string | null;
    state: string | null;
    admitted: boolean;
    expiresAt: string | null;
  };
}

export interface WindowRunPredicateVerdict {
  ok: boolean;
  observed: string;
}

export interface WindowRunRecoveryAttempt {
  attemptId: string;
  number: 1;
  requestedAt: string;
  deadlineAt: string;
  missingPredicates: WindowRunLivenessPredicate[];
  outcome: 'pending' | 'would-attempt' | 'succeeded' | 'failed';
  completedAt?: string;
  resultDigest?: string;
  detail?: string;
  replacementExecutorId?: string;
  requestedTaskRef?: string;
  resumedTaskRef?: string;
}

export interface WindowRunExecutorBindingReceipt {
  receiptId: string;
  at: string;
  fromExecutorId: string;
  toExecutorId: string;
  recoveryAttemptId: string;
  projectionReceipt: string;
}

export interface WindowRunTransitionReceipt {
  receiptId: string;
  at: string;
  from: WindowRunLivenessStatus;
  to: WindowRunLivenessStatus;
  reason: string;
  predicateDigest: string;
  recoveryAttemptId?: string;
}

export interface WindowRunLivenessAuditEntry {
  sequence: number;
  kind: 'sample' | 'work-receipt';
  at: string;
  status: WindowRunLivenessStatus;
  predicates?: Record<WindowRunLivenessPredicate, WindowRunPredicateVerdict>;
  predicateDigest?: string;
  workReceipt?: WindowRunWorkReceipt;
  previousDigest: string | null;
  entryDigest: string;
}

export interface WindowRunLivenessExitProof {
  sampleCount: number;
  workReceiptCount: number;
  advancingThirtyMinuteIntervals: number;
  threeCadenceIntervalsPassed: boolean;
  inducedLossObserved: boolean;
  recoveryAttempts: number;
  recoveryTaskMatched: boolean;
  falseActiveSamples: number;
  auditHeadDigest: string | null;
}

export interface WindowRunLivenessDocument {
  version: 1;
  windowId: string;
  topicId: number;
  autonomousRunId: string;
  lifecycleRunId: string;
  executorId: string;
  status: WindowRunLivenessStatus;
  registeredAt: string;
  activatedAt?: string;
  lastEvaluatedAt?: string;
  atRiskSince?: string;
  lastWorkReceipt?: WindowRunWorkReceipt;
  predicates: Record<WindowRunLivenessPredicate, WindowRunPredicateVerdict>;
  recoveryAttempt?: WindowRunRecoveryAttempt;
  executorBindingReceipts: WindowRunExecutorBindingReceipt[];
  audit: {
    entries: WindowRunLivenessAuditEntry[];
    headDigest: string | null;
  };
  legacyProjection?: { status: WindowRunLivenessStatus; at: string; receipt: string };
  transitions: WindowRunTransitionReceipt[];
  finalSnapshot?: {
    frozenAt: string;
    reason: string;
    statusBeforeFreeze: WindowRunLivenessStatus;
    predicateDigest: string;
    exitProof: WindowRunLivenessExitProof;
  };
  notificationIntent?: {
    marker: string;
    createdAt: string;
    message: string;
  };
  notificationDeliveredAt?: string;
}

export interface WindowRunLivenessRegistration {
  windowId: string;
  topicId: number;
  autonomousRunId: string;
  lifecycleRunId: string;
  executorId: string;
}

export interface WindowRunWorkAdvanceRequest extends WindowRunLivenessRegistration {
  /** Relative artifact path. The production verifier resolves and hashes it. */
  artifactRef: string;
}

export interface WindowRunRecoveryResult {
  succeeded: boolean;
  detail: string;
  /** Stable attributable receipt from the recovery executor. */
  receipt: string;
  /** Authority-verified replacement binding; omitted means the binding survived. */
  replacementExecutorId?: string;
  /** Server-derived exact open task the replacement was instructed to resume. */
  resumedTaskRef?: string;
}

export interface WindowRunLivenessDeps {
  sample: (state: Readonly<WindowRunLivenessDocument>) => Promise<WindowRunLivenessSample> | WindowRunLivenessSample;
  recover?: (request: {
    attemptId: string;
    state: Readonly<WindowRunLivenessDocument>;
    missingPredicates: WindowRunLivenessPredicate[];
    taskRef: string;
  }) => Promise<WindowRunRecoveryResult>;
  verifyWorkArtifact?: (
    state: Readonly<WindowRunLivenessDocument>,
    request: Readonly<Pick<WindowRunWorkAdvanceRequest, 'artifactRef'> & { observedAt: string }>,
  ) => { artifact: string; digest: string; taskRef: string };
  /** Resolve the exact first open task with no durable receipt. */
  resolveRecoveryTask?: (state: Readonly<WindowRunLivenessDocument>) => string | null;
  /** Sole writer for compatibility run/local-file surfaces. */
  projectStatus?: (state: Readonly<WindowRunLivenessDocument>, status: WindowRunLivenessStatus) => string;
  /** Rebinds the server-owned run association before recovery verification. */
  rebindExecutor?: (state: Readonly<WindowRunLivenessDocument>, replacementExecutorId: string) => string;
  notifyFailure?: (state: Readonly<WindowRunLivenessDocument>, message: string) => Promise<boolean>;
  /** Requery the delivery authority for a previously persisted notification marker. */
  notificationAlreadyDelivered?: (state: Readonly<WindowRunLivenessDocument>, marker: string) => Promise<boolean> | boolean;
  now?: () => string;
}

const EMPTY_PREDICATES: Record<WindowRunLivenessPredicate, WindowRunPredicateVerdict> = {
  'executor-bound-running': { ok: false, observed: 'not-yet-sampled' },
  'heartbeat-fresh': { ok: false, observed: 'not-yet-sampled' },
  'delivery-reachable': { ok: false, observed: 'not-yet-sampled' },
  'durable-work-advanced': { ok: false, observed: 'not-yet-sampled' },
  'lifecycle-admitted-unexpired': { ok: false, observed: 'not-yet-sampled' },
};

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function validIso(value: string | null | undefined): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function positiveMs(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function isTerminal(status: WindowRunLivenessStatus): boolean {
  return status === 'stalled' || status === 'failed' || status === 'closed';
}

export class WindowRunLivenessStore {
  readonly file: string;
  private readonly mutationTarget: string;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, 'window-run-liveness', 'state.json');
    this.mutationTarget = path.join(stateDir, 'window-run-liveness', 'mutation-target');
  }

  load(): WindowRunLivenessDocument | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as WindowRunLivenessDocument;
      this.validate(parsed);
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  save(state: WindowRunLivenessDocument): void {
    this.validate(state);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(tmp, 'w', 0o600);
      try {
        fs.writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.file);
      if (isTerminal(state.status)) this.recordTerminalWindow(state.windowId, state.finalSnapshot?.frozenAt ?? state.lastEvaluatedAt ?? state.registeredAt);
    } finally {
      try { if (fs.existsSync(tmp)) SafeFsExecutor.safeUnlinkSync(tmp, { operation: 'window-run-liveness-atomic-save-cleanup' }); } catch { /* best-effort temp cleanup */ }
    }
  }

  hasTerminalWindow(windowId: string): boolean {
    return fs.existsSync(this.terminalWindowPath(windowId));
  }

  recordTerminalWindow(windowId: string, terminalAt: string): void {
    const file = this.terminalWindowPath(windowId);
    if (fs.existsSync(file)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, windowId, terminalAt })}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  private terminalWindowPath(windowId: string): string {
    return path.join(path.dirname(this.file), 'terminal-windows', `${digest(windowId)}.json`);
  }

  withMutation<T>(mutate: () => T): T {
    fs.mkdirSync(path.dirname(this.mutationTarget), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.mutationTarget)) fs.writeFileSync(this.mutationTarget, '', { mode: 0o600 });
    const release = lockfile.lockSync(this.mutationTarget, { realpath: false, stale: 120_000, update: 30_000 });
    try { return mutate(); } finally { release(); }
  }

  async withMutationAsync<T>(mutate: () => Promise<T>): Promise<T> {
    fs.mkdirSync(path.dirname(this.mutationTarget), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(this.mutationTarget)) fs.writeFileSync(this.mutationTarget, '', { mode: 0o600 });
    const release = await lockfile.lock(this.mutationTarget, { realpath: false, stale: 120_000, update: 30_000, retries: { retries: 100, factor: 1, minTimeout: 5, maxTimeout: 20 } });
    try { return await mutate(); } finally { await release(); }
  }

  private validate(state: WindowRunLivenessDocument): void {
    if (state?.version !== WINDOW_RUN_LIVENESS_VERSION) throw new Error('window-run-liveness-version-invalid');
    if (!state.windowId || !state.autonomousRunId || !state.lifecycleRunId || !state.executorId) throw new Error('window-run-liveness-binding-invalid');
    if (!Number.isSafeInteger(state.topicId) || state.topicId < 0) throw new Error('window-run-liveness-topic-invalid');
    if (!validIso(state.registeredAt) || (state.lastEvaluatedAt && !validIso(state.lastEvaluatedAt))) throw new Error('window-run-liveness-time-invalid');
    if (!Array.isArray(state.transitions) || !Array.isArray(state.executorBindingReceipts) || !Array.isArray(state.audit?.entries) || state.audit.entries.length > WINDOW_RUN_LIVENESS_MAX_AUDIT_ENTRIES || state.recoveryAttempt?.number !== undefined && state.recoveryAttempt.number !== 1) throw new Error('window-run-liveness-history-invalid');
    let prior: string | null = null;
    for (let index = 0; index < state.audit.entries.length; index++) {
      const entry = state.audit.entries[index];
      const { entryDigest, ...unsigned } = entry;
      if (entry.sequence !== index + 1 || entry.previousDigest !== prior || digest(unsigned) !== entryDigest) throw new Error('window-run-liveness-audit-chain-invalid');
      prior = entryDigest;
    }
    if (state.audit.headDigest !== prior) throw new Error('window-run-liveness-audit-head-invalid');
  }
}

export class WindowRunLivenessAuthority {
  private readonly cfg: Required<WindowRunLivenessConfig>;
  private ticking = false;

  constructor(
    private readonly store: WindowRunLivenessStore,
    private readonly deps: WindowRunLivenessDeps,
    config: WindowRunLivenessConfig = {},
  ) {
    this.cfg = {
      enabled: config.enabled === true,
      dryRun: config.dryRun !== false,
      heartbeatMaxAgeMs: positiveMs(config.heartbeatMaxAgeMs, WINDOW_RUN_LIVENESS_DEFAULTS.heartbeatMaxAgeMs),
      workEvidenceMaxAgeMs: positiveMs(config.workEvidenceMaxAgeMs, WINDOW_RUN_LIVENESS_DEFAULTS.workEvidenceMaxAgeMs),
      recoveryCeilingMs: Math.min(15 * 60_000, positiveMs(config.recoveryCeilingMs, WINDOW_RUN_LIVENESS_DEFAULTS.recoveryCeilingMs)),
    };
  }

  status(): { enabled: boolean; dryRun: boolean; config: Omit<Required<WindowRunLivenessConfig>, 'enabled' | 'dryRun'>; state: WindowRunLivenessDocument | null } {
    return {
      enabled: this.cfg.enabled,
      dryRun: this.cfg.dryRun,
      config: {
        heartbeatMaxAgeMs: this.cfg.heartbeatMaxAgeMs,
        workEvidenceMaxAgeMs: this.cfg.workEvidenceMaxAgeMs,
        recoveryCeilingMs: this.cfg.recoveryCeilingMs,
      },
      state: this.store.load(),
    };
  }

  register(input: WindowRunLivenessRegistration): WindowRunLivenessDocument {
    return this.store.withMutation(() => {
      if (!this.cfg.enabled) throw new Error('window-run-liveness-dark');
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(input.windowId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.autonomousRunId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.lifecycleRunId) || !/^[A-Za-z0-9._:-]{1,200}$/.test(input.executorId)) throw new Error('window-run-liveness-registration-invalid');
      if (!Number.isSafeInteger(input.topicId) || input.topicId < 0) throw new Error('window-run-liveness-topic-invalid');
      const existing = this.store.load();
      if (this.store.hasTerminalWindow(input.windowId)) throw new Error('window-run-liveness-terminal-binding-closed');
      if (existing && !isTerminal(existing.status)) {
        const same = existing.windowId === input.windowId && existing.autonomousRunId === input.autonomousRunId && existing.lifecycleRunId === input.lifecycleRunId && existing.executorId === input.executorId && existing.topicId === input.topicId;
        if (same) return existing;
        throw new Error('window-run-liveness-active-binding-exists');
      }
      if (existing && isTerminal(existing.status)) {
        this.store.recordTerminalWindow(existing.windowId, existing.finalSnapshot?.frozenAt ?? existing.lastEvaluatedAt ?? existing.registeredAt);
        if (existing.windowId === input.windowId) throw new Error('window-run-liveness-terminal-binding-closed');
      }
      const state: WindowRunLivenessDocument = {
        version: WINDOW_RUN_LIVENESS_VERSION,
        ...input,
        status: 'preparing',
        registeredAt: this.now(),
        predicates: structuredClone(EMPTY_PREDICATES),
        transitions: [],
        executorBindingReceipts: [],
        audit: { entries: [], headDigest: null },
      };
      this.project(state, 'preparing', state.registeredAt);
      this.store.save(state);
      return state;
    });
  }

  /**
   * Mint the only durable-work predicate source. The caller names an artifact;
   * the server selects the exact open task and supplies every authority fact.
   */
  async recordWorkAdvance(input: WindowRunWorkAdvanceRequest): Promise<WindowRunWorkReceipt> {
    return this.store.withMutationAsync(async () => {
      if (!this.cfg.enabled) throw new Error('window-run-liveness-dark');
      const state = this.store.load();
      if (!state || isTerminal(state.status)) throw new Error('window-run-liveness-not-active');
      const bindingMatches = state.windowId === input.windowId
        && state.topicId === input.topicId
        && state.autonomousRunId === input.autonomousRunId
        && state.lifecycleRunId === input.lifecycleRunId
        && state.executorId === input.executorId;
      if (!bindingMatches) throw new Error('window-run-liveness-binding-mismatch');
      if (typeof input.artifactRef !== 'string' || !input.artifactRef.trim()) throw new Error('window-run-liveness-work-reference-invalid');
      if (!this.deps.verifyWorkArtifact) throw new Error('window-run-liveness-artifact-verifier-unavailable');
      // One authority timestamp governs both admission and the receipt. Sampling
      // twice could authorize before the ceiling and stamp after it.
      const observedAt = this.now();
      const verified = this.deps.verifyWorkArtifact(structuredClone(state), { artifactRef: input.artifactRef, observedAt });
      if (!/^[a-f0-9]{64}$/.test(verified.digest) || !verified.artifact || !/^[A-Za-z0-9._:/-]{1,300}$/.test(verified.taskRef)) throw new Error('window-run-liveness-artifact-verification-invalid');
      if (state.lastWorkReceipt?.digest === verified.digest) throw new Error('window-run-liveness-artifact-unchanged');
      const sequence = (state.lastWorkReceipt?.sequence ?? 0) + 1;
      const receipt: WindowRunWorkReceipt = {
        receiptId: digest({ windowId: state.windowId, autonomousRunId: state.autonomousRunId, executorId: state.executorId, taskRef: verified.taskRef, artifact: verified.artifact, digest: verified.digest, sequence, observedAt }),
        sequence, digest: verified.digest, observedAt, artifact: verified.artifact, taskRef: verified.taskRef,
      };
      state.lastWorkReceipt = receipt;
      this.appendAudit(state, {
        kind: 'work-receipt', at: observedAt, status: state.status, workReceipt: structuredClone(receipt),
      });
      this.store.save(state);
      return receipt;
    });
  }

  async tick(): Promise<WindowRunLivenessDocument | null> {
    if (!this.cfg.enabled || this.ticking) return this.store.load();
    this.ticking = true;
    try {
      return await this.store.withMutationAsync(async () => {
        const state = this.store.load();
        if (!state) return state;
        if (isTerminal(state.status)) {
          if (state.status === 'failed' || state.status === 'stalled') {
            const reason = state.finalSnapshot?.reason ?? state.transitions.at(-1)?.reason ?? state.status;
            await this.notifyOnce(state, `Window ${state.windowId} ${state.status}: ${reason}. Active has been revoked.`);
          }
          return state;
        }
        return await this.evaluateAndMaybeRecover(state);
      });
    } finally {
      this.ticking = false;
    }
  }

  freeze(reason: string, terminalStatus: 'closed' | 'failed' = 'closed'): WindowRunLivenessDocument {
    return this.store.withMutation(() => {
      const state = this.store.load();
      if (!state) throw new Error('window-run-liveness-not-registered');
      if (state.finalSnapshot) return state;
      const now = this.now();
      const prior = state.status;
      state.status = terminalStatus;
      state.finalSnapshot = { frozenAt: now, reason: reason.slice(0, 500), statusBeforeFreeze: prior, predicateDigest: digest(state.predicates), exitProof: this.exitProof(state) };
      this.transition(state, prior, terminalStatus, `freeze:${reason.slice(0, 200)}`, now);
      this.project(state, terminalStatus, now);
      this.store.save(state);
      return state;
    });
  }

  private async evaluateAndMaybeRecover(state: WindowRunLivenessDocument): Promise<WindowRunLivenessDocument> {
    const now = this.now();
    let sample = await this.deps.sample(structuredClone(state));
    let missing = this.applySample(state, sample, now);
    if (this.isExpired(sample, now)) return await this.fail(state, 'window-expired', now);

    if (missing.length === 0) {
      if (state.status === 'preparing' || state.status === 'at-risk' && state.recoveryAttempt?.outcome === 'succeeded') {
        const prior = state.status;
        state.status = 'active';
        state.activatedAt ??= now;
        state.atRiskSince = undefined;
        this.transition(state, prior, 'active', prior === 'at-risk' ? 'recovery-verified' : 'all-five-predicates-green', now, state.recoveryAttempt?.attemptId);
      }
      this.recordSample(state, now);
      // Active is authoritative first. A crash/throw can leave only a safe
      // false-negative compatibility surface; the next tick retries projection.
      this.store.save(state);
      if (state.status === 'active' && state.legacyProjection?.status !== 'active') {
        this.project(state, 'active', now);
        this.store.save(state);
      }
      return state;
    }

    // The separate preparation carrier owns work before lifecycle admission.
    // Registration is never green, but absence of admission also never burns the
    // run's sole recovery attempt before substantive execution is allowed.
    if (state.status === 'preparing' && missing.includes('lifecycle-admitted-unexpired')) {
      this.recordSample(state, now);
      this.store.save(state);
      return state;
    }

    if (state.status === 'active' || state.status === 'preparing') {
      const prior = state.status;
      state.status = 'at-risk';
      state.atRiskSince = now;
      this.transition(state, prior, 'at-risk', `predicate-missing:${missing.join(',')}`, now);
      // Revocation is projected before the durable authority transition. A
      // crash can only create a safe false-negative, never legacy false-green.
      this.project(state, 'at-risk', now);
    }

    if (state.recoveryAttempt) {
      if (Date.parse(now) >= Date.parse(state.recoveryAttempt.deadlineAt)) return await this.fail(state, 'recovery-ceiling-exceeded', now);
      this.recordSample(state, now);
      this.store.save(state);
      return state;
    }

    const attempt: WindowRunRecoveryAttempt = {
      attemptId: randomUUID(),
      number: 1,
      requestedAt: now,
      deadlineAt: new Date(Date.parse(now) + this.cfg.recoveryCeilingMs).toISOString(),
      missingPredicates: missing,
      outcome: this.cfg.dryRun ? 'would-attempt' : 'pending',
    };
    state.recoveryAttempt = attempt;
    this.recordSample(state, now);
    // Persist before actuation: a crash/restart cannot cause attempt two.
    this.store.save(state);
    if (this.cfg.dryRun || !this.deps.recover) return state;

    const recoveryTask = this.deps.resolveRecoveryTask?.(structuredClone(state)) ?? null;
    if (!recoveryTask || !/^[A-Za-z0-9._:/-]{1,300}$/.test(recoveryTask)) {
      attempt.outcome = 'failed';
      attempt.completedAt = this.now();
      attempt.detail = 'first-unreceipted-task-unresolvable';
      attempt.resultDigest = digest({ attemptId: attempt.attemptId, detail: attempt.detail });
      this.store.save(state);
      return await this.stall(state, 'bounded-recovery-task-unresolvable', attempt.completedAt);
    }
    attempt.requestedTaskRef = recoveryTask;
    this.store.save(state);

    let result: WindowRunRecoveryResult;
    try {
      result = await this.deps.recover({ attemptId: attempt.attemptId, state: structuredClone(state), missingPredicates: missing, taskRef: recoveryTask });
    } catch (error) {
      result = { succeeded: false, detail: error instanceof Error ? error.message : String(error), receipt: digest(String(error)) };
    }
    attempt.completedAt = this.now();
    attempt.outcome = result.succeeded ? 'succeeded' : 'failed';
    attempt.detail = result.detail.slice(0, 500);
    attempt.resumedTaskRef = result.resumedTaskRef;
    if (result.succeeded && result.resumedTaskRef !== recoveryTask) {
      result = { ...result, succeeded: false, detail: 'recovery-task-attribution-mismatch' };
      attempt.outcome = 'failed';
      attempt.detail = result.detail;
    }
    if (result.succeeded && result.replacementExecutorId && result.replacementExecutorId !== state.executorId) {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(result.replacementExecutorId) || !this.deps.rebindExecutor) {
        result = { succeeded: false, detail: 'replacement-executor-unverifiable', receipt: result.receipt };
        attempt.outcome = 'failed';
        attempt.detail = result.detail;
      } else {
        try {
          const priorExecutor = state.executorId;
          const projectionReceipt = this.deps.rebindExecutor(structuredClone(state), result.replacementExecutorId);
          if (!projectionReceipt) throw new Error('replacement-projection-receipt-missing');
          state.executorId = result.replacementExecutorId;
          attempt.replacementExecutorId = result.replacementExecutorId;
          const at = this.now();
          state.executorBindingReceipts.push({
            receiptId: digest({ windowId: state.windowId, autonomousRunId: state.autonomousRunId, priorExecutor, replacementExecutorId: result.replacementExecutorId, attemptId: attempt.attemptId, projectionReceipt, at }),
            at,
            fromExecutorId: priorExecutor,
            toExecutorId: result.replacementExecutorId,
            recoveryAttemptId: attempt.attemptId,
            projectionReceipt,
          });
        } catch (error) {
          // @silent-fallback-ok — the failed rebind is persisted below and forces a loud terminal stall.
          result = { succeeded: false, detail: `replacement-executor-rebind-failed:${error instanceof Error ? error.message : String(error)}`, receipt: result.receipt };
          attempt.outcome = 'failed';
          attempt.detail = result.detail.slice(0, 500);
        }
      }
    }
    attempt.resultDigest = digest({ attemptId: attempt.attemptId, receipt: result.receipt, succeeded: result.succeeded, detail: result.detail, replacementExecutorId: result.replacementExecutorId, requestedTaskRef: recoveryTask, resumedTaskRef: result.resumedTaskRef });
    this.store.save(state);
    if (!result.succeeded) return await this.stall(state, 'bounded-recovery-failed', attempt.completedAt);

    sample = await this.deps.sample(structuredClone(state));
    const resampledAt = this.now();
    missing = this.applySample(state, sample, resampledAt);
    if (missing.length === 0) {
      const at = resampledAt;
      state.status = 'active';
      state.atRiskSince = undefined;
      state.activatedAt ??= at;
      this.transition(state, 'at-risk', 'active', 'recovery-verified', at, attempt.attemptId);
      this.recordSample(state, at);
      // Persist green evidence and transition before exposing active outward.
      this.store.save(state);
      this.project(state, 'active', at);
    } else {
      this.recordSample(state, resampledAt);
    }
    this.store.save(state);
    return state;
  }

  private applySample(state: WindowRunLivenessDocument, sample: WindowRunLivenessSample, now: string): WindowRunLivenessPredicate[] {
    const nowMs = Date.parse(now);
    const heartbeatMs = Date.parse(sample.executor.heartbeatAt ?? '');
    const workMs = Date.parse(sample.work?.observedAt ?? '');
    const expiresMs = Date.parse(sample.lifecycle.expiresAt ?? '');
    const executorOk = sample.executor.id === state.executorId && sample.executor.running;
    const heartbeatOk = executorOk && Number.isFinite(heartbeatMs) && heartbeatMs <= nowMs && nowMs - heartbeatMs <= this.cfg.heartbeatMaxAgeMs;
    const deliveryOk = sample.deliveryReachable === true;
    const workMonotone = !!sample.work && (!state.lastWorkReceipt || sample.work.sequence >= state.lastWorkReceipt.sequence && (sample.work.sequence > state.lastWorkReceipt.sequence || sample.work.digest === state.lastWorkReceipt.digest));
    const workOk = workMonotone && Number.isFinite(workMs) && workMs <= nowMs && nowMs - workMs <= this.cfg.workEvidenceMaxAgeMs;
    const lifecycleOk = sample.lifecycle.lifecycleRunId === state.lifecycleRunId && sample.lifecycle.admitted === true && !['idle', 'pre_start_gate', 'start_blocked', 'rolled_back', 'closed_clean', 'closed_with_operator_waiver', 'closed_failed'].includes(sample.lifecycle.state ?? '') && Number.isFinite(expiresMs) && nowMs < expiresMs;
    state.predicates = {
      'executor-bound-running': { ok: executorOk, observed: sample.executor.id ? `${sample.executor.id}:${sample.executor.running ? 'running' : 'not-running'}` : 'executor-unbound' },
      'heartbeat-fresh': { ok: heartbeatOk, observed: sample.executor.heartbeatAt ?? 'heartbeat-missing' },
      'delivery-reachable': { ok: deliveryOk, observed: deliveryOk ? 'reachable' : 'unreachable' },
      'durable-work-advanced': { ok: workOk, observed: sample.work ? `${sample.work.receiptId}:${sample.work.sequence}:${sample.work.observedAt}` : 'receipt-missing' },
      'lifecycle-admitted-unexpired': { ok: lifecycleOk, observed: `${sample.lifecycle.lifecycleRunId ?? 'unbound'}:${sample.lifecycle.state ?? 'unknown'}:${sample.lifecycle.expiresAt ?? 'expiry-missing'}` },
    };
    if (workOk && sample.work && (!state.lastWorkReceipt || sample.work.sequence > state.lastWorkReceipt.sequence)) state.lastWorkReceipt = structuredClone(sample.work);
    state.lastEvaluatedAt = now;
    return (Object.entries(state.predicates) as Array<[WindowRunLivenessPredicate, WindowRunPredicateVerdict]>).filter(([, verdict]) => !verdict.ok).map(([name]) => name);
  }

  private isExpired(sample: WindowRunLivenessSample, now: string): boolean {
    return validIso(sample.lifecycle.expiresAt) && Date.parse(now) >= Date.parse(sample.lifecycle.expiresAt);
  }

  private async stall(state: WindowRunLivenessDocument, reason: string, at: string): Promise<WindowRunLivenessDocument> {
    const prior = state.status;
    state.status = 'stalled';
    this.transition(state, prior, 'stalled', reason, at, state.recoveryAttempt?.attemptId);
    this.project(state, 'stalled', at);
    this.store.save(state);
    await this.notifyOnce(state, `Window ${state.windowId} stalled after its single bounded recovery failed. Active has been revoked. Recovery attempt: ${state.recoveryAttempt?.attemptId ?? 'missing'}.`);
    return state;
  }

  private async fail(state: WindowRunLivenessDocument, reason: string, at: string): Promise<WindowRunLivenessDocument> {
    const prior = state.status;
    state.status = 'failed';
    this.transition(state, prior, 'failed', reason, at, state.recoveryAttempt?.attemptId);
    this.project(state, 'failed', at);
    this.recordSample(state, at);
    state.finalSnapshot ??= { frozenAt: at, reason, statusBeforeFreeze: prior, predicateDigest: digest(state.predicates), exitProof: this.exitProof(state) };
    this.store.save(state);
    await this.notifyOnce(state, `Window ${state.windowId} failed: ${reason}. Active has been revoked.`);
    return state;
  }

  private async notifyOnce(state: WindowRunLivenessDocument, message: string): Promise<void> {
    if (this.cfg.dryRun || state.notificationDeliveredAt || !this.deps.notifyFailure) return;
    if (!state.notificationIntent) {
      const marker = `window-run-liveness-notice:${digest({ windowId: state.windowId, autonomousRunId: state.autonomousRunId, lifecycleRunId: state.lifecycleRunId, status: state.status, finalSnapshot: state.finalSnapshot }).slice(0, 24)}`;
      state.notificationIntent = { marker, createdAt: this.now(), message: `${message}\n[${marker}]` };
      this.store.save(state);
    }
    let alreadyDelivered = false;
    try {
      alreadyDelivered = await this.deps.notificationAlreadyDelivered?.(structuredClone(state), state.notificationIntent.marker) === true;
    } catch { /* @silent-fallback-ok — authority requery failure preserves at-least-once delivery by retrying */ }
    if (alreadyDelivered || await this.deps.notifyFailure(structuredClone(state), state.notificationIntent.message)) {
      state.notificationDeliveredAt = this.now();
      this.store.save(state);
    }
  }

  private transition(state: WindowRunLivenessDocument, from: WindowRunLivenessStatus, to: WindowRunLivenessStatus, reason: string, at: string, recoveryAttemptId?: string): void {
    const predicateDigest = digest(state.predicates);
    const receiptId = digest({ windowId: state.windowId, autonomousRunId: state.autonomousRunId, at, from, to, reason, predicateDigest, recoveryAttemptId });
    if (state.transitions.some(receipt => receipt.receiptId === receiptId)) return;
    state.transitions.push({ receiptId, at, from, to, reason, predicateDigest, ...(recoveryAttemptId ? { recoveryAttemptId } : {}) });
  }

  private project(state: WindowRunLivenessDocument, status: WindowRunLivenessStatus, at: string): void {
    if (this.cfg.dryRun || !this.deps.projectStatus) return;
    const receipt = this.deps.projectStatus(structuredClone(state), status);
    if (!receipt) throw new Error('window-run-liveness-projection-receipt-missing');
    state.legacyProjection = { status, at, receipt };
  }

  private recordSample(state: WindowRunLivenessDocument, at: string): void {
    this.appendAudit(state, {
      kind: 'sample', at, status: state.status,
      predicates: structuredClone(state.predicates), predicateDigest: digest(state.predicates),
    });
  }

  private appendAudit(state: WindowRunLivenessDocument, entry: Omit<WindowRunLivenessAuditEntry, 'sequence' | 'previousDigest' | 'entryDigest'>): void {
    if (state.audit.entries.length >= WINDOW_RUN_LIVENESS_MAX_AUDIT_ENTRIES) throw new Error('window-run-liveness-audit-capacity-exceeded');
    const unsigned = {
      sequence: state.audit.entries.length + 1,
      ...entry,
      previousDigest: state.audit.headDigest,
    };
    const complete: WindowRunLivenessAuditEntry = { ...unsigned, entryDigest: digest(unsigned) };
    state.audit.entries.push(complete);
    state.audit.headDigest = complete.entryDigest;
  }

  private exitProof(state: WindowRunLivenessDocument): WindowRunLivenessExitProof {
    const samples = state.audit.entries.filter(entry => entry.kind === 'sample');
    const receipts = state.audit.entries
      .filter((entry): entry is WindowRunLivenessAuditEntry & { workReceipt: WindowRunWorkReceipt } => entry.kind === 'work-receipt' && !!entry.workReceipt)
      .map(entry => entry.workReceipt);
    let currentCadenceStreak = 0;
    let advancingThirtyMinuteIntervals = 0;
    for (let index = 1; index < receipts.length; index++) {
      const prior = receipts[index - 1];
      const current = receipts[index];
      if (current.sequence > prior.sequence && current.digest !== prior.digest && Date.parse(current.observedAt) - Date.parse(prior.observedAt) >= 30 * 60_000) {
        currentCadenceStreak++;
        advancingThirtyMinuteIntervals = Math.max(advancingThirtyMinuteIntervals, currentCadenceStreak);
      } else {
        currentCadenceStreak = 0;
      }
    }
    const falseActiveSamples = samples.filter(entry => entry.status === 'active' && Object.values(entry.predicates ?? {}).some(verdict => !verdict.ok)).length;
    return {
      sampleCount: samples.length,
      workReceiptCount: receipts.length,
      advancingThirtyMinuteIntervals,
      threeCadenceIntervalsPassed: advancingThirtyMinuteIntervals >= 3,
      inducedLossObserved: state.transitions.some(entry => entry.from === 'active' && entry.to === 'at-risk' && entry.reason.startsWith('predicate-missing:')),
      recoveryAttempts: state.recoveryAttempt ? 1 : 0,
      recoveryTaskMatched: !!state.recoveryAttempt?.requestedTaskRef && state.recoveryAttempt.requestedTaskRef === state.recoveryAttempt.resumedTaskRef,
      falseActiveSamples,
      auditHeadDigest: state.audit.headDigest,
    };
  }

  private now(): string {
    const now = this.deps.now?.() ?? new Date().toISOString();
    if (!validIso(now)) throw new Error('window-run-liveness-clock-invalid');
    return now;
  }
}
