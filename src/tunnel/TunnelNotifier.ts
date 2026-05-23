/**
 * TunnelNotifier — two-channel routing of tunnel lifecycle events to
 * the user.
 *
 * Per spec specs/dev-infrastructure/tunnel-failure-resilience.md Part 3.
 *
 * Strict channel separation (the GPT external review's CRITICAL finding):
 *   - GROUP topic (Dashboard / Lifeline fallback / General fallback):
 *     status text only. NEVER the URL, NEVER the PIN, NEVER a signed
 *     view link. Anyone in the group can read those, which would defeat
 *     the owner-only consent gate.
 *   - OWNER DM (private bot chat with the owner principal): the actual
 *     URL + PIN + signed view links. The only credential-bearing channel.
 *
 * Class-based throttling (verification finding V2 + GPT finding #5):
 *   - action-required: NEVER throttled within an episode. Cross-episode
 *     cooldown applies (consent prompts) but the lifecycle decides that,
 *     not the notifier.
 *   - state-change: light — at most one per (episode, state) pair, and
 *     at most one per 15 minutes within an episode on re-entry of the
 *     same state.
 *   - noise: heavy — flapping episodes collapse into one "tunnel
 *     unstable" message, suppressed for the rest of the episode.
 *
 * Dedup by transition epoch (the lifecycle's monotonic counter): the
 * notifier never emits twice for the same epoch, even if the same
 * event fires through multiple listeners.
 */

import type { TransitionEvent, TunnelLifecycleState } from './TunnelLifecycle.js';
import type { ProviderName, ProviderFailureReason } from './TunnelProvider.js';

/** Message class — drives throttling policy. */
export type NotificationClass = 'action-required' | 'state-change' | 'noise';

/** Channel — drives credential-handling policy. */
export type NotificationChannel = 'group' | 'owner-dm';

export interface NotifierMessage {
  channel: NotificationChannel;
  class: NotificationClass;
  text: string;
  /** Episode this message belongs to (for cross-episode dedup). */
  episodeId: string | null;
  /** Transition epoch — never emit twice for the same epoch. */
  epoch: number;
}

export interface NotifierSink {
  /** Send a status-text message to the group topic (Dashboard preferred, Lifeline/General fallback). */
  sendGroup(text: string): Promise<void>;
  /** Send a credential-bearing message to the owner's private bot DM. */
  sendOwnerDM(text: string): Promise<void>;
}

export interface NotifierClock {
  now(): number;
}

/**
 * Credential snapshot the notifier substitutes into owner-DM messages
 * at compose time. Returned by a `credentialProvider` callback so the
 * notifier never holds stale credentials in its own state.
 */
export interface CredentialSnapshot {
  /** Current public URL (null when no tunnel is active). */
  url: string | null;
  /** Current dashboard PIN (undefined when not configured). */
  pin?: string;
}

export interface TunnelNotifierOptions {
  sink: NotifierSink;
  clock?: NotifierClock;
  /**
   * Returns a fresh credential snapshot. Called each time the notifier
   * composes an owner-DM message that needs URL/PIN substitution.
   * Optional — when absent, owner-DM messages render without
   * credentials (the user gets the explanatory text but no link). This
   * is the back-compat path for tests that don't wire a credential
   * provider.
   */
  credentialProvider?: () => CredentialSnapshot;
  /** Within-episode same-state re-entry throttle (default 15 min). */
  stateChangeMinIntervalMs?: number;
  /** Flap threshold — N connect/drop cycles within an episode → noise-collapse. */
  flapThreshold?: number;
  /**
   * When true, the notifier does NOT emit the owner-DM consent PROMPT
   * for the awaiting-consent transition (the group pointer still
   * fires). Set by the manager when an adapter capable of sending the
   * button-bearing prompt is attached — the manager sends that prompt
   * itself (with the nonce + inline keyboard) so the notifier's plain-
   * text version would be a duplicate.
   */
  suppressConsentDM?: boolean;
}

export class TunnelNotifier {
  private readonly sink: NotifierSink;
  private readonly clock: NotifierClock;
  private readonly credentialProvider: (() => CredentialSnapshot) | undefined;
  private readonly suppressConsentDM: boolean;
  private readonly stateChangeMinIntervalMs: number;
  private readonly flapThreshold: number;

  // Dedup state. The lifecycle's epoch is monotonic per manager instance,
  // so once we've emitted for epoch N we never re-emit for N.
  private lastEmittedEpoch = -1;

  // Per-episode bookkeeping.
  private currentEpisodeId: string | null = null;
  /** Last-emitted timestamps keyed by `<state>::<channel>` so the group
   * pointer and the owner-DM credential delivery are throttled
   * independently — otherwise the DM gets swallowed after the group
   * pointer fires for the same state-change. */
  private lastEmittedAt: Map<string, number> = new Map();
  /** Track noise-collapse emission per episode. Once emitted, further
   * noise messages in the same episode are suppressed. */
  private noiseEmittedThisEpisode = false;
  private flapCycles = 0;
  private flapCollapsed = false;

  constructor(opts: TunnelNotifierOptions) {
    this.sink = opts.sink;
    this.clock = opts.clock ?? { now: () => Date.now() };
    this.credentialProvider = opts.credentialProvider;
    this.suppressConsentDM = opts.suppressConsentDM ?? false;
    this.stateChangeMinIntervalMs = opts.stateChangeMinIntervalMs ?? 15 * 60_000;
    this.flapThreshold = opts.flapThreshold ?? 3;
  }

  /**
   * Drive the notifier from a lifecycle transition. Idempotent on the
   * transition epoch — repeated calls with the same epoch are no-ops.
   */
  async onTransition(e: TransitionEvent): Promise<void> {
    // Dedup on epoch FIRST: never emit twice for the same epoch even if
    // the listener fires multiple times.
    if (e.epoch <= this.lastEmittedEpoch) return;
    this.lastEmittedEpoch = e.epoch;

    // Reset per-episode bookkeeping when the episode id changes.
    const newEpisodeId = e.episode?.episodeId ?? null;
    if (newEpisodeId !== this.currentEpisodeId) {
      this.currentEpisodeId = newEpisodeId;
      this.lastEmittedAt = new Map();
      this.noiseEmittedThisEpisode = false;
      this.flapCycles = 0;
      this.flapCollapsed = false;
    }

    // Build the message for THIS transition (if any).
    const messages = this.composeMessages(e);

    for (const m of messages) {
      const allowed = this.allow(m, e.to);
      if (!allowed) continue;
      try {
        if (m.channel === 'group') {
          await this.sink.sendGroup(m.text);
        } else {
          await this.sink.sendOwnerDM(m.text);
        }
        // Update bookkeeping AFTER successful send (cheap-best-effort).
        const key = throttleKey(e.to, m.channel);
        this.lastEmittedAt.set(key, this.clock.now());
        if (m.class === 'noise') {
          this.noiseEmittedThisEpisode = true;
        }
      } catch {
        // Never throw into the tunnel path — preserves existing
        // .catch(() => {}) semantics from server.ts.
      }
    }
  }

  /**
   * Compose the user-facing messages for a transition. May return zero,
   * one, or two messages (some transitions emit to BOTH channels, e.g.
   * "back online — link in your DM" + DM with the URL).
   *
   * The DM credential payload is filled in by the manager via a callback
   * (the notifier itself doesn't know URLs/PINs); for now the DM strings
   * are placeholders that the manager substitutes before send. Future:
   * extend onTransition signature to accept the credential payload.
   */
  private composeMessages(e: TransitionEvent): NotifierMessage[] {
    const ep = e.episode?.episodeId ?? null;
    const reason = e.lastFailureReason;

    const messages: NotifierMessage[] = [];
    switch (e.to) {
      case 'retrying':
        // First Tier-1 failure — describe the cause, no DM.
        messages.push({
          channel: 'group',
          class: 'state-change',
          text: `Couldn't reach the usual Cloudflare tunnel${reasonSuffix(reason)}; still retrying.`,
          episodeId: ep,
          epoch: e.epoch,
        });
        // Track for flap detection.
        this.flapCycles += 1;
        if (this.flapCycles >= this.flapThreshold && !this.flapCollapsed) {
          this.flapCollapsed = true;
          messages.push({
            channel: 'group',
            class: 'noise',
            text: `Tunnel is unstable right now — still working on it. I'll stop re-pinging this until something changes.`,
            episodeId: ep,
            epoch: e.epoch,
          });
        }
        break;

      case 'active':
        if (e.from === 'self-healing' || e.from === 'relay-active') {
          // Self-healed back to Tier 1.
          messages.push({
            channel: 'group',
            class: 'state-change',
            text: `Your permanent link is back. New link in your DM.`,
            episodeId: ep,
            epoch: e.epoch,
          });
          messages.push({
            channel: 'owner-dm',
            class: 'state-change',
            text: this.composeRestoredDM(),
            episodeId: ep,
            epoch: e.epoch,
          });
        } else if (e.from === 'retrying') {
          // Cloudflare came back during retry.
          messages.push({
            channel: 'group',
            class: 'state-change',
            text: `Back online. Link in your DM.`,
            episodeId: ep,
            epoch: e.epoch,
          });
          messages.push({
            channel: 'owner-dm',
            class: 'state-change',
            text: this.composeRecoveredDM(),
            episodeId: ep,
            epoch: e.epoch,
          });
        }
        // Other 'active' arrivals (initial startup) are non-events from the user's perspective.
        break;

      case 'awaiting-consent':
        // Consent prompt: owner DM only, brief group pointer.
        messages.push({
          channel: 'group',
          class: 'state-change',
          text: `Cloudflare is down. I've messaged you in DM about a possible backup.`,
          episodeId: ep,
          epoch: e.epoch,
        });
        if (!this.suppressConsentDM) {
          messages.push({
            channel: 'owner-dm',
            class: 'action-required',
            text: this.composeConsentPromptDM(),
            episodeId: ep,
            epoch: e.epoch,
          });
        }
        break;

      case 'relay-active':
        // A Tier-2 relay is up: group pointer + DM with URL + rotated PIN.
        messages.push({
          channel: 'group',
          class: 'state-change',
          text: `Backup tunnel is up. New link in your DM.`,
          episodeId: ep,
          epoch: e.epoch,
        });
        messages.push({
          channel: 'owner-dm',
          class: 'state-change',
          text: this.composeRelayActiveDM(),
          episodeId: ep,
          epoch: e.epoch,
        });
        break;

      case 'exhausted':
        messages.push({
          channel: 'group',
          class: 'state-change',
          text: `All tunnel options are unavailable right now. I'll keep retrying Cloudflare in the background and switch back the moment it recovers — no restart needed.`,
          episodeId: ep,
          epoch: e.epoch,
        });
        break;

      case 'self-healing':
        // No user-visible message at entry. The "permanent link is back"
        // emits on self-healing → active (above).
        break;

      // No notification on idle / starting transitions.
      case 'idle':
      case 'starting':
        break;
    }
    return messages;
  }

  /**
   * Throttle decision per spec Part 3:
   *   - action-required: NEVER throttled within an episode.
   *   - state-change: at most one per (episode, state, channel) combo
   *     within `stateChangeMinIntervalMs`. The channel scoping is
   *     load-bearing: the group pointer and the owner-DM credential
   *     delivery are TWO messages for the same state-change; they must
   *     both emit, not throttle each other out.
   *   - noise: emits at most once per episode. The flap-collapse
   *     message goes out the first time the threshold is crossed; all
   *     subsequent noise in the same episode is suppressed.
   */
  private allow(m: NotifierMessage, toState: TunnelLifecycleState): boolean {
    if (m.class === 'action-required') return true;
    if (m.class === 'noise') {
      return !this.noiseEmittedThisEpisode;
    }
    // state-change: keyed per (state, channel).
    const key = throttleKey(toState, m.channel);
    const lastAt = this.lastEmittedAt.get(key);
    if (lastAt === undefined) return true;
    return this.clock.now() - lastAt >= this.stateChangeMinIntervalMs;
  }

  // ── Owner-DM message composers ───────────────────────────────────

  /** Snapshot of credentials at compose time (safely degrades when no provider). */
  private creds(): CredentialSnapshot {
    if (!this.credentialProvider) return { url: null };
    try {
      return this.credentialProvider();
    } catch {
      return { url: null };
    }
  }

  private renderLink(): string {
    const { url, pin } = this.creds();
    if (!url) return `(link not available yet — I'll send it as soon as the tunnel is up)`;
    if (pin) return `Link: ${url}\nPIN: ${pin}`;
    return `Link: ${url}`;
  }

  private composeRecoveredDM(): string {
    return `Cloudflare is back. Your dashboard link:\n\n${this.renderLink()}`;
  }

  private composeRestoredDM(): string {
    return `Your permanent Cloudflare link is back — switched off the backup. New link:\n\n${this.renderLink()}\n\nIf you had your dashboard open, you may need to re-enter the PIN.`;
  }

  private composeRelayActiveDM(): string {
    return `Backup tunnel is up and serving your dashboard. New link below.\n\nHeads up: this routes through a third-party server, so your dashboard traffic is briefly going through their machines while Cloudflare is down. The agent will switch you back to your normal link automatically as soon as Cloudflare recovers.\n\n${this.renderLink()}`;
  }

  private composeConsentPromptDM(): string {
    return `Cloudflare is unavailable and I can't get you a dashboard link through the usual path.\n\nI can try a backup that routes through a third-party server. This means your dashboard PIN and any private view links would briefly be visible to whoever operates that backup while it's in use — and your auth token will be rotated after the backup is no longer needed, which will sign you out of any open dashboard tabs and invalidate any previously-shared private view links.\n\nReply "yes, use a backup" to approve, or "no" to keep waiting for Cloudflare. If you don't reply, I'll keep waiting for Cloudflare and won't use a backup.`;
  }
}

function throttleKey(state: TunnelLifecycleState, channel: NotificationChannel): string {
  return `${state}::${channel}`;
}

function reasonSuffix(reason: ProviderFailureReason | null): string {
  switch (reason) {
    case 'rate-limited': return ' (Cloudflare is rate-limiting us)';
    case 'binary-missing': return ' (the tunnel software is missing)';
    case 'network': return ' (network is unreachable)';
    case 'timeout': return ' (it timed out connecting)';
    case 'process-exit': return ' (the tunnel process exited)';
    case 'reachability-failed': return ' (the link did not respond)';
    default: return '';
  }
}

// re-export for callers that want the same name
export type { ProviderName };
