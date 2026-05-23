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
  generateNonce,
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
import { LocaltunnelProvider } from './LocaltunnelProvider.js';
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
  /**
   * Send the consent prompt to the owner with approve/decline inline
   * buttons carrying the nonce. Returns the message id or null on
   * failure. Optional — when the adapter doesn't implement it, the
   * manager falls back to sending the consent prompt as plain text
   * via sendToOwnerDM (degraded: the owner would reply in words,
   * which PR 6 doesn't wire — so the button path is the supported
   * one).
   */
  sendOwnerConsentPrompt?(text: string, nonce: string): Promise<number | null>;
  /** Register the grant/decline callback handler (inline-button clicks). */
  setTunnelConsentHandler?(fn: ((action: 'grant' | 'decline', nonce: string) => Promise<string>) | null): void;
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
/** Per-episode consent prompt timeout — matches spec Part 4 default (15 min). */
const CONSENT_TIMEOUT_MS = 15 * 60_000;

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
  /**
   * Pending consent record — populated when the manager enters
   * `awaiting-consent` and cleared on grant / decline / timeout / stop.
   * The nonce is the CSPRNG token sent to the owner; matching it on
   * `grantConsent()` is the security-load-bearing check.
   */
  private _pendingConsent: {
    episodeId: string;
    provider: TunnelProvider;
    nonce: string;
    issuedAt: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** Adapter ref captured by attachTelegram — used to send the button prompt. */
  private _consentAdapter: TunnelMessagingAdapter | null = null;

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
    this.clearPendingConsent();
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
    this._consentAdapter = adapter;
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
    // The notifier handles the GROUP pointer for awaiting-consent; the
    // owner-DM consent PROMPT (with buttons) is sent by the manager
    // directly in requestConsent so it can carry the nonce + inline
    // keyboard. Suppress the notifier's plain-text consent DM to avoid
    // a double send.
    this.notifier = new TunnelNotifier({ sink, credentialProvider, suppressConsentDM: true });

    // Register the grant/decline callback handler for inline-button clicks.
    adapter.setTunnelConsentHandler?.(async (action, nonce) => {
      if (action === 'grant') {
        const ok = await this.grantConsent(nonce);
        return ok ? 'Backup approved — bringing it up now' : 'That request is no longer active';
      }
      const ok = this.declineConsent(nonce);
      return ok ? 'Okay — staying on Cloudflare' : 'That request is no longer active';
    });
  }

  // ── Internals ──────────────────────────────────────────────────

  private buildDefaultPool(config: TunnelConfig): TunnelProvider[] {
    const pool: TunnelProvider[] = [];
    // Tier-1 (automatic, secure). Cloudflare named first when configured,
    // then quick as the zero-config default.
    if (config.token || config.configFile) {
      pool.push(new CloudflareNamedProvider({
        token: config.token,
        configFile: config.configFile,
        hostname: config.hostname,
      }));
    }
    pool.push(new CloudflareQuickProvider({ port: config.port, stateDir: config.stateDir }));
    // Tier-2 (consent-gated relays). Listed AFTER Tier-1 — the driver
    // only reaches these after exhausting Tier-1, and only after the
    // owner explicitly grants consent. LocaltunnelProvider's
    // isAvailable() returns false when the `localtunnel` npm package
    // isn't installed, so agents without the dep see this slot
    // silently skipped — the spec's "opt-in capability" posture.
    pool.push(new LocaltunnelProvider({ port: config.port }));
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
    // start() rejects after the FIRST round of provider attempts
    // fails (matches the legacy semantics). The backoff retry runs in
    // the background — the manager keeps trying without blocking the
    // caller, and emits 'url' when a later attempt succeeds.
    //
    // PR 5 addition: BEFORE transitioning to exhausted, check if any
    // Tier-2 providers are available and the cross-episode consent
    // cooldown isn't active. If so, transition to `awaiting-consent`
    // and request consent from the owner. The relay-active path
    // activates on `grantConsent()`.
    const candidateTier2 = await this.findAvailableTier2();
    const cooldownActive = this.lifecycle.isConsentSuppressed();

    if (candidateTier2 && !cooldownActive) {
      const from = this.lifecycle.state;
      if (from === 'retrying' || from === 'starting') {
        if (this.lifecycle.transition(from, 'awaiting-consent', {
          activeProvider: null,
          lastFailureReason: classifyFailure(lastErr),
        })) {
          this.requestConsent(candidateTier2);
        }
      }
      const err = lastErr ?? new Error('Tier-1 exhausted; awaiting owner consent for backup relay');
      this.emit('error', err);
      throw err;
    }

    const from = this.lifecycle.state;
    if (from === 'retrying' || from === 'starting') {
      this.lifecycle.transition(from, 'exhausted', { activeProvider: null });
    }

    const err = lastErr ?? new Error('all Tier-1 providers failed');
    if (this._autoReconnect && !this._stopped) {
      this.scheduleBackgroundRetry();
    }
    this.emit('error', err);
    throw err;
  }

  /** First Tier-2 provider that reports available, or null. */
  private async findAvailableTier2(): Promise<TunnelProvider | null> {
    for (const p of this.providers) {
      if (p.tier !== 2) continue;
      const avail = await p.isAvailable().catch(() => false);
      if (avail) return p;
    }
    return null;
  }

  /**
   * Internal — called after the lifecycle transitions to
   * `awaiting-consent`. Generates the one-time nonce, stores the
   * pending consent record, and arms the timeout.
   */
  private requestConsent(provider: TunnelProvider): void {
    this.clearPendingConsent();
    const episode = this.lifecycle.episode;
    if (!episode) return;
    const nonce = generateNonce();
    const timer = setTimeout(() => {
      this.recordConsentDecline(nonce, 'timeout');
    }, CONSENT_TIMEOUT_MS);
    this._pendingConsent = {
      episodeId: episode.episodeId,
      provider,
      nonce,
      issuedAt: Date.now(),
      timer,
    };

    // Send the button-bearing consent prompt to the owner DM (the
    // notifier sends only the group pointer for awaiting-consent;
    // suppressConsentDM avoids a double owner-DM). Fire-and-forget.
    if (this._consentAdapter?.sendOwnerConsentPrompt) {
      void this._consentAdapter.sendOwnerConsentPrompt(
        this.consentPromptText(provider.name),
        nonce,
      ).catch(() => { /* adapter logs its own failures */ });
    } else if (this._consentAdapter?.sendToOwnerDM) {
      // Degraded: no inline-button support — send the text only.
      void this._consentAdapter.sendToOwnerDM(this.consentPromptText(provider.name))
        .catch(() => { /* best effort */ });
    }
  }

  /** Owner-facing consent prompt text. Honest about third-party exposure + rotation cost. */
  private consentPromptText(provider: ProviderName): string {
    const relayDesc = provider === 'bore'
      ? 'an unencrypted third-party relay (its operator and the network path can see your traffic)'
      : 'a third-party relay (its operator can see your dashboard traffic while it is in use)';
    return [
      `Cloudflare is unavailable and I can't get you a dashboard link the usual way.`,
      ``,
      `I can bring up a backup through ${relayDesc}. Your dashboard PIN and any private view links would be visible to that operator while the backup is active. After the backup is no longer needed, I'll rotate your PIN and access token — that signs you out of any open dashboard tabs and invalidates any private view links you've already shared.`,
      ``,
      `Tap a button below. If you don't respond, I'll keep waiting for Cloudflare and won't use a backup.`,
    ].join('\n');
  }

  private clearPendingConsent(): void {
    if (this._pendingConsent) {
      clearTimeout(this._pendingConsent.timer);
      this._pendingConsent = null;
    }
  }

  /**
   * Public — called by the consent UX layer (Telegram callback handler
   * in PR 6) after the owner approves. Validates the nonce matches the
   * pending consent record, starts the Tier-2 provider, and transitions
   * to `relay-active`. Returns true on success, false if the nonce
   * didn't match (replay, race, stale click) or the state moved beyond
   * awaiting-consent.
   */
  async grantConsent(nonce: string): Promise<boolean> {
    if (!this._pendingConsent) return false;
    if (this._pendingConsent.nonce !== nonce) return false;
    if (this.lifecycle.state !== 'awaiting-consent') {
      this.clearPendingConsent();
      return false;
    }
    const { provider, episodeId } = this._pendingConsent;
    if (this.lifecycle.episode?.episodeId !== episodeId) {
      this.clearPendingConsent();
      return false;
    }
    // Single-use: clear BEFORE starting so a replay loses cleanly.
    this.clearPendingConsent();

    try {
      const handle = await provider.start(this.config.port);
      const reachable = await this.probeReachability(handle.url).catch(() => false);
      if (!reachable) {
        try { await handle.stop(); } catch { /* best effort */ }
        this.lifecycle.recordAttempt(provider.name, 'reachability-failed');
        this.lifecycle.recordConsentRefusal();
        const from = this.lifecycle.state;
        if (from === 'awaiting-consent') {
          this.lifecycle.transition('awaiting-consent', 'exhausted', { activeProvider: null });
        }
        if (this._autoReconnect && !this._stopped) {
          this.scheduleBackgroundRetry();
        }
        return false;
      }

      this.currentHandle = handle;
      this.currentProviderName = provider.name;
      this._legacyState.url = handle.url;
      this._legacyState.startedAt = new Date().toISOString();
      // Set rotation-pending — entering relay-active is the persisted
      // marker that says "credentials must rotate when this episode
      // ends" (per spec Part 6 / verification finding V1).
      this.lifecycle.setRotationPending(true);
      this.lifecycle.transition('awaiting-consent', 'relay-active', {
        activeProvider: provider.name,
        lastFailureReason: null,
        rotationPending: true,
      });
      this.persist();
      this.emit('url', handle.url);
      return true;
    } catch (err) {
      this.lifecycle.recordAttempt(provider.name, classifyFailure(err));
      this.lifecycle.recordConsentRefusal();
      const from = this.lifecycle.state;
      if (from === 'awaiting-consent') {
        this.lifecycle.transition('awaiting-consent', 'exhausted', { activeProvider: null });
      }
      if (this._autoReconnect && !this._stopped) {
        this.scheduleBackgroundRetry();
      }
      return false;
    }
  }

  /**
   * Public — called by the consent UX layer when the owner declines.
   * Validates the nonce, applies the cross-episode cooldown, and
   * transitions to `exhausted` + background retry.
   */
  declineConsent(nonce: string): boolean {
    return this.recordConsentDecline(nonce, 'decline');
  }

  private recordConsentDecline(nonce: string, _reason: 'decline' | 'timeout'): boolean {
    if (!this._pendingConsent) return false;
    if (this._pendingConsent.nonce !== nonce) return false;
    if (this.lifecycle.state !== 'awaiting-consent') {
      this.clearPendingConsent();
      return false;
    }
    this.clearPendingConsent();
    this.lifecycle.recordConsentRefusal();
    this.lifecycle.transition('awaiting-consent', 'exhausted', { activeProvider: null });
    if (this._autoReconnect && !this._stopped) {
      this.scheduleBackgroundRetry();
    }
    return true;
  }

  /**
   * Public — the active pending-consent record (or null). Used by the
   * consent UX layer (PR 6) to know what nonce to embed in the inline
   * button.
   */
  get pendingConsent(): { episodeId: string; provider: ProviderName; nonce: string; issuedAt: number } | null {
    if (!this._pendingConsent) return null;
    return {
      episodeId: this._pendingConsent.episodeId,
      provider: this._pendingConsent.provider.name,
      nonce: this._pendingConsent.nonce,
      issuedAt: this._pendingConsent.issuedAt,
    };
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
