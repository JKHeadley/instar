import { Worker } from 'node:worker_threads';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { DegradationReporter } from '../../monitoring/DegradationReporter.js';
import { originDetectorCanaryInterval } from './OriginConfig.js';
import type { OriginCanaryHealth } from './OriginDetectorHealth.js';

const CHECKS = ['encrypted-config-read', 'exact-hub-permission', 'opt-out-observed', 'hub-rebind-refused', 'credential-rotation-refused', 'malformed-source-refused'];
type CleanupStage = 'awaiting-ack' | 'awaiting-exit' | 'terminating-worker' | 'removing-fixture';
type CleanupFault = 'deadline-timer' | 'late-ack' | 'negative-ack' | 'worker-error' | 'worker-exit-without-ack' | 'worker-exit-nonzero' | 'operation-error' | 'deadline-after-cleanup';
/** @self-action-controller: telegram-origin-owned-detector-canary
 * Fixed-cost diagnostic sentinel: a 60s startup floor, then a completion-relative
 * interval; two attempts maximum, one worker at a time, no transport capability.
 * RULE 3.1 RATIONALE: owned stable authority schemas, hourly known-state probe;
 * failures report health, never manufacture credentials or delivery permission.
 */
export class OriginDetectorCanary {
  private readonly intervalMs: number;
  private closed = false;
  private cleanupFailed = false;
  private failurePhase = 'unknown';
  private pending: Promise<void> | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private cancel?: () => void;
  private health: OriginCanaryHealth;
  constructor(private readonly options: { intervalMs?: number; workerUrl?: URL; configWorkerUrl?: URL; timeoutMs?: number; cleanupTimeoutMs?: number;
    /** Test-only clock seam. Production uses actual monotonic schedule timers. */ now?: () => number } = {}) {
    this.intervalMs = originDetectorCanaryInterval({ detectorCanary: { intervalMs: options.intervalMs } });
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 6_000)) throw new Error('invalid-canary-timeout');
    if (options.cleanupTimeoutMs !== undefined && (!Number.isSafeInteger(options.cleanupTimeoutMs) || options.cleanupTimeoutMs < 1 || options.cleanupTimeoutMs > 30_000)) throw new Error('invalid-canary-cleanup-timeout');
    this.health = { scope: 'owned-file-backed-secretstore-fixture', osKeychainVerified: false, state: 'pending', reason: 'canary-not-run', attemptedAt: null, finishedAt: null, validUntil: null, attempts: 0, intervalMs: this.intervalMs, checks: [] };
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  getHealth(): OriginCanaryHealth {
    const value = structuredClone(this.health), now = this.now();
    if (this.closed) return { ...value, state: 'closed', reason: 'canary-closed' };
    if (value.state === 'pass' && (value.finishedAt! > now || value.validUntil! <= now)) return { ...value, state: 'stale', reason: 'canary-result-stale' };
    return value;
  }
  start(): void {
    if (this.closed || this.cleanupFailed || this.timer || this.pending) return;
    const cycle = async () => {
      await this.run();
      if (!this.closed && !this.cleanupFailed) { this.timer = setTimeout(() => { this.timer = undefined; void cycle(); }, this.intervalMs); this.timer.unref(); }
    };
    // Every new instance waits before its first automatic probe. A restart
    // therefore cannot turn the startup probe into an unbounded retry loop.
    this.timer = setTimeout(() => { this.timer = undefined; void cycle(); }, 60_000);
    this.timer.unref();
  }
  run(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.closed || this.cleanupFailed) return Promise.resolve();
    this.pending = this.perform().finally(() => { this.pending = null; });
    return this.pending;
  }
  private async perform(): Promise<void> {
    this.health = { ...this.health, state: 'running', reason: 'canary-running', attemptedAt: this.now(), finishedAt: null, validUntil: null, attempts: 0, checks: [] };
    let passed = false;
    for (let attempt = 1; attempt <= 2 && !this.closed && !this.cleanupFailed; attempt++) {
      this.health.attempts = attempt;
      try { passed = await this.attempt(); } catch { passed = false; }
      if (passed) break;
    }
    if (this.closed) return;
    const finishedAt = this.now();
    this.health = { ...this.health, state: passed ? 'pass' : 'fail', reason: this.cleanupFailed ? 'canary-cleanup-unverified' : passed ? 'owned-file-key-contracts-verified' : 'owned-contract-canary-failed',
      finishedAt, validUntil: finishedAt + this.intervalMs, checks: passed ? [...CHECKS] : [] };
    if (!passed) DegradationReporter.getInstance().report({ feature: 'telegram-origin.detector-canary', primary: 'Verify owned origin source contracts',
      fallback: 'Retain unavailable detector health; existing source authority remains unchanged', reason: `Bounded isolated canary failed after ${this.health.attempts} attempt(s) (${this.failurePhase})`, impact: 'Detector contract verification is unavailable; no source values or delivery permissions were inferred.' });
  }
  private async attempt(): Promise<boolean> {
    let directory: string | undefined;
    let worker: Worker | undefined;
    let passed = false;
    let expired = false;
    let protocolFailed = false;
    let cleanupAcknowledged = false;
    let cleanupDeadline: number | undefined;
    let cleanupStage: CleanupStage = 'awaiting-ack';
    let firstCleanupFault: string | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    let finishActive: ((passed: boolean) => void) | undefined;
    const contractDeadline = performance.now() + (this.options.timeoutMs ?? 6_000);
    const failCleanup = (fault: CleanupFault) => {
      // Preserve the first failure: forced termination and the final deadline
      // check can follow an earlier fault. Only fixed labels enter diagnostics.
      firstCleanupFault ??= `cleanup:${fault}:${cleanupStage}`;
      this.cleanupFailed = true; this.failurePhase = firstCleanupFault;
      this.health = { ...this.health, state: 'fail', reason: 'canary-cleanup-unverified', finishedAt: this.now(), validUntil: null };
      finishActive?.(false);
    };
    const beginCleanup = () => {
      clearTimeout(timeout);
      if (cleanupDeadline !== undefined) return;
      cleanupDeadline = performance.now() + (this.options.cleanupTimeoutMs ?? 30_000);
      cleanupTimer = setTimeout(() => failCleanup('deadline-timer'), this.options.cleanupTimeoutMs ?? 30_000);
    };
    const cancel = () => { expired = true; beginCleanup(); finishActive?.(false); };
    this.cancel = cancel;
    const timeout = setTimeout(() => {
      this.failurePhase = 'contract-timeout';
      cancel(); this.health = { ...this.health, state: 'fail', reason: 'canary-timeout', finishedAt: this.now(), validUntil: null };
    }, this.options.timeoutMs ?? 6_000);
    try {
      directory = await mkdtemp(path.join(os.tmpdir(), 'instar-origin-detector-canary-'));
      if (this.closed || expired) return false;
      // Only this disposable worker uses the existing file-key test isolation.
      // It and its nested resolver never access the operator OS keychain.
      worker = new Worker(this.options.workerUrl ?? new URL('./OriginDetectorCanary.worker.js', import.meta.url), {
        workerData: { directory, configWorkerUrl: String(this.options.configWorkerUrl ?? new URL('./OriginConfigReader.worker.js', import.meta.url)) },
        env: { NODE_ENV: 'test', ...(process.env.PATH ? { PATH: process.env.PATH } : {}) }, execArgv: [], stdout: true, stderr: true,
        resourceLimits: { maxOldGenerationSizeMb: 192 } });
      worker.stdout?.resume(); worker.stderr?.resume();
      passed = await new Promise<boolean>(resolve => {
        let done = false;
        let checksReceived = false;
        let checksPassed = false;
        const finish = (passed: boolean) => { if (done) return; done = true; resolve(passed); };
        const invalidProtocol = () => { protocolFailed = true; this.failurePhase = 'worker-protocol'; finish(false); };
        finishActive = finish;
        worker!.on('message', message => {
          if (done) { protocolFailed = true; return; }
          if (message?.type === 'checks') {
            if (checksReceived || typeof message.passed !== 'boolean') { invalidProtocol(); return; }
            if (expired || performance.now() >= contractDeadline) {
              this.failurePhase = 'contract-timeout'; cancel(); return;
            }
            checksReceived = true;
            checksPassed = message.passed === true && Array.isArray(message.checks) && message.checks.length === CHECKS.length && CHECKS.every((check, index) => message.checks[index] === check);
            this.failurePhase = ['fixture-initialization', ...CHECKS].includes(message.phase) ? message.phase : 'worker-result';
            beginCleanup();
            this.health = { ...this.health, state: 'running', reason: 'canary-cleanup-running', finishedAt: null, validUntil: null };
          } else if (message?.type === 'cleanup') {
            if (!checksReceived || cleanupAcknowledged || typeof message.verified !== 'boolean') { invalidProtocol(); return; }
            if (!message.verified) { failCleanup('negative-ack'); return; }
            if (cleanupDeadline === undefined || performance.now() >= cleanupDeadline) { failCleanup('late-ack'); return; }
            cleanupAcknowledged = true;
            cleanupStage = 'awaiting-exit';
            // Drain the worker's full protocol through its normal exit before
            // accepting proof. A duplicate queued after the acknowledgement
            // must not disappear in an immediate forced termination.
          } else invalidProtocol();
        });
        const workerEnded = (code: number, errored = false) => {
          if (done) return;
          if (checksReceived && (!cleanupAcknowledged || code !== 0)) {
            failCleanup(errored ? 'worker-error' : !cleanupAcknowledged ? 'worker-exit-without-ack' : 'worker-exit-nonzero'); return;
          }
          finish(checksPassed && cleanupAcknowledged && code === 0);
        };
        worker!.once('error', () => { protocolFailed = true; workerEnded(1, true); });
        worker!.once('exit', workerEnded);
      });
    } finally {
      // Never release the single-flight slot before descendants terminate and
      // the exact private fixture directory has been removed. Expiry latches
      // unavailable health but cannot prove that an OS resource has closed.
      beginCleanup();
      try {
        if (worker) { cleanupStage = 'terminating-worker'; await worker.terminate(); }
        if (directory) { cleanupStage = 'removing-fixture'; await SafeFsExecutor.safeRm(directory, { recursive: true, force: true, operation: 'origin-detector-canary-private-fixture-cleanup' }); }
        if (cleanupDeadline !== undefined && performance.now() >= cleanupDeadline) failCleanup('deadline-after-cleanup');
      } catch { failCleanup('operation-error'); throw new Error('canary-cleanup-unverified'); }
      finally { clearTimeout(timeout); if (cleanupTimer) clearTimeout(cleanupTimer); if (this.cancel === cancel) this.cancel = undefined; }
    }
    return passed && cleanupAcknowledged && !protocolFailed && !expired && !this.cleanupFailed && !this.closed;
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.cancel?.();
    await this.pending;
  }
}
