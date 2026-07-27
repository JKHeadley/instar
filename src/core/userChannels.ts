/**
 * The DIRECT USER channels — the surfaces a human operator actually reads — wired into the same
 * channel registry as the peer channels.
 *
 * WHY THIS EXISTS (2026-07-27, topic 29723). The peer registry answered "which ways of reaching a
 * PEER work right now?". Asked the same question about the operator, the only available answer was
 * `/capabilities` reporting `telegram: { configured: true }`. That is a SETTING, not a STATE: a
 * Telegram whose polling loop died on a 401 four hours ago still reports `configured: true`, because
 * the config file still says so. Reaching for that number during an outage would produce exactly the
 * false confidence the peer registry was built to prevent — one layer over, on the channel that
 * matters most, because it is the one carrying messages to a person.
 *
 * So every probe here reads LIVE RUNTIME STATE and never configuration:
 *
 *   - Telegram exposes `getStatus()`, whose `started` field is `this.polling` — whether the loop is
 *     running NOW — plus `fatalReason` distinguishing a rejected credential from a dropped network.
 *     A comment on its `lastPollError` field says it is kept "so health probes can explain WHY
 *     polling stopped". That consumer was never built. This is it.
 *
 *   - Slack exposes `isConnected()`, which returns `_connected` — cleared on disconnect. It
 *     deliberately does NOT return `started`, which its own source annotates as "ever connected".
 *     `started` is the trap: a workspace that connected once at boot and dropped an hour later
 *     reports `started === true` forever. Liveness must come from the field that clears.
 *
 * ── THE ROUTING JUDGEMENT THIS ENCODES ─────────────────────────────────────────────────────────
 *
 * `whenPreferred` for a user channel is not merely "when the message is for the operator". A user
 * channel is the ONLY surface that shows what the user genuinely experiences — a proxy cannot. That
 * makes deliberately using it a legitimate REASON to choose it, not just a cost to be minimised.
 * The constitution's "Live-User-Channel Proof Before Done" standard rests on exactly this, and the
 * cost side is real and opposite: operator attention is finite and every automated message competes
 * with the ones that matter. Both halves are recorded so a caller can weigh them.
 */

import type { ChannelDefinition, ChannelProbeResult } from './channelRegistry.js';

/**
 * Live Telegram adapter state. Mirrors the subset of `TelegramAdapter.getStatus()` this needs.
 * `null` means the adapter was never constructed on this agent — which is `not-configured`, a
 * distinct verdict from broken, and must never be an omitted row.
 */
export interface TelegramLiveStatus {
  /** `this.polling` — whether the long-poll loop is running RIGHT NOW. Not "was ever started". */
  started: boolean;
  /** Why polling stopped, when it stopped for a reason the adapter could classify. */
  fatalReason: '401' | 'network' | 'no-usable-bot-token' | null;
  /** Consecutive poll errors. Non-zero while still polling is degraded-but-working, not broken. */
  consecutivePollErrors: number;
  /** Last poll error text, if any. */
  lastError: string | null;
  /** ISO instant polling stopped, when it has. */
  stoppedAt: string | null;
}

export interface UserChannelProbeContext {
  /** Live Telegram state, or null when the adapter was never constructed here. */
  telegramStatus: () => TelegramLiveStatus | null;
  /**
   * Whether the Slack socket is up RIGHT NOW (`isConnected()`), or null when no Slack adapter was
   * constructed. Deliberately not `started` — see the module docstring.
   */
  slackConnected: () => boolean | null;
  /** Whether Slack is switched on for this agent at all. Off is not broken. */
  slackEnabled: () => boolean;
}

/**
 * Map live Telegram state onto the registry's vocabulary.
 *
 * Extracted and exported so the mapping is testable WITHOUT constructing an adapter — the mapping is
 * where a wrong verdict would come from, so it is the part that must be pinned.
 */
export function telegramStateFrom(status: TelegramLiveStatus | null): ChannelProbeResult {
  if (status === null) {
    return {
      state: 'not-configured',
      direction: 'none',
      detail: 'no Telegram adapter was constructed on this agent',
    };
  }

  if (status.started) {
    // Still polling. Transient errors do not make it unusable, but hiding them would overstate it.
    const detail =
      status.consecutivePollErrors > 0
        ? `polling now, with ${status.consecutivePollErrors} consecutive poll error(s) — usable but degraded` +
          (status.lastError ? `; last: ${status.lastError.slice(0, 120)}` : '')
        : 'polling now with no consecutive errors';
    return { state: 'working', direction: 'bidirectional', detail };
  }

  // Not polling. WHY it stopped changes what the operator should do about it, so it is not collapsed.
  if (status.fatalReason === '401' || status.fatalReason === 'no-usable-bot-token') {
    return {
      state: 'reachable-no-credential',
      direction: 'none',
      detail:
        status.fatalReason === '401'
          ? 'Telegram answered and REJECTED the bot token (401); the endpoint is reachable but this ' +
            'agent holds no credential it will accept'
          : 'no usable bot token is available, so polling never started',
    };
  }
  if (status.fatalReason === 'network') {
    return {
      state: 'broken',
      direction: 'none',
      detail:
        'polling stopped on a network failure' +
        (status.stoppedAt ? ` at ${status.stoppedAt}` : '') +
        (status.lastError ? `; last: ${status.lastError.slice(0, 120)}` : ''),
    };
  }

  // Stopped, with no reason the adapter could classify. That is genuinely undetermined: it may have
  // been stopped deliberately or have died silently, and this cannot tell which. `unknown` is the
  // honest verdict and is NEVER a synonym for healthy.
  return {
    state: 'unknown',
    direction: 'none',
    detail:
      'the Telegram poll loop is not running and the adapter recorded no reason' +
      (status.stoppedAt ? ` (stopped at ${status.stoppedAt})` : '') +
      '; cannot tell a deliberate stop from a silent death',
  };
}

/** Map live Slack state onto the registry's vocabulary. Exported for the same reason as above. */
export function slackStateFrom(enabled: boolean, connected: boolean | null): ChannelProbeResult {
  if (!enabled) {
    return { state: 'not-configured', direction: 'none', detail: 'Slack is not enabled on this agent' };
  }
  if (connected === null) {
    return {
      state: 'unknown',
      direction: 'none',
      detail:
        'Slack is enabled in config but no adapter was constructed, so its liveness cannot be read; ' +
        'enabled-but-absent is not the same as working',
    };
  }
  if (connected) {
    return {
      state: 'working',
      direction: 'bidirectional',
      detail: 'Socket Mode reports connected right now (this flag clears on disconnect)',
    };
  }
  return {
    state: 'broken',
    direction: 'none',
    detail: 'Slack is enabled but its Socket Mode connection is down right now',
  };
}

export function buildUserChannelDefinitions(ctx: UserChannelProbeContext): ChannelDefinition[] {
  return [
    {
      id: 'user-telegram',
      audience: 'user',
      purpose: "The operator's own Telegram — the surface they actually read.",
      whenPreferred:
        'When the message is FOR the operator. Also the deliberate choice when the point is to see ' +
        'what the user genuinely experiences: no proxy or internal log shows the real thing, so ' +
        'this is the only channel that can prove a user-facing change actually works.',
      cost:
        "Spends the operator's attention, which is the scarcest resource here — every automated " +
        'message competes with the ones that matter. Visible and permanent.',
      probe: async (): Promise<ChannelProbeResult> => telegramStateFrom(ctx.telegramStatus()),
    },
    {
      id: 'user-slack',
      audience: 'user',
      purpose: 'A Slack workspace the operator reads, over Socket Mode.',
      whenPreferred:
        'When the operator works in Slack rather than Telegram, or when the exchange belongs where ' +
        'their team can see it. Same user-experience-proof property as Telegram.',
      cost:
        "Spends the operator's attention, and is visible to anyone else in the channel — so it is " +
        'the wrong surface for anything they would not want their workspace to see.',
      probe: async (): Promise<ChannelProbeResult> =>
        slackStateFrom(ctx.slackEnabled(), ctx.slackConnected()),
    },
  ];
}
