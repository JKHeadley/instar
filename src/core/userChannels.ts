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
  /**
   * WhatsApp's live connection state, or null when no adapter was constructed here.
   *
   * Read from `getStatus().state`, which is a real state machine
   * (`disconnected | connecting | qr-pending | connected | reconnecting | closed`) rather
   * than a boolean — so the row can distinguish "waiting for the operator to scan a QR"
   * from "the link dropped", which a boolean would flatten into one indistinguishable
   * "not working".
   */
  whatsappState: () => WhatsAppLiveState | null;
  /**
   * iMessage's live backend state, or null when no adapter was constructed here.
   *
   * Read from `getConnectionInfo().state`. Deliberately NOT `connectedAt` from the same
   * object: that field is computed as `started ? new Date().toISOString() : undefined`, so
   * it reports the moment you ASKED rather than the moment it connected. A row built on it
   * would look precise and be fiction.
   */
  imessageState: () => IMessageLiveState | null;
}

/** The WhatsApp connection states this module distinguishes. Mirrors the adapter's own union. */
export type WhatsAppLiveState =
  | 'disconnected' | 'connecting' | 'qr-pending' | 'connected' | 'reconnecting' | 'closed';

/** The iMessage backend states this module distinguishes. */
export type IMessageLiveState = 'disconnected' | 'connecting' | 'connected' | string;

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
  //
  // THE SUBJECT MUST BE NAMED, and this row originally failed to name it. What is measured is the
  // SERVER process's adapter. On a lifeline deployment inbound Telegram does not arrive through that
  // adapter at all — a separate lifeline process polls and forwards to the server, which logs
  // "Telegram relay wired (via lifeline callback forwarding)". There, a stopped server poll loop is
  // NORMAL and says nothing about whether messages are arriving.
  //
  // Observed live on 2026-07-27: this row read `unknown` while inbound was perfectly healthy via the
  // lifeline. That is the SAME scope error the threadline-relay row was fixed for hours earlier — a
  // true statement whose subject is unstated, so the reader draws a conclusion about a path that was
  // never measured. Naming the subject is the whole fix; the verdict itself stays `unknown`, because
  // what this CAN see is genuinely undetermined.
  return {
    state: 'unknown',
    direction: 'none',
    detail:
      'the SERVER adapter\'s Telegram poll loop is not running and it recorded no reason' +
      (status.stoppedAt ? ` (stopped at ${status.stoppedAt})` : '') +
      '; cannot tell a deliberate stop from a silent death. NOTE this measures the server adapter only'
      + ' — on a lifeline deployment inbound arrives via the lifeline process, so this alone does not'
      + ' mean messages are not being received',
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

/**
 * WhatsApp's state machine → an honest channel verdict.
 *
 * The interesting case is `qr-pending`: the link is alive and waiting for the operator to
 * scan a code. That is neither working nor broken — it is *reachable, no credential yet*,
 * and it needs a HUMAN action rather than a restart. Reporting it as `broken` would send
 * someone to debug a connection that is behaving exactly as designed.
 *
 * `connecting` / `reconnecting` are genuinely in-flight, so they report `unknown` with the
 * phase named rather than being guessed either way — an answer that will be different in
 * five seconds must not be frozen into a verdict.
 */
export function whatsappStateFrom(state: WhatsAppLiveState | null): ChannelProbeResult {
  if (state === null) {
    return {
      state: 'not-configured', direction: 'none',
      detail: 'no WhatsApp adapter was constructed on this agent',
    };
  }
  switch (state) {
    case 'connected':
      return {
        state: 'working', direction: 'bidirectional',
        detail: 'adapter reports connected; NOTE this is the link state, not proof a send to a particular chat would land',
      };
    case 'qr-pending':
      return {
        state: 'reachable-no-credential', direction: 'none',
        detail: 'waiting for the operator to scan the pairing QR — the link is alive but unauthenticated; restarting will not help, a human must scan',
      };
    case 'connecting':
    case 'reconnecting':
      return {
        state: 'unknown', direction: 'none',
        detail: `link is ${state} — in flight, so neither working nor broken can be asserted yet`,
      };
    case 'disconnected':
    case 'closed':
      return {
        state: 'broken', direction: 'none',
        detail: `adapter reports ${state}; a send would be refused`,
      };
    default:
      // An unrecognised state is NOT healthy and NOT a confident broken.
      return {
        state: 'unknown', direction: 'none',
        detail: `adapter reported an unrecognised state (${String(state)})`,
      };
  }
}

/**
 * iMessage's backend state → an honest channel verdict.
 *
 * Narrower than WhatsApp because the backend exposes less. Deliberately built on `state`
 * and NOT on the sibling `connectedAt`, which is computed as
 * `started ? new Date().toISOString() : undefined` — i.e. it always reports the moment you
 * asked, never the moment it connected. A row built on that would look precise and be
 * fiction, which is the exact failure this registry exists to prevent.
 */
export function imessageStateFrom(state: IMessageLiveState | null): ChannelProbeResult {
  if (state === null) {
    return {
      state: 'not-configured', direction: 'none',
      detail: 'no iMessage adapter was constructed on this agent',
    };
  }
  if (state === 'connected') {
    return {
      state: 'working', direction: 'bidirectional',
      detail: 'backend reports connected; NOTE this is the backend link, not proof a send to a particular contact would land',
    };
  }
  if (state === 'connecting') {
    return {
      state: 'unknown', direction: 'none',
      detail: 'backend is connecting — in flight, so neither working nor broken can be asserted yet',
    };
  }
  if (state === 'disconnected') {
    return { state: 'broken', direction: 'none', detail: 'backend reports disconnected; a send would be refused' };
  }
  return {
    state: 'unknown', direction: 'none',
    detail: `backend reported an unrecognised state (${String(state)})`,
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
    {
      id: 'user-whatsapp',
      audience: 'user',
      purpose: "A WhatsApp line the operator reads, paired to their own phone.",
      whenPreferred:
        'When the operator is away from a desk — it reaches a phone people actually carry. Same '
        + 'user-experience-proof property as Telegram: it shows what they genuinely receive.',
      cost:
        "Spends the operator's attention on their most personal channel, so the bar for using it is "
        + 'higher than for Telegram. Pairing is human-gated: a dropped link needs a QR scan, not a restart.',
      probe: async (): Promise<ChannelProbeResult> => whatsappStateFrom(ctx.whatsappState()),
    },
    {
      id: 'user-imessage',
      audience: 'user',
      purpose: "iMessage to the operator, through a backend on this machine.",
      whenPreferred:
        'When the operator is on Apple devices and wants messages where they already read them. '
        + 'Like the others, it is a real user surface rather than a proxy for one.',
      cost:
        "Spends the operator's attention, and is machine-bound: it works only from the host holding "
        + 'the backend, so it is the wrong choice for anything that must survive this machine going away.',
      probe: async (): Promise<ChannelProbeResult> => imessageStateFrom(ctx.imessageState()),
    },
  ];
}
