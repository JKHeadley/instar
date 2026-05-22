/**
 * TunnelManager — single owner of the tunnel lifecycle.
 *
 * Per spec specs/dev-infrastructure/tunnel-failure-resilience.md.
 *
 * Rewritten on top of the foundation modules:
 *   - TunnelProvider — backend abstraction; concrete providers under
 *     src/tunnel/Cloudflare*Provider.ts.
 *   - TunnelLifecycle — single-writer CAS-guarded state machine.
 *   - TunnelNotifier — two-channel routing (group / owner-DM) of
 *     transition events.
 *
 * The manager is the SOLE owner of the detect → attempt → fall-back →
 * notify → self-heal lifecycle. The previous server.ts startup-retry
 * ladder + background-retry ladder + Lifeline failure message are
 * retired in favor of routing all retry through here (one backoff
 * engine, not two).
 *
 * Scope of this rewrite (PR 2 of the chain):
 *   - Tier-1 provider pool (Cloudflare named → quick) with internal
 *     backoff between retries within an episode.
 *   - Post-start reachability probe (HTTP /health through the public
 *     URL) before declaring `active` — prevents broadcasting a "back
 *     online" link that doesn't actually serve traffic.
 *   - Backward-compatible public API: start(), stop(), forceStop(),
 *     enableAutoReconnect(), disableAutoReconnect(), getExternalUrl(),
 *     url/isRunning/state. Plus the existing events.
 *   - Notifier sink optional; when telegram adapter is plumbed,
 *     transition events route to the group topic.
 *
 * Out of scope for THIS PR (future PRs in the chain):
 *   - Tier-2 consent flow + relay providers (PR 4).
 *   - Owner-DM channel + inline-button consent UX (PR 3).
 *   - authToken/PIN rotation + boot recovery (PR 5).
 *   - Self-heal probe with N-consecutive-success stability gate (PR 6).
 *   - The /tunnel route (PR 7).
 *
 * The lifecycle state machine already supports these states; the
 * manager simply doesn't transition into them yet in PR 2.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import {
  TunnelLifecycle,
  classifyFailure,
  type PersistedTunnelState,
  type TransitionEvent,
} from './TunnelLifecycle.js';
import type {
  TunnelProvider,
  TunnelProviderHandle,
  ProviderName,
  ProviderFailureReason,
} from './TunnelProvider.js';
import { CloudflareQuickProvider } from './CloudflareQuickProvider.js';
import { CloudflareNamedProvider } from './CloudflareNamedProvider.js';
import type { NotifierSink } from './TunnelNotifier.js';
import { TunnelNotifier } from './TunnelNotifier.js';

// ── Types (back-compat) ─────────────────────────────────────────────

export interface TunnelConfig {
  /** Whether tunnel is enabled. */
  enabled: boolean;
  /** Tunnel type: 'quick' (ephemeral, no account) or 'named' (persistent, requires token). */
  type: 'quick' | 'named';
  /** Cloudflare tunnel token (named, token-auth). */
  token?: string;
  /** Config file path (named, config-file-auth). */
  configFile?: string;
  /** Public hostname for named tunnels. */
  hostname?: string;
  /** Local port to tunnel to. */
  port: number;
  /** State directory for persisting tunnel.json. */
  stateDir: string;
}

export interface TunnelState {
  url: string | null;
  type: 'quick' | 'named';
  startedAt: string | null;
  connectionId?: string;
  connectionLocation?: string;
}

export interface TunnelEvents {
  url: (url: string) => void;
  connected: (info: { id: string; ip: string; location: string }) => void;
  disconnected: () => void;
  error: (error: Error) => void;
  stopped: () => void;
}

/** Optional injections for testability. */
export interface TunnelManagerInjections {
  providers?: TunnelProvider[];
  notifierSink?: NotifierSink;
  fetch?: typeof fetch;
}

/**
 * Minimal duck-typed interface for the messaging adapter the manager
 * uses for user-facing notifications. The real implementation is
 * `TelegramAdapter` but we don't import that type here to keep this
 * module decoupled from the messaging layer.
 */
export interface TunnelMessagingAdapter {
  sendToTopic(topicId: number, text: string): Promise<unknown>;
  sendToOwnerDM(text: string): Promise<unknown>;
  getDashboardTopicId(): number | undefined;
  getLifelineTopicId(): number | undefined;
}

// ── Constants ───────────────────────────────────────────────────────

const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_ATTEMPTS = 10;
const REACHABILITY_TIMEOUT_MS = 8_000;
/**
 * Post-exhausted retry cadence — the minimum-viable "self-heal"
 * placeholder for PR 2. After the bounded startup-reconnect ladder
 * exhausts (MAX_BACKOFF_ATTEMPTS), the manager keeps probing the
 * Tier-1 pool at this cadence indefinitely. This is intentionally
 * crude; PR 6 replaces it with the spec's N-consecutive-success
 * stability-gate probe per Part 5. Without this placeholder, the
 * agent stays link-less after exhaustion until restart — which is
 * the regression we explicitly need to avoid in the PR chain.
 */
const POST_EXHAUSTED_RETRY_INTERVAL_MS = 15 * 60_000;

// ── Manager ────────────────────────────────────────────────────────

export class TunnelManager extends EventEmitter {
  private readonly config: TunnelConfig;
  private readonly stateFile: string;

  private readonly lifecycle: TunnelLifecycle;
  private readonly providers: TunnelProvider[];
  private notifier: TunnelNotifier | null;
  private readonly fetcher: typeof fetch;

  private currentHandle: TunnelProviderHandle | null = null;
  private currentProviderName: ProviderName | null = null;
  private _legacyState: TunnelState;
  private _autoReconnect = true; // always-on under the new design
  private _stopped = false;
  private _startPromise: Promise<string> | null = null;
  private _backoffAttempt = 0;
  private _backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private _postExhaustedTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: TunnelConfig, injections?: TunnelManagerInjections) {
    super();
    this.config = config;
    this.stateFile = path.join(config.stateDir, 'tunnel.json');
    this.lifecycle = new TunnelLifecycle();
    this.providers = injections?.providers ?? this.buildDefaultPool(config);
    this.notifier = injections?.notifierSink
      ? new TunnelNotifier({ sink: injections.notifierSink })
      : null;
    this.fetcher = injections?.fetch ?? globalThis.fetch.bind(globalThis);

    this._legacyState = {
      url: null,
      type: config.type,
      startedAt: null,
    };

    // Route lifecycle transitions through the notifier.
    this.lifecycle.on('transition', (e: TransitionEvent) => {
      if (this.notifier) void this.notifier.onTransition(e);
    });

    // Restore persisted snapshot (rotation-pending flag + consent cooldown).
    this.restorePersisted();
  }

  // ── Public API (back-compat with the legacy manager) ────────────

  get url(): string | null { return this._legacyState.url; }

  get isRunning(): boolean { return this.currentHandle !== null && !this._stopped; }

  get state(): TunnelState { return { ...this._legacyState }; }

  /** Additive new accessor — lifecycle snapshot. */
  get lifecycleState(): PersistedTunnelState {
    const snap = this.lifecycle.snapshot();
    snap.lastUrl = this._legacyState.url;
    return snap;
  }

  /**
   * Start the tunnel. Drives the full Tier-1 ladder internally — the
   * caller does NOT wrap with its own retry loop (the old server.ts
   * startup ladder is RETIRED).
   *
   * Resolves with the URL of the first provider that reaches `active`.
   * Rejects when all Tier-1 providers fail and backoff is exhausted.
   */
  async start(): Promise<string> {
    if (this._startPromise) return this._startPromise;
    if (this.currentHandle && this._legacyState.url) return this._legacyState.url;
    this._stopped = false;
    this._startPromise = this.doStart().finally(() => { this._startPromise = null; });
    return this._startPromise;
  }

  async stop(): Promise<void> {
    this._stopped = true;
    this.clearBackoffTimer();
    this.clearPostExhaustedTimer();
    this._startPromise = null;

    if (this.currentHandle) {
      try { await this.currentHandle.stop(); } catch { /* handle may be dead */ }
      this.currentHandle = null;
    }

    this._legacyState.url = null;
    this._legacyState.startedAt = null;
    this.currentProviderName = null;

    const from = this.lifecycle.state;
    if (from !== 'idle') {
      try { this.lifecycle.transition(from, 'idle', { activeProvider: null }); }
      catch { /* invalid pair — best-effort */ }
    }

    this.persist();
    this.emit('stopped');
  }

  /** Force-stop with escalation. Providers internally do SIGINT → SIGKILL. */
  async forceStop(_timeoutMs?: number): Promise<void> {
    await this.stop();
  }

  enableAutoReconnect(): void { this._autoReconnect = true; }

  disableAutoReconnect(): void {
    this._autoReconnect = false;
    this.clearBackoffTimer();
  }

  getExternalUrl(localPath: string): string | null {
    if (!this._legacyState.url) return null;
    const base = this._legacyState.url.replace(/\/$/, '');
    const p = localPath.startsWith('/') ? localPath : `/${localPath}`;
    return `${base}${p}`;
  }

  /**
   * Attach a messaging adapter so the manager can route lifecycle
   * transitions to the user. Called by `server.ts` after the telegram
   * adapter is constructed (the tunnel itself is constructed earlier
   * in startup so it can boot before messaging is wired). Safe to call
   * once; subsequent calls replace the active notifier.
   *
   * Channel routing:
   *   - Group messages → Dashboard topic (falls back to Lifeline if
   *     Dashboard isn't ensured yet).
   *   - Owner DM messages → `sendToOwnerDM` on the adapter (the
   *     adapter handles "no owner configured" / "owner hasn't DM'd
   *     the bot yet" failure modes itself).
   *
   * The credentialProvider returns the current URL + dashboard PIN
   * at compose time. The notifier substitutes them into owner-DM
   * messages; the credentials NEVER appear in group messages.
   */
  attachTelegram(adapter: TunnelMessagingAdapter, dashboardPin: () => string | undefined): void {
    const sink: NotifierSink = {
      sendGroup: async (text: string) => {
        const topicId = adapter.getDashboardTopicId() ?? adapter.getLifelineTopicId();
        if (typeof topicId !== 'number') return; // no group destination
        await adapter.sendToTopic(topicId, text);
      },
      sendOwnerDM: async (text: string) => {
        await adapter.sendToOwnerDM(text);
      },
    };
    const credentialProvider = () => ({
      url: this._legacyState.url,
      pin: dashboardPin(),
    });
    this.notifier = new TunnelNotifier({ sink, credentialProvider });
  }

  // ── Internals ──────────────────────────────────────────────────

  private buildDefaultPool(config: TunnelConfig): TunnelProvider[] {
    const pool: TunnelProvider[] = [];
    if (config.token || config.configFile) {
      pool.push(new CloudflareNamedProvider({
        token: config.token,
        configFile: config.configFile,
        hostname: config.hostname,
      }));
    }
    pool.push(new CloudflareQuickProvider({ port: config.port, stateDir: config.stateDir }));
    return pool;
  }

  private async doStart(): Promise<string> {
    if (!this.config.enabled) throw new Error('tunnel.enabled is false');

    if (this.lifecycle.state === 'idle' || this.lifecycle.state === 'active') {
      this.lifecycle.startEpisode();
    }

    if (!this.lifecycle.transition('idle', 'starting')) {
      if (this.lifecycle.state === 'starting' || this.lifecycle.state === 'active') {
        if (this._legacyState.url) return this._legacyState.url;
      }
      throw new Error(`cannot start: lifecycle in state ${this.lifecycle.state}`);
    }

    return this.driveTier1();
  }

  private async driveTier1(): Promise<string> {
    let lastErr: Error | null = null;

    for (let i = 0; i < this.providers.length; i++) {
      if (this._stopped) throw new Error('tunnel start aborted: stopped');
      const provider = this.providers[i];
      if (!provider) continue;
      if (provider.tier !== 1) continue; // Tier-2 deferred to PR 4

      const available = await provider.isAvailable().catch(() => false);
      if (!available) continue;

      try {
        const handle = await provider.start(this.config.port);

        // Reachability probe BEFORE declaring active.
        const reachable = await this.probeReachability(handle.url).catch(() => false);
        if (!reachable) {
          try { await handle.stop(); } catch { /* best effort */ }
          this.lifecycle.recordAttempt(provider.name, 'reachability-failed');
          lastErr = new Error(`reachability-failed: ${provider.name} URL did not respond to /health`);
          continue;
        }

        // Success.
        this.currentHandle = handle;
        this.currentProviderName = provider.name;
        this._legacyState.url = handle.url;
        this._legacyState.startedAt = new Date().toISOString();

        const from = this.lifecycle.state;
        if (from === 'starting' || from === 'retrying') {
          this.lifecycle.transition(from, 'active', {
            activeProvider: provider.name,
            lastFailureReason: null,
          });
        }

        // Persist AFTER the transition so the snapshot reflects 'active'.
        this.persist();

        this.emit('url', handle.url);
        this._backoffAttempt = 0;
        return handle.url;
      } catch (err) {
        const reason = classifyFailure(err);
        this.lifecycle.recordAttempt(provider.name, reason);
        lastErr = err instanceof Error ? err : new Error(String(err));

        if (this.lifecycle.state === 'starting') {
          this.lifecycle.transition('starting', 'retrying', {
            activeProvider: null,
            lastFailureReason: reason,
          });
        }
      }
    }

    // All Tier-1 providers exhausted in this attempt round.
    return this.exhaustedOrBackoff(lastErr);
  }

  private async exhaustedOrBackoff(lastErr: Error | null): Promise<string> {
    // Matches the legacy semantics: start() rejects after the FIRST
    // round of provider attempts fails. The backoff retry runs in the
    // background — the manager keeps trying without blocking the
    // caller, and emits 'url' when a later attempt succeeds. This
    // prevents start() from blocking server.ts boot for the full
    // 25-minute worst-case exponential window. The original failing
    // E2E (tests/e2e/tunnel-private-view.test.ts) timed out at the
    // beforeAll 60s budget because the old draft kept retrying inside
    // start().
    const from = this.lifecycle.state;
    if (from === 'retrying' || from === 'starting') {
      this.lifecycle.transition(from, 'exhausted', { activeProvider: null });
    }

    const err = lastErr ?? new Error('all Tier-1 providers failed');

    // Schedule background retry (bounded exponential ladder, then the
    // indefinite post-exhausted placeholder once the ladder runs out).
    // Fire-and-forget; if a later attempt succeeds, the 'url' event
    // fires and downstream subscribers (notifier, dashboard
    // broadcaster, log line) catch up.
    if (this._autoReconnect && !this._stopped) {
      this.scheduleBackgroundRetry();
    }

    this.emit('error', err);
    throw err;
  }

  /**
   * Background retry — runs the bounded exponential ladder off the
   * start() promise so initial start() resolves/rejects fast. After
   * the ladder exhausts, hands off to the indefinite post-exhausted
   * placeholder (the PR 2 self-heal; PR 6 replaces with the spec's
   * N-consecutive-success probe).
   */
  private scheduleBackgroundRetry(): void {
    if (this._stopped || !this._autoReconnect) return;
    if (this._backoffTimer) return; // already scheduled

    if (this._backoffAttempt >= MAX_BACKOFF_ATTEMPTS) {
      this.schedulePostExhaustedRetry();
      return;
    }

    const delay = Math.min(BASE_BACKOFF_MS * Math.pow(2, this._backoffAttempt), MAX_BACKOFF_MS);
    this._backoffAttempt += 1;

    this._backoffTimer = setTimeout(() => {
      this._backoffTimer = null;
      if (this._stopped || !this._autoReconnect) return;
      const from = this.lifecycle.state;
      try {
        if (from === 'exhausted') {
          this.lifecycle.transition('exhausted', 'starting');
        } else if (from === 'idle') {
          this.lifecycle.transition('idle', 'starting');
        } else if (from === 'retrying') {
          this.lifecycle.transition('retrying', 'starting');
        } else {
          return; // unexpected state; bail
        }
      } catch {
        return; // invalid transition; bail
      }
      void this.driveTier1().catch(() => { /* scheduleBackgroundRetry already chained */ });
    }, delay);
  }

  private clearBackoffTimer(): void {
    if (this._backoffTimer) {
      clearTimeout(this._backoffTimer);
      this._backoffTimer = null;
    }
    this._backoffAttempt = 0;
  }

  private clearPostExhaustedTimer(): void {
    if (this._postExhaustedTimer) {
      clearTimeout(this._postExhaustedTimer);
      this._postExhaustedTimer = null;
    }
  }

  /**
   * Minimum-viable post-exhausted retry (PR 2 self-heal placeholder).
   * Schedules a single low-frequency probe; on completion (success or
   * failure) it re-arms itself, so the agent keeps trying to recover
   * even after the bounded startup-reconnect ladder gives up. PR 6
   * replaces this with the spec's N-consecutive-success stability gate.
   */
  private schedulePostExhaustedRetry(): void {
    if (this._stopped || !this._autoReconnect) return;
    if (this._postExhaustedTimer) return; // already scheduled
    this._postExhaustedTimer = setTimeout(async () => {
      this._postExhaustedTimer = null;
      if (this._stopped || !this._autoReconnect) return;
      // Re-enter from exhausted → starting.
      const from = this.lifecycle.state;
      if (from === 'exhausted') {
        try { this.lifecycle.transition('exhausted', 'starting'); }
        catch { /* invalid transition — bail */ return; }
      } else if (from !== 'starting' && from !== 'idle') {
        // State moved beyond our reach; let the active path handle it.
        return;
      }
      this._backoffAttempt = 0;
      this.driveTier1().then(
        () => { /* success — 'url' event already fired */ },
        () => { /* fail — driveTier1 already re-scheduled via this same path */ },
      );
    }, POST_EXHAUSTED_RETRY_INTERVAL_MS);
  }

  /** HTTP probe through the public URL — confirms the link actually serves. */
  private async probeReachability(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
      const res = await this.fetcher(`${url.replace(/\/$/, '')}/health`, {
        signal: controller.signal,
      });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  // ── Persistence ──────────────────────────────────────────────────

  private persist(): void {
    try {
      const dir = path.dirname(this.stateFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const snap = this.lifecycle.snapshot();
      snap.lastUrl = this._legacyState.url;
      fs.writeFileSync(this.stateFile, JSON.stringify(snap, null, 2));
    } catch {
      // Non-critical.
    }
  }

  private restorePersisted(): void {
    try {
      if (!fs.existsSync(this.stateFile)) return;
      const raw = fs.readFileSync(this.stateFile, 'utf-8');
      const snap = JSON.parse(raw) as PersistedTunnelState;
      if (snap && typeof snap === 'object') {
        this.lifecycle.restoreFrom(snap);
      }
    } catch {
      // Corrupted state file — start fresh.
    }
  }
}

export type { ProviderFailureReason };
