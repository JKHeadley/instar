import { Worker } from 'node:worker_threads';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import { DegradationReporter } from '../../monitoring/DegradationReporter.js';
import { originDetectorCanaryInterval } from './OriginConfig.js';
import type { OriginCanaryHealth } from './OriginDetectorHealth.js';

const CHECKS = ['encrypted-config-read', 'exact-hub-permission', 'opt-out-observed', 'hub-rebind-refused', 'credential-rotation-refused', 'malformed-source-refused'];
/** @self-action-controller: telegram-origin-owned-detector-canary
 * Fixed-cost diagnostic sentinel: one run at boot, then a completion-relative
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
  constructor(private readonly options: { intervalMs?: number; workerUrl?: URL; configWorkerUrl?: URL; timeoutMs?: number;
    /** Test-only clock seam. Production uses actual monotonic schedule timers. */ now?: () => number } = {}) {
    this.intervalMs = originDetectorCanaryInterval({ detectorCanary: { intervalMs: options.intervalMs } });
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 6_000)) throw new Error('invalid-canary-timeout');
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
    if (this.closed || this.timer || this.pending) return;
    const cycle = async () => {
      await this.run();
      if (!this.closed) { this.timer = setTimeout(() => { this.timer = undefined; void cycle(); }, this.intervalMs); this.timer.unref(); }
    };
    void cycle();
  }
  run(): Promise<void> {
    if (this.closed || this.cleanupFailed) return Promise.resolve();
    if (this.pending) return this.pending;
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
      fallback: 'Retain unavailable detector health; existing source authority remains unchanged', reason: `Bounded isolated canary and one fresh retry failed (${this.failurePhase})`, impact: 'Detector contract verification is unavailable; no source values or delivery permissions were inferred.' });
  }
  private async attempt(): Promise<boolean> {
    let directory: string | undefined;
    let worker: Worker | undefined;
    let passed = false;
    let expired = false;
    let finishActive: ((passed: boolean) => void) | undefined;
    const cancel = () => { expired = true; finishActive?.(false); };
    this.cancel = cancel;
    const timeout = setTimeout(() => {
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
        const finish = (passed: boolean) => { if (done) return; done = true; resolve(passed); };
        finishActive = finish;
        worker!.once('message', message => {
          this.failurePhase = ['fixture-initialization', ...CHECKS].includes(message?.phase) ? message.phase : 'worker-result';
          finish(message?.passed === true && Array.isArray(message.checks) && message.checks.length === CHECKS.length && CHECKS.every((check, index) => message.checks[index] === check));
        });
        worker!.once('error', () => finish(false)); worker!.once('exit', () => finish(false));
      });
    } finally {
      // Never release the single-flight slot before descendants terminate and
      // the exact private fixture directory has been removed.
      try {
        if (worker) await worker.terminate();
        if (directory) await SafeFsExecutor.safeRm(directory, { recursive: true, force: true, operation: 'origin-detector-canary-private-fixture-cleanup' });
      } catch { this.cleanupFailed = true; throw new Error('canary-cleanup-unverified'); }
      finally { clearTimeout(timeout); if (this.cancel === cancel) this.cancel = undefined; }
    }
    return passed && !expired && !this.closed;
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.cancel?.();
    await this.pending;
  }
}
