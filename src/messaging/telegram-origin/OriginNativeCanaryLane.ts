import { originDetectorCanaryInterval } from './OriginConfig.js';
/** Native diagnostic lane. An adapter must own cancellation and cleanup; its
 * result never becomes message model evidence, hook proof or send authority. */
export interface OriginNativeCanaryResult {
  scope?: 'native-cli-format-with-loopback-provider';
  providerExecutionVerified?: false;
  harness?: 'codex-cli';
  cliVersion?: string | null;
  cliDigest?: string | null;
  parserDigest?: string | null;
  state: 'passed' | 'failed' | 'unavailable';
  cleanupVerified: boolean;
}
export type OriginNativeCanary = (input: { signal: AbortSignal; timeoutMs: number }) => Promise<OriginNativeCanaryResult>;
/** @self-action-controller: telegram-origin-native-model-canary
 * Automatic diagnostic cycles recur after completion. Every reconstructed
 * instance must first wait 60s, so repeated boots cannot accelerate the probes. */
export class OriginNativeCanaryLane {
  private pending: Promise<void> | null = null;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private cleanupFailed = false;
  private metadata: Record<string, string | null> = {};
  private result: { state: string; reason: string; sampledAt: number | null; validUntil: number | null; cleanupVerified: boolean } = {
    state: 'unavailable', reason: 'native-model-canary-not-enrolled', sampledAt: null, validUntil: null, cleanupVerified: false };
  constructor(private readonly intervalMs: number, private readonly runAdapter?: OriginNativeCanary) {
    originDetectorCanaryInterval({ detectorCanary: { intervalMs } });
  }
  getHealth() {
    const value = { ...this.result, ...this.metadata, harness: 'codex-cli', unsupportedHarnesses: ['claude-code', 'gemini-cli', 'pi-cli', 'grok-build'],
      scope: 'native-cli-format-with-loopback-provider' as const, providerExecutionVerified: false as const }, now = Date.now();
    if (this.closed) return { ...value, state: 'unavailable', reason: 'native-canary-closed' };
    if (value.state === 'passed' && (value.sampledAt! > now || value.validUntil! <= now)) return { ...value, state: 'unavailable', reason: 'native-canary-stale' };
    return value;
  }
  start(): void {
    if (this.closed || this.pending || this.timer || !this.runAdapter) return;
    const cycle = async () => {
      await this.run();
      if (!this.closed) { this.timer = setTimeout(() => { this.timer = undefined; void cycle(); }, this.intervalMs); this.timer.unref(); }
    };
    this.result = { ...this.result, reason: 'native-canary-startup-cooldown' };
    this.timer = setTimeout(() => { this.timer = undefined; void cycle(); }, 60_000);
    this.timer.unref();
  }
  run(): Promise<void> {
    if (this.closed || this.cleanupFailed || !this.runAdapter) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.perform().finally(() => { this.pending = null; }); return this.pending;
  }
  private async perform(): Promise<void> {
    const controller = this.controller = new AbortController();
    this.metadata = {};
    this.result = { state: 'unavailable', reason: 'native-canary-running', sampledAt: null, validUntil: null, cleanupVerified: false };
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true; controller.abort();
      this.result = { state: 'failed', reason: 'native-canary-timeout', sampledAt: Date.now(), validUntil: null, cleanupVerified: false };
    }, 30_000);
    try {
      const result = await this.runAdapter!({ signal: controller.signal, timeoutMs: 30_000 });
      if (!result.cleanupVerified) this.cleanupFailed = true;
      if (this.closed) return;
      const scopeValid = result.scope === 'native-cli-format-with-loopback-provider' && result.providerExecutionVerified === false && result.harness === 'codex-cli';
      const state = timedOut || !result.cleanupVerified || !['passed', 'failed', 'unavailable'].includes(result.state) || (result.state === 'passed' && !scopeValid) ? 'failed' : result.state;
      if (scopeValid) this.metadata = { cliVersion: typeof result.cliVersion === 'string' && /^\d+\.\d+\.\d+$/.test(result.cliVersion) ? result.cliVersion : null,
        cliDigest: typeof result.cliDigest === 'string' && /^[a-f0-9]{64}$/.test(result.cliDigest) ? result.cliDigest : null,
        parserDigest: typeof result.parserDigest === 'string' && /^[a-f0-9]{64}$/.test(result.parserDigest) ? result.parserDigest : null };
      const now = Date.now();
      this.result = { state, reason: timedOut ? 'native-canary-timeout' : !result.cleanupVerified ? 'native-canary-cleanup-unverified' : result.state === 'passed' && !scopeValid ? 'native-canary-invalid-proof-scope' : `native-canary-${state}`,
        sampledAt: now, validUntil: state === 'passed' ? now + this.intervalMs : null, cleanupVerified: result.cleanupVerified === true };
    } catch {
      this.cleanupFailed = true;
      if (!this.closed) this.result = { state: 'failed', reason: 'native-canary-failed', sampledAt: Date.now(), validUntil: null, cleanupVerified: false };
    } finally { clearTimeout(timeout); this.controller = undefined; }
  }
  async close(): Promise<void> {
    this.closed = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort();
    // Retain ownership until the trusted adapter confirms its child cleanup.
    await this.pending;
  }
}
