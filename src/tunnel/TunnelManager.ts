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
  type TunnelLifecycleState,
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
  // ── Tunnel-failure-resilience knobs (spec Part 4) — all optional ───
  /** Tier-2 relay providers to offer, in consent order. Default ['localtunnel']. */
  relayProviders?: ('localtunnel' | 'bore')[];
  /** Master switch for Tier-2 relays. Default true. false = Cloudflare-only (no consent offered). */
  relaysEnabled?: boolean;
  /** 'ask' (default) prompts before a relay; 'never' = Cloudflare-only. */
  relayConsent?: 'ask' | 'never';
  /** Consent-prompt timeout in ms. Default 900000 (15 min). */
  consentTimeoutMs?: number;
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
  /**
   * Test seam: override the reachability-probe retry schedule (see
   * REACHABILITY_RETRY_DELAYS_MS) so unit tests don't sleep real seconds.
   */
  reachabilityRetryDelaysMs?: number[];
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
 * Reachability-probe grace window. Right after cloudflared registers a
 * named-tunnel connection, the Cloudflare edge can keep serving 530 for
 * a few seconds while the route propagates. A single immediate probe
 * mistakes that propagation window for a dead link, kills the healthy
 * tunnel, falls through to quick tunnels (which can be rate-limited),
 * and strands the lifecycle in `exhausted` — where the 15-min retry
 * replays the exact same race indefinitely (observed on instar-codey
 * 2026-07-09: a manually-started connector served HTTP 200 within ~6s
 * while the manager kept declaring reachability-failed). Probe up to
 * `delays.length + 1` times, sleeping the next delay between attempts,
 * before declaring reachability-failed.
 */
const REACHABILITY_RETRY_DELAYS_MS = [2_000, 4_000, 6_000];
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
/**
 * Self-heal stability gate (spec Part 5). While a relay is active, an
 * unbounded low-frequency probe tests whether Tier-1 (Cloudflare) can
 * come back. Migrate back only after N consecutive successful Tier-1
 * establishments — a single success during Cloudflare flapping must NOT
 * trigger a switch (the URL-thrashing HIGH from review). With the
 * default cadence, 3 consecutive successes span ~5 minutes.
 */
const SELF_HEAL_PROBE_INTERVAL_MS = 100_000;
const SELF_HEAL_REQUIRED_SUCCESSES = 3;

// ── Manager ────────────────────────────────────────────────────────

export class TunnelManager extends EventEmitter {
  private readonly config: TunnelConfig;
  private readonly stateFile: string;

  private readonly lifecycle: TunnelLifecycle;
  private readonly providers: TunnelProvider[];
  private notifier: TunnelNotifier | null;
  private readonly fetcher: typeof fetch;
  private readonly reachabilityRetryDelaysMs: number[];

  private currentHandle: TunnelProviderHandle | null = null;
  private currentProviderName: ProviderName | null = null;
  private _legacyState: TunnelState;
  private _autoReconnect = true; // always-on under the new design
  private _stopped = false;
  private _startPromise: Promise<string> | null = null;
  private _backoffAttempt = 0;
  private _backoffTimer: ReturnType<typeof setTimeout> | null = null;
  private _postExhaustedTimer: ReturnType<typeof setTimeout> | null = null;
  /** Self-heal probe (Part 5): runs while relay-active to detect Tier-1 recovery. */
  private _selfHealTimer: ReturnType<typeof setInterval> | null = null;
  private _selfHealSuccesses = 0;
  /** Guards performSwitchBack against re-entrancy (probe tick vs. stop). */
  private _switchingBack = false;
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
  /**
   * Credential-rotation callback (wired by server.ts via
   * setCredentialRotator). Owns the WHAT of rotation — regenerate the
   * dashboard PIN + authToken, persist them, and DM the owner the new
   * PIN — while the manager owns the WHEN (every terminal exit from
   * relay-active + boot-recovery). Decoupled from config/messaging so
   * this module stays free of those imports. See
   * specs/dev-infrastructure/tunnel-failure-resilience.md Part 6.
   */
  private _rotateCredentials: (() => Promise<void>) | null = null;

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
    this.reachabilityRetryDelaysMs =
      injections?.reachabilityRetryDelaysMs ?? REACHABILITY_RETRY_DELAYS_MS;

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
    this.stopSelfHealProbe();
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

    // Terminal exit from a relay episode (relay-active → idle via
    // stop/forceStop/shutdown) MUST rotate credentials — the third-party
    // relay operator may have observed the PIN + signed view links while
    // the relay was up. rotationPending (set on relay-active entry) gates
    // this so non-relay stops are no-ops. See spec Part 6.
    await this.runCredentialRotation('stop');

    this.emit('stopped');
  }

  /** Force-stop with escalation. Providers internally do SIGINT → SIGKILL. */
  async forceStop(_timeoutMs?: number): Promise<void> {
    await this.stop();
  }

  /**
   * Wire the credential-rotation callback (called by server.ts). The
   * callback regenerates the dashboard PIN + authToken, persists them,
   * and DMs the owner the new PIN. Wired early in startup so both
   * boot-recovery and runtime relay-episode-end can rotate.
   */
  setCredentialRotator(fn: (() => Promise<void>) | null): void {
    this._rotateCredentials = fn;
  }

  /**
   * Rotate credentials if a rotation is pending. Idempotent and safe to
   * call on any stop; the `rotationPending` flag (set on relay-active
   * entry, persisted to tunnel.json) gates it so non-relay stops are
   * no-ops. Returns true iff a rotation was actually performed.
   *
   * Called from:
   *   - `stop()` — relay-active → idle (operator stop / shutdown).
   *   - boot-recovery (`recoverPendingRotation`) — the agent died
   *     mid-relay-episode; rotate before the server accepts traffic.
   *   - self-heal switch-back (PR 8) — relay-active → active.
   *
   * Mandatory-rotation invariant (spec Part 6): the flag is cleared
   * ONLY after the rotator resolves, so a crash mid-rotation re-attempts
   * on next boot. If no rotator is wired (misconfiguration), we log
   * loudly and clear the flag rather than loop forever — but this path
   * should never happen in a correctly-wired server.
   */
  async runCredentialRotation(reason: string): Promise<boolean> {
    if (!this.lifecycle.rotationPending) return false;

    if (!this._rotateCredentials) {
      console.warn(
        `[tunnel] credential rotation pending (${reason}) but no rotator ` +
        `is wired — clearing the flag to avoid a permanent-pending loop. ` +
        `This is a wiring bug: PIN/authToken were NOT rotated.`,
      );
      this.lifecycle.setRotationPending(false);
      this.persist();
      return false;
    }

    try {
      await this._rotateCredentials();
    } catch (err) {
      // Rotation failed — leave rotationPending set so the next stop or
      // next boot retries. Do NOT clear the flag on failure.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[tunnel] credential rotation (${reason}) failed: ${msg} — will retry`);
      this.emit('rotation-failed', { reason, error: err });
      return false;
    }

    this.lifecycle.setRotationPending(false);
    this.persist();
    this.emit('credentials-rotated', { reason });
    return true;
  }

  /**
   * Boot-recovery: if the persisted state shows a relay episode was in
   * flight when the agent last died (rotationPending restored from
   * tunnel.json), rotate BEFORE the server accepts any API traffic.
   * server.ts awaits this before `server.start()`.
   */
  async recoverPendingRotation(): Promise<boolean> {
    return this.runCredentialRotation('boot-recovery');
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
    // owner explicitly grants consent. Gated by config (spec Part 4):
    // relaysEnabled=false drops Tier-2 entirely, and relayProviders
    // selects which relays are offered (default ['localtunnel']; 'bore'
    // is opt-in). LocaltunnelProvider's isAvailable() also returns false
    // when the `localtunnel` npm package isn't installed, so agents
    // without the dep see the slot silently skipped.
    if (config.relaysEnabled !== false) {
      const relays = config.relayProviders ?? ['localtunnel'];
      if (relays.includes('localtunnel')) {
        pool.push(new LocaltunnelProvider({ port: config.port }));
      }
      // 'bore' has no checksum-verified installer yet (spec Part 7), so it
      // is not constructed here even when listed; it joins the pool when a
      // BoreProvider lands in a later PR.
    }
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
    // Config gate (spec Part 4): relaysEnabled=false or relayConsent='never'
    // means Cloudflare-only — never offer a Tier-2 relay, go straight to
    // exhausted + background retry.
    const relaysAllowed = this.config.relaysEnabled !== false && this.config.relayConsent !== 'never';
    const candidateTier2 = relaysAllowed ? await this.findAvailableTier2() : null;
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

  // ── Self-heal (Part 5): switch back to Tier-1 when it recovers ──────

  /** First Tier-1 provider (Cloudflare named/quick), or null. */
  private firstTier1Provider(): TunnelProvider | null {
    for (const p of this.providers) {
      if (p.tier === 1) return p;
    }
    return null;
  }

  private startSelfHealProbe(): void {
    if (this._selfHealTimer) return;
    this._selfHealSuccesses = 0;
    this._selfHealTimer = setInterval(() => {
      void this.runSelfHealCheck().catch(() => { /* probe is best-effort */ });
    }, SELF_HEAL_PROBE_INTERVAL_MS);
    this._selfHealTimer.unref?.();
  }

  private stopSelfHealProbe(): void {
    if (this._selfHealTimer) {
      clearInterval(this._selfHealTimer);
      this._selfHealTimer = null;
    }
    this._selfHealSuccesses = 0;
  }

  /**
   * One self-heal probe tick. Public so tests can drive the stability
   * gate deterministically (no real multi-minute waits — the spec's
   * Part 8 testability requirement). The production timer calls this on
   * a fixed cadence.
   *
   * Each tick attempts to establish a Tier-1 tunnel and verify
   * reachability. Consecutive successes accrue; a single failure resets
   * the counter (so Cloudflare flapping never triggers a premature
   * switch). On the Nth consecutive success the freshly-verified handle
   * is PROMOTED via an atomic new-then-old switch-back — so the public
   * URL never points at a dead tunnel mid-switch.
   *
   * Returns the outcome for assertions/telemetry.
   */
  async runSelfHealCheck(): Promise<'switched' | 'progress' | 'reset' | 'inactive'> {
    if (this._stopped || this.lifecycle.state !== 'relay-active' || this._switchingBack) {
      if (this.lifecycle.state !== 'relay-active') this.stopSelfHealProbe();
      return 'inactive';
    }
    const tier1 = this.firstTier1Provider();
    if (!tier1) return 'inactive';

    let handle: TunnelProviderHandle | null = null;
    let ok = false;
    try {
      handle = await tier1.start(this.config.port);
      ok = await this.probeReachability(handle.url).catch(() => false);
    } catch {
      ok = false;
    }

    if (!ok) {
      if (handle) { try { await handle.stop(); } catch { /* best effort */ } }
      this._selfHealSuccesses = 0;
      return 'reset';
    }

    this._selfHealSuccesses += 1;
    if (this._selfHealSuccesses >= SELF_HEAL_REQUIRED_SUCCESSES && handle) {
      // Promote THIS already-up, already-verified handle — no second start.
      const did = await this.performSwitchBack(tier1, handle);
      return did ? 'switched' : 'reset';
    }

    // Not enough consecutive successes yet — release the throwaway probe
    // tunnel; the relay keeps serving.
    if (handle) { try { await handle.stop(); } catch { /* best effort */ } }
    return 'progress';
  }

  /**
   * Atomic switch-back from a Tier-2 relay to a recovered Tier-1 tunnel.
   * `newHandle` is already started AND reachability-verified by the
   * probe. Order (spec Part 5): swap `_state.url` to the new URL in one
   * synchronous assignment and emit 'url' BEFORE tearing the relay down,
   * so getExternalUrl() never returns a dead URL. Relay teardown is the
   * provider's stop() (forceful escalation is the provider contract).
   * On reaching `active`, the relay episode has terminally ended → rotate
   * credentials (PR 7), since the relay operator saw the old PIN/links.
   */
  private async performSwitchBack(provider: TunnelProvider, newHandle: TunnelProviderHandle): Promise<boolean> {
    if (this._switchingBack) return false;
    const entryState: TunnelLifecycleState = this.lifecycle.state;
    if (entryState !== 'relay-active') {
      try { await newHandle.stop(); } catch { /* best effort */ }
      return false;
    }
    this._switchingBack = true;
    const oldHandle = this.currentHandle;
    const oldProviderName = this.currentProviderName;
    const oldUrl = this._legacyState.url;
    try {
      this.lifecycle.transition('relay-active', 'self-healing', { activeProvider: null });

      // new-then-old: the new Tier-1 handle is already up + verified.
      this.currentHandle = newHandle;
      this.currentProviderName = provider.name;
      this._legacyState.url = newHandle.url;
      this._legacyState.startedAt = new Date().toISOString();
      this.emit('url', newHandle.url);

      // Now tear down the relay — confirm it's gone before declaring
      // recovery, so private traffic can't keep flowing through the third
      // party.
      if (oldHandle && oldHandle !== newHandle) {
        try { await oldHandle.stop(); } catch { /* provider escalates SIGINT→SIGKILL internally */ }
      }

      this.lifecycle.transition('self-healing', 'active', {
        activeProvider: provider.name,
        lastFailureReason: null,
      });
      this.persist();
      this.stopSelfHealProbe();
      this.emit('self-healed', { provider: provider.name, url: newHandle.url });

      // Terminal exit from the relay episode → mandatory credential
      // rotation (rotationPending was set on relay-active entry).
      await this.runCredentialRotation('self-heal');
      return true;
    } catch {
      // Switch failed — try to stay on the relay rather than go dark.
      this.currentHandle = oldHandle;
      this.currentProviderName = oldProviderName;
      this._legacyState.url = oldUrl;
      const stateNow: TunnelLifecycleState = this.lifecycle.state;
      if (stateNow === 'self-healing') {
        try {
          this.lifecycle.transition('self-healing', 'relay-active', {
            activeProvider: oldProviderName,
          });
        } catch { /* best effort */ }
      }
      this._selfHealSuccesses = 0;
      try { await newHandle.stop(); } catch { /* best effort */ }
      return false;
    } finally {
      this._switchingBack = false;
    }
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
    const timeoutMs = this.config.consentTimeoutMs ?? CONSENT_TIMEOUT_MS;
    const timer = setTimeout(() => {
      this.recordConsentDecline(nonce, 'timeout');
    }, timeoutMs);
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
      // Begin watching for Tier-1 recovery so we can switch back off the
      // third-party relay automatically (spec Part 5).
      this.startSelfHealProbe();
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

  /**
   * HTTP probe through the public URL — confirms the link actually
   * serves. Retries across a bounded grace window (see
   * REACHABILITY_RETRY_DELAYS_MS) so the edge-propagation 530s that
   * follow connector registration don't get a healthy tunnel killed.
   * A shutdown mid-window bails immediately instead of sleeping it out.
   */
  private async probeReachability(url: string): Promise<boolean> {
    const delays = this.reachabilityRetryDelaysMs;
    for (let attempt = 0; ; attempt++) {
      if (await this.probeReachabilityOnce(url)) return true;
      if (this._stopped) return false; // shutting down — don't wait out the grace window
      const delayMs = delays[attempt];
      if (delayMs === undefined) return false; // grace window exhausted — genuinely unreachable
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  /** One probe attempt — a non-ok response or any fetch error reads as "not reachable yet". */
  private async probeReachabilityOnce(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
      const res = await this.fetcher(`${url.replace(/\/$/, '')}/health`, {
        signal: controller.signal,
      });
      clearTimeout(t);
      return res.ok;
    } catch {
      // @silent-fallback-ok: probe failure IS the signal — `false` is the
      // datum the retry loop and callers act on (recordAttempt with
      // reachability-failed); nothing is swallowed.
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
