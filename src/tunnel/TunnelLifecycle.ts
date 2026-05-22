/**
 * TunnelLifecycle — single-owner state machine for the tunnel layer.
 *
 * Per spec specs/dev-infrastructure/tunnel-failure-resilience.md Part 2.
 *
 * This module owns the detect → attempt → fall-back → notify → self-heal
 * lifecycle. The existing server.ts startup-retry ladder, background-
 * retry ladder, and Lifeline failure message are retired in favor of
 * routing all retry through here.
 *
 * Design properties:
 *   - Single-writer transitions: every state change goes through
 *     `transition(expectedFrom, to)`, a compare-and-swap that REJECTS
 *     any transition whose expectedFrom doesn't match the current
 *     state. This prevents the error+exit double-handler race that the
 *     concurrency reviewer surfaced.
 *   - Monotonic epoch: each guarded transition carries a `transition.id`
 *     for downstream notification dedup. Notifications are emitted ONLY
 *     from inside the guarded mutation, tagged with the epoch.
 *   - Episode model: each contiguous failure→recovery cycle is an
 *     `episode` with its own id and one-time consent nonce. All consent
 *     state binds to (episodeId, provider, ownerId, chatId, messageId,
 *     issuedAt).
 *
 * This module is provider-agnostic and notification-channel-agnostic.
 * Providers are injected as a pool; the notifier is injected as a sink.
 * Both responsibilities live OUTSIDE this module per the spec's
 * separation of concerns.
 */

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { TunnelProvider, ProviderFailureReason, ProviderName } from './TunnelProvider.js';

// ── State model ─────────────────────────────────────────────────────

export type TunnelLifecycleState =
  /** No tunnel running and not currently trying. */
  | 'idle'
  /** A start attempt is in flight on some provider. */
  | 'starting'
  /** A provider is up; URL is being served. */
  | 'active'
  /** A Tier-1 provider failed and we are backing off / trying the next one. */
  | 'retrying'
  /** All Tier-1 providers exhausted; awaiting owner consent for a Tier-2 relay. */
  | 'awaiting-consent'
  /** A Tier-2 relay provider is up; URL being served via the relay. */
  | 'relay-active'
  /** Cloudflare recovery probe verifying Tier-1 is back; switch-back imminent. */
  | 'self-healing'
  /** All providers exhausted (or consent declined); background self-heal is the only retry mechanism. */
  | 'exhausted';

export interface Episode {
  /** Stable per-failure-cycle id. Resets each time the manager enters `starting` from `idle`/`active`. */
  episodeId: string;
  /** When this episode began (ISO timestamp). */
  startedAt: string;
  /** Number of Tier-1 providers attempted in this episode. */
  tier1Attempts: number;
  /** Last classified failure reason (the most recent provider failure). */
  lastFailureReason: ProviderFailureReason | null;
  /** Which provider names have been attempted in this episode (in order). */
  attemptedProviders: ProviderName[];
}

export interface ConsentRecord {
  /** Tied to the episode that issued the prompt. */
  episodeId: string;
  /** Which Tier-2 provider the consent authorizes. Single-use, per-provider. */
  provider: 'localtunnel' | 'bore';
  /** Owner principal id (Telegram user id). Non-owner clicks are rejected. */
  ownerId: string;
  /** Telegram chat the consent was issued in (DM chat id). */
  chatId: string;
  /** Telegram message id of the inline-button prompt. */
  messageId: string;
  /** 128-bit CSPRNG nonce carried in callback_data. Atomic compare-and-delete on use. */
  nonce: string;
  /** Issued-at (ms epoch). Combined with consentTimeoutMs to expire. */
  issuedAt: number;
}

export interface ConsentCooldownState {
  /** Count of consecutive declines/timeouts feeding the exponential backoff. */
  consecutiveRefusals: number;
  /** When the cooldown was last extended (ms epoch). */
  lastExtendedAt: number;
  /** Until when the cooldown is active (ms epoch). 0 = no cooldown. */
  activeUntil: number;
}

export interface PersistedTunnelState {
  /** Schema version for safe future migrations. */
  version: 1;
  /** Last observed state. Used by the boot-recovery path. */
  lastState: TunnelLifecycleState;
  /** Last active URL (if any) — for diagnostic only; never trusted as live. */
  lastUrl: string | null;
  /** Name of the provider that was active when state was persisted. */
  activeProvider: ProviderName | null;
  /**
   * Set to true the moment a Tier-2 relay-active state is entered. Cleared
   * only after `authToken`/PIN rotation succeeds. If the agent crashes
   * mid-relay-episode, this flag tells the boot-recovery path "rotate
   * BEFORE accepting any API traffic on the new boot" — per spec Part 6.
   */
  rotationPending: boolean;
  /** Cross-episode consent cooldown counter. */
  consentCooldown: ConsentCooldownState;
  /** Current episode, if any. */
  episode: Episode | null;
  /** Saved-at timestamp (ISO). */
  savedAt: string;
}

// ── Events ───────────────────────────────────────────────────────────

export interface TransitionEvent {
  /** Monotonic per-manager-instance epoch — never reset. Used by notifiers for dedup. */
  epoch: number;
  /** State BEFORE this transition. */
  from: TunnelLifecycleState;
  /** State AFTER this transition. */
  to: TunnelLifecycleState;
  /** Episode in effect at the time of the transition. */
  episode: Episode | null;
  /** Last classified failure (when relevant). */
  lastFailureReason: ProviderFailureReason | null;
  /** When (ms epoch). */
  at: number;
}

export type TunnelLifecycleEvents = {
  /** Fires on every successful guarded transition. */
  transition: (e: TransitionEvent) => void;
};

// ── Helpers ──────────────────────────────────────────────────────────

/** Classify a provider failure based on the Error's `message`. */
export function classifyFailure(err: unknown): ProviderFailureReason {
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  if (msg.startsWith('rate-limited') || msg.includes('rate limit') || msg.includes('429') || msg.includes('1015')) {
    return 'rate-limited';
  }
  if (msg.startsWith('binary-missing') || msg.includes('not installed') || msg.includes('enoent')) {
    return 'binary-missing';
  }
  if (msg.startsWith('network') || msg.includes('dns') || msg.includes('econnrefused') || msg.includes('eai_again')) {
    return 'network';
  }
  if (msg.startsWith('timeout') || msg.includes('timed out')) {
    return 'timeout';
  }
  if (msg.startsWith('reachability-failed')) {
    return 'reachability-failed';
  }
  if (msg.includes('process-exit') || msg.includes('exited')) {
    return 'process-exit';
  }
  return 'unknown';
}

/** Generate a fresh 128-bit CSPRNG nonce as hex (32 chars). */
export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Generate a fresh episode id (16-byte hex, no PII). */
export function generateEpisodeId(): string {
  return crypto.randomBytes(8).toString('hex');
}

// ── Single-writer state machine ─────────────────────────────────────

/** Valid transitions per the spec's state machine. */
const VALID_TRANSITIONS: ReadonlyMap<TunnelLifecycleState, ReadonlySet<TunnelLifecycleState>> = new Map([
  ['idle',             new Set<TunnelLifecycleState>(['starting'])],
  ['starting',         new Set<TunnelLifecycleState>(['active', 'retrying', 'awaiting-consent', 'exhausted', 'idle'])],
  ['active',           new Set<TunnelLifecycleState>(['retrying', 'idle'])],
  ['retrying',         new Set<TunnelLifecycleState>(['active', 'starting', 'awaiting-consent', 'exhausted', 'idle'])],
  ['awaiting-consent', new Set<TunnelLifecycleState>(['relay-active', 'starting', 'active', 'exhausted', 'idle'])],
  ['relay-active',     new Set<TunnelLifecycleState>(['self-healing', 'idle', 'exhausted'])],
  ['self-healing',     new Set<TunnelLifecycleState>(['active', 'relay-active', 'exhausted', 'idle'])],
  ['exhausted',        new Set<TunnelLifecycleState>(['self-healing', 'starting', 'idle'])],
]);

export function isValidTransition(from: TunnelLifecycleState, to: TunnelLifecycleState): boolean {
  if (from === to) return false;
  const allowed = VALID_TRANSITIONS.get(from);
  return !!allowed && allowed.has(to);
}

export class TunnelLifecycle extends EventEmitter {
  private _state: TunnelLifecycleState = 'idle';
  private _epoch = 0;
  private _episode: Episode | null = null;
  private _lastFailureReason: ProviderFailureReason | null = null;
  private _activeProvider: ProviderName | null = null;
  private _consentCooldown: ConsentCooldownState = {
    consecutiveRefusals: 0,
    lastExtendedAt: 0,
    activeUntil: 0,
  };
  private _rotationPending = false;

  get state(): TunnelLifecycleState { return this._state; }
  get epoch(): number { return this._epoch; }
  get episode(): Episode | null { return this._episode; }
  get activeProvider(): ProviderName | null { return this._activeProvider; }
  get rotationPending(): boolean { return this._rotationPending; }
  get consentCooldown(): ConsentCooldownState { return { ...this._consentCooldown }; }
  get lastFailureReason(): ProviderFailureReason | null { return this._lastFailureReason; }

  /**
   * Compare-and-swap transition. Returns true if the transition was
   * accepted; false if the current state didn't match `expectedFrom`
   * (caller MUST treat false as a race — the lifecycle moved
   * underneath them — and re-read state).
   *
   * `to` must be reachable from `expectedFrom` per VALID_TRANSITIONS;
   * an invalid pair throws (programming error, not a runtime race).
   */
  transition(expectedFrom: TunnelLifecycleState, to: TunnelLifecycleState, ctx?: {
    episode?: Episode | null;
    activeProvider?: ProviderName | null;
    lastFailureReason?: ProviderFailureReason | null;
    rotationPending?: boolean;
  }): boolean {
    if (this._state !== expectedFrom) {
      return false; // CAS lost
    }
    if (!isValidTransition(expectedFrom, to)) {
      throw new Error(`invalid transition ${expectedFrom} → ${to}`);
    }
    // Apply mutation atomically (Node is single-threaded; this synchronous
    // block IS the critical section).
    this._state = to;
    this._epoch += 1;
    if (ctx?.episode !== undefined) this._episode = ctx.episode;
    if (ctx?.activeProvider !== undefined) this._activeProvider = ctx.activeProvider;
    if (ctx?.lastFailureReason !== undefined) this._lastFailureReason = ctx.lastFailureReason;
    if (ctx?.rotationPending !== undefined) this._rotationPending = ctx.rotationPending;

    const event: TransitionEvent = {
      epoch: this._epoch,
      from: expectedFrom,
      to,
      episode: this._episode,
      lastFailureReason: this._lastFailureReason,
      at: Date.now(),
    };
    this.emit('transition', event);
    return true;
  }

  /** Begin a new failure-recovery episode. Called when entering `starting` from `idle` or `active`. */
  startEpisode(): Episode {
    const ep: Episode = {
      episodeId: generateEpisodeId(),
      startedAt: new Date().toISOString(),
      tier1Attempts: 0,
      lastFailureReason: null,
      attemptedProviders: [],
    };
    this._episode = ep;
    return ep;
  }

  /** Close out the current episode (called when returning to `active` or `idle`). */
  endEpisode(): void {
    this._episode = null;
  }

  /** Record a Tier-1 provider failure attempt against the current episode. */
  recordAttempt(provider: ProviderName, reason: ProviderFailureReason): void {
    if (!this._episode) return;
    this._episode.tier1Attempts += 1;
    this._episode.lastFailureReason = reason;
    this._episode.attemptedProviders.push(provider);
    this._lastFailureReason = reason;
  }

  /** Apply an exponential consent cooldown after a decline / timeout. */
  recordConsentRefusal(): ConsentCooldownState {
    this._consentCooldown.consecutiveRefusals += 1;
    const n = this._consentCooldown.consecutiveRefusals;
    // 1h → 4h → 24h, then 24h forever
    const COOLDOWNS_MS = [60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000];
    const idx = Math.min(n - 1, COOLDOWNS_MS.length - 1);
    const ms = COOLDOWNS_MS[idx] ?? COOLDOWNS_MS[COOLDOWNS_MS.length - 1];
    if (ms === undefined) throw new Error('unreachable: cooldown table empty');
    this._consentCooldown.lastExtendedAt = Date.now();
    this._consentCooldown.activeUntil = Date.now() + ms;
    return this.consentCooldown;
  }

  /** Clear cooldown — called on explicit owner opt-in or fresh post-cooldown episode. */
  clearConsentCooldown(): void {
    this._consentCooldown = { consecutiveRefusals: 0, lastExtendedAt: 0, activeUntil: 0 };
  }

  /** True if the consent prompt is currently suppressed by the cooldown. */
  isConsentSuppressed(now = Date.now()): boolean {
    return this._consentCooldown.activeUntil > now;
  }

  /** Snapshot current state for persistence to tunnel.json. */
  snapshot(): PersistedTunnelState {
    return {
      version: 1,
      lastState: this._state,
      lastUrl: null, // populated by the manager that knows the URL
      activeProvider: this._activeProvider,
      rotationPending: this._rotationPending,
      consentCooldown: this.consentCooldown,
      episode: this._episode ? { ...this._episode, attemptedProviders: [...this._episode.attemptedProviders] } : null,
      savedAt: new Date().toISOString(),
    };
  }

  /**
   * Restore from a persisted snapshot. Called at boot ONLY for the
   * cooldown counter + rotationPending flag — the state itself is NOT
   * resumed (every boot starts at `idle` and re-enters `starting` from
   * scratch). The rotationPending flag triggers a rotation-before-
   * traffic in the boot-recovery path; rotation clears the flag.
   */
  restoreFrom(snapshot: PersistedTunnelState): void {
    this._consentCooldown = { ...snapshot.consentCooldown };
    this._rotationPending = snapshot.rotationPending;
    // _state stays 'idle' by design — boot recovery rotation runs before
    // the new lifecycle starts.
  }

  /** Set the rotation-pending flag (entered on `relay-active`; cleared after rotation). */
  setRotationPending(value: boolean): void {
    this._rotationPending = value;
  }

  /** Used by callers (manager) that need to validate a consent-reply against the active state. */
  isAwaitingConsent(): boolean {
    return this._state === 'awaiting-consent';
  }
}
