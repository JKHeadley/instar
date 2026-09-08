/**
 * RULE 3.1 RATIONALE
 * - Criticality: high; a false positive could authorize the fixed notice at a stale hub.
 * - Frequency: startup, source invalidation, and five-second refresh; memory-only at fire time.
 * - Stability: stable owned config, encrypted secret resolution, and attention-hub state.
 * - Fallback: exact destination/token binding, watch invalidation and a 30-second
 *   expiry revoke unavailable permission; the notifier independently checks custody.
 * - Verdict: deterministic contract validation with real source-change controls;
 *   forced-state canary enrollment is tracked in the Rule 3 detector registry.
 *   Client preferences remain Telegram-managed; no inference restores authority.
 */
import { createHash, randomUUID } from 'node:crypto';
import { watch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { canonicalOrigin } from './CanonicalOrigin.js';
import { OriginConfigReader } from './OriginConfigReader.js';
import { originOutageNoticeEnabled } from './OriginConfig.js';
import type { OriginNoticeDestinationPolicy } from './OriginNoticePolicy.js';
import type { OriginSourceHealth } from './OriginDetectorHealth.js';

/** Independent of the origin workers and their recovery loop. Only actual
 * configuration/hub reads refresh this source; fire-time access is memory-only.
 * Watch invalidation prevents known changes from riding the old 30s snapshot. */
export class OriginNoticePolicyObserver {
  readonly #boot = randomUUID();
  readonly #watchers = new Map<string, FSWatcher>();
  #snapshot: OriginNoticeDestinationPolicy | null = null;
  #revision = 0;
  #sequence = 0;
  #closed = false;
  #refreshing: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #attemptedAt: number | null = null;
  #succeededAt: number | null = null;
  readonly #configReader: OriginConfigReader;
  readonly #unsubscribe: () => void;
  private constructor(readonly options: { stateDir: string; accountId: string; token?: string; now?: () => number; configReader?: OriginConfigReader }) {
    this.#configReader = options.configReader ?? new OriginConfigReader(options.stateDir);
    this.#unsubscribe = this.#configReader.onInvalidated(() => { this.#invalidate(); });
  }
  static async open(options: { stateDir: string; accountId: string; token?: string; now?: () => number; configReader?: OriginConfigReader }): Promise<OriginNoticePolicyObserver> {
    const observer = new OriginNoticePolicyObserver(options);
    await observer.refresh(); observer.#schedule(); return observer;
  }
  #now(): number { return this.options.now?.() ?? Date.now(); }
  getHealth(): OriginSourceHealth {
    const now = this.#now(), snapshot = this.#snapshot;
    const stale = !!snapshot && (snapshot.observedAt > now || snapshot.validUntil <= now);
    return { state: this.#closed ? 'closed' : !snapshot ? (this.#attemptedAt === null ? 'pending' : 'unavailable') : stale ? 'stale' : 'healthy',
      reason: this.#closed ? 'source-closed' : !snapshot ? 'policy-source-unavailable' : stale ? 'source-stale' : 'policy-source-observed',
      attemptedAt: this.#attemptedAt, succeededAt: this.#succeededAt, busy: this.#refreshing !== null, revision: this.#revision };
  }
  #invalidate(): void { this.#revision++; this.#snapshot = null; }
  #ensureWatchers(): boolean {
    for (const [directory, filename] of [[this.options.stateDir, 'config.json'], [path.join(this.options.stateDir, 'state'), 'agent-attention-topic.json']]) {
      if (this.#watchers.has(directory)) continue;
      try {
        const watcher = watch(directory, { persistent: false }, (_event, changed) => {
          if (changed === null || String(changed) === filename || String(changed) === 'state') {
            this.#invalidate(); void this.refresh();
          }
        });
        watcher.on('error', () => { this.#invalidate(); watcher.close(); this.#watchers.delete(directory); });
        this.#watchers.set(directory, watcher);
      } catch { this.#snapshot = null; return false; }
    }
    return true;
  }
  #schedule(): void {
    if (this.#closed) return;
    this.#timer = setTimeout(() => { this.#timer = null; void this.refresh().finally(() => this.#schedule()); }, 5000);
    this.#timer.unref();
  }
  refresh(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#refreshing) return this.#refreshing;
    const revision = this.#revision;
    this.#refreshing = this.#read(revision).finally(() => {
      this.#refreshing = null;
      if (!this.#closed && revision !== this.#revision) void this.refresh();
    });
    return this.#refreshing;
  }
  async #read(revision: number): Promise<void> {
    this.#attemptedAt = this.#now();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!this.#ensureWatchers()) return;
      const [observation, hubBytes] = await Promise.race([
        Promise.all([this.#configReader.read(),
          readFile(path.join(this.options.stateDir, 'state', 'agent-attention-topic.json'), 'utf8')]),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('notice-policy-read-timeout')), 2000); }),
      ]);
      if (Buffer.byteLength(hubBytes) > 128) throw new Error('notice-policy-size');
      const config = observation.config, hub = JSON.parse(hubBytes);
      const entries = Array.isArray(config.messaging) ? config.messaging.filter((entry: { type?: unknown }) => entry?.type === 'telegram') : [];
      if (entries.length !== 1 || !Number.isSafeInteger(hub) || hub <= 0) throw new Error('notice-policy-destination');
      const entry = entries[0];
      if ((entry.enabled !== undefined && typeof entry.enabled !== 'boolean') || typeof entry.config?.chatId !== 'string' || !/^-?[1-9][0-9]*$/.test(entry.config.chatId) ||
        !/^[1-9][0-9]*$/.test(this.options.accountId)) throw new Error('notice-policy-config');
      if (typeof entry.config.token !== 'string' || entry.config.token.split(':')[0] !== this.options.accountId || (this.options.token !== undefined && entry.config.token !== this.options.token)) throw new Error('notice-policy-account-changed');
      const enabled = originOutageNoticeEnabled(entry.config.messageOrigin), now = this.#now();
      const digest = createHash('sha256').update(observation.version).update('\0').update(hubBytes).digest('hex');
      if (this.#closed || revision !== this.#revision) return;
      this.#succeededAt = now;
      this.#snapshot = { destination: { accountId: this.options.accountId, chatId: entry.config.chatId, topicId: String(hub) },
        authorized: entry.enabled === true, optedOut: !enabled, clientPreferences: 'telegram-managed', observerHealthy: true,
        observedAt: now, validUntil: now + 30_000, version: `${this.#boot}:${++this.#sequence}:${digest}` };
    } catch { this.#snapshot = null; }
    finally { if (timeout) clearTimeout(timeout); }
  }
  read(destination: OriginNoticeDestinationPolicy['destination']): OriginNoticeDestinationPolicy | null {
    const current = this.#snapshot, now = this.#now();
    if (this.#closed || !current || current.observedAt > now || current.validUntil <= now ||
      canonicalOrigin(current.destination) !== canonicalOrigin(destination)) return null;
    return structuredClone(current);
  }
  close(): void {
    this.#closed = true; this.#unsubscribe(); if (!this.options.configReader) this.#configReader.close(); this.#invalidate();
    if (this.#timer) clearTimeout(this.#timer);
    for (const watcher of this.#watchers.values()) watcher.close(); this.#watchers.clear();
  }
}
