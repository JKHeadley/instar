/**
 * RULE 3.1 RATIONALE
 * - Criticality: high; credential/destination observations are load-bearing.
 * - Frequency: startup, configuration invalidation, and the consumer's five-second refresh.
 * - Stability: stable owned JSON and SecretMigrator/SecretStore contracts.
 * - Fallback: bounded fresh reads reject malformed, changed, timed-out or unreadable
 *   sources; old resolved credentials cannot substitute for current authority.
 * - Verdict: deterministic validation with real filesystem/crypto controls;
 *   forced-state canary enrollment is tracked in the Rule 3 detector registry.
 *   Never rederive credentials or permission through an LLM or stale cache.
 */
import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { OriginSourceHealth } from './OriginDetectorHealth.js';

export interface OriginConfigObservation {
  config: Record<string, any>; observedAt: number; version: string; revision: number;
}
interface ConfigReadAttempt { cancelled: boolean; deadline: number; abort: AbortController; worker: Worker | null; cancel: (() => void) | null; }

/** Real config plus the existing SecretMigrator authority, read afresh. No
 * authority from a cached merged config. Only one bounded read may be pending. */
export class OriginConfigReader {
  readonly #boot = randomUUID();
  readonly #watchers = new Map<string, FSWatcher>();
  readonly #listeners = new Set<() => void>();
  #resolvedDigest: string | null = null;
  #revision = 0; #sequence = 0; #closed = false; #healthy = false;
  #pending: Promise<OriginConfigObservation> | null = null;
  #active: ConfigReadAttempt | null = null;
  #attemptedAt: number | null = null;
  #succeededAt: number | null = null;
  #reason = 'source-not-read';
  constructor(readonly stateDir: string, readonly workerUrl = new URL('./OriginConfigReader.worker.js', import.meta.url)) {}
  get revision(): number { return this.#revision; }
  getHealth(now = Date.now()): OriginSourceHealth {
    const stale = this.#succeededAt !== null && (now < this.#succeededAt || now - this.#succeededAt >= 30_000);
    return { state: this.#closed ? 'closed' : !this.#healthy ? (this.#attemptedAt === null ? 'pending' : 'unavailable') : stale ? 'stale' : 'healthy',
      reason: this.#closed ? 'source-closed' : stale && this.#healthy ? 'source-stale' : this.#reason,
      attemptedAt: this.#attemptedAt, succeededAt: this.#succeededAt, busy: this.#active !== null, revision: this.#revision };
  }
  onInvalidated(listener: () => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  #invalidate(): void { this.#healthy = false; this.#reason = 'source-invalidated'; this.#revision++; for (const listener of this.#listeners) listener(); }
  async #watch(): Promise<void> {
    for (const name of ['', 'secrets', 'machine']) {
      const directory = path.join(this.stateDir, name);
      if (this.#watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, (_event, filename) => {
          if (filename === null || ['config.json', 'config.secrets.enc', 'secrets-master.key', 'secrets', 'machine'].includes(String(filename))) {
            if (String(filename) === 'secrets' || String(filename) === 'machine') {
              const child = path.join(this.stateDir, String(filename)); this.#watchers.get(child)?.close(); this.#watchers.delete(child);
            }
            this.#invalidate();
          }
        });
        watcher.on('error', () => { watcher.close(); this.#watchers.delete(directory); this.#invalidate(); });
        this.#watchers.set(directory, watcher);
      } catch (error) {
        if (name === '' || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  read(): Promise<OriginConfigObservation> {
    if (this.#closed) return Promise.reject(new Error('origin-config-reader-closed'));
    if (this.#pending) return this.#pending;
    this.#attemptedAt = Date.now();
    const attempt: ConfigReadAttempt = { cancelled: false, deadline: Date.now() + 2000,
      abort: new AbortController(), worker: null, cancel: null };
    this.#active = attempt;
    this.#pending = this.#read(attempt).then(result => { this.#healthy = true; this.#succeededAt = result.observedAt; this.#reason = 'source-observed'; return result; })
      .catch(error => { if (this.#healthy) this.#invalidate(); this.#reason = 'source-read-unavailable'; throw error; });
    return this.#pending;
  }
  #assertCurrent(attempt: ConfigReadAttempt): void {
    if (this.#closed || attempt.cancelled || this.#active !== attempt || Date.now() >= attempt.deadline) {
      throw new Error('origin-config-reader-timeout');
    }
  }
  async #read(attempt: ConfigReadAttempt): Promise<OriginConfigObservation> {
    const revision = this.#revision;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const source = this.#readSources(revision, attempt);
    // Keep the sole source-work slot until even an unabortable stat/watch has
    // settled. Timed-out callers can fail promptly without starting more work.
    const release = () => {
      if (timeout) clearTimeout(timeout);
      if (this.#active === attempt) { this.#active = null; this.#pending = null; }
    };
    try {
      const observation = await Promise.race([source, new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          attempt.cancelled = true; attempt.abort.abort(); attempt.cancel?.();
          reject(new Error('origin-config-reader-timeout'));
        }, 2000);
      })]);
      this.#assertCurrent(attempt);
      if (revision !== this.#revision) throw new Error('origin-config-source-changed');
      const digest = createHash('sha256').update(JSON.stringify(observation.config)).digest('hex');
      // Secret authority can change without a config-file write. Observing a
      // different resolved source revokes every older consumer snapshot too.
      if (this.#resolvedDigest !== null && this.#resolvedDigest !== digest) this.#invalidate();
      this.#resolvedDigest = digest;
      return { ...observation, revision: this.#revision };
    } finally {
      // Register only after this read's result checks: a successful source must
      // still own its attempt while those checks run.
      void source.then(release, release);
    }
  }
  async #readSources(revision: number, attempt: ConfigReadAttempt): Promise<OriginConfigObservation> {
    await this.#watch(); this.#assertCurrent(attempt);
    const configPath = path.join(this.stateDir, 'config.json');
    if ((await stat(configPath)).size > 1024 * 1024) throw new Error('origin-config-size');
    this.#assertCurrent(attempt);
    const bytes = await readFile(configPath, { encoding: 'utf8', signal: attempt.abort.signal });
    this.#assertCurrent(attempt);
    if (Buffer.byteLength(bytes) > 1024 * 1024) throw new Error('origin-config-size');
    let config = JSON.parse(bytes);
    let hasVault = false;
    try { const vault = await stat(path.join(this.stateDir, 'secrets/config.secrets.enc'));
      if (vault.size > 1024 * 1024) throw new Error('origin-config-secret-size'); hasVault = true;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    this.#assertCurrent(attempt);
    if (revision !== this.#revision) throw new Error('origin-config-source-changed');
    if (hasVault) config = await this.#merge(config, attempt);
    this.#assertCurrent(attempt);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('origin-config-shape');
    const version = createHash('sha256').update(JSON.stringify(config)).digest('hex');
    return { config, observedAt: Date.now(), version: `${this.#boot}:${++this.#sequence}:${version}`, revision };
  }
  #merge(config: Record<string, unknown>, attempt: ConfigReadAttempt): Promise<Record<string, unknown>> {
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'VITEST', 'NODE_ENV']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    this.#assertCurrent(attempt);
    const worker = new Worker(this.workerUrl, { env, execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 192 } });
    attempt.worker = worker; worker.stdout?.resume(); worker.stderr?.resume();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value?: Record<string, unknown>) => {
        if (settled) return; settled = true;
        const complete = (terminated: boolean) => {
          attempt.cancel = null; attempt.worker = null;
          if (terminated && value && !attempt.cancelled && this.#active === attempt && !this.#closed && Date.now() < attempt.deadline) resolve(value);
          else reject(new Error('origin-config-secret-source-unavailable'));
        };
        // Source ownership includes worker termination; another read cannot
        // accumulate a second worker while the old one is still winding down.
        void worker.terminate().then(() => complete(true), () => complete(false));
      };
      attempt.cancel = () => finish();
      worker.once('message', (message: { config?: Record<string, unknown> }) => finish(message.config));
      worker.once('error', () => finish()); worker.once('exit', () => finish());
      worker.postMessage({ id: 1, stateDir: this.stateDir, config });
    });
  }
  close(): void {
    this.#closed = true;
    if (this.#active) { this.#active.cancelled = true; this.#active.abort.abort(); this.#active.cancel?.(); void this.#active.worker?.terminate(); }
    for (const watcher of this.#watchers.values()) watcher.close(); this.#watchers.clear(); this.#invalidate(); this.#listeners.clear();
  }
}
