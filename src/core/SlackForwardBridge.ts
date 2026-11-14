/**
 * SlackForwardBridge — pure helpers for the WS1.1 Slack arm (owner-side bridge).
 *
 * When a Slack conversation is forwarded to the machine that OWNS it (via the
 * §L4 deliverMessage mesh verb), the owner reconstructs the inbound Slack
 * Message and replays it through the same local dispatch the live inbound path
 * uses. These two pure functions are the testable core of that reconstruction:
 *
 *   - isSlackSessionKey: distinguishes a Slack routing key (a non-numeric string —
 *     `C…` / `D…` / `G…` channel ids, optionally `:<thread_ts>`) from a Telegram
 *     topic key (a pure number). The owner-side bridge dispatches a non-numeric
 *     key to Slack and a numeric key to Telegram.
 *   - reconstructSlackMessage: rebuilds the minimal inbound Message shape from a
 *     forwarded session key + text + sender id, so slackInboundDispatch can
 *     re-derive the routing key and resume/spawn the owned session.
 *
 * Kept pure (no I/O, no adapter handle) so the decision boundary is unit-testable
 * without a live SlackAdapter — the wiring in server.ts is a thin call into these.
 */

import type { Message } from './types.js';
import { SLACK_CHANNEL_ID_RE } from './conversationIdentity.js';

/** A Telegram topic key is a pure number; everything else (Slack `C…:ts`) is not. */
export function isSlackSessionKey(sessionKey: string): boolean {
  return !/^\d+$/.test(sessionKey);
}

/**
 * A Slack conversation's key in either form it is stored under: the raw routing key
 * (`C…`/`D…`/`G…`, optionally `:<thread ts>`, as ownership and the adapter use) or the profile
 * form `slack:<routing key>` (slack-conversations-stay-with-connection §2). Exact grammar, unlike
 * `isSlackSessionKey`, so an `app:` key is never mistaken for Slack.
 */
export function isSlackConversationKey(key: string): boolean {
  const raw = key.startsWith('slack:') ? key.slice('slack:'.length) : key;
  const [channel, thread, extra] = raw.split(':');
  if (extra !== undefined || !channel || !SLACK_CHANNEL_ID_RE.test(channel)) return false;
  // Wider than SLACK_THREAD_TS_RE on purpose: refusing more is the safe side.
  return thread === undefined || /^\d{6,12}\.\d{1,9}$/.test(thread);
}

/**
 * Split a Slack routing key back into channel id + optional thread_ts. The Slack
 * channel id never contains ':' (always `C…`/`D…`/`G…`), so the first ':' is the
 * boundary — mirrors SlackAdapter.parseRoutingKey but with no adapter dependency.
 */
export function parseSlackRoutingKey(routingKey: string): { channelId: string; threadTs?: string } {
  const idx = routingKey.indexOf(':');
  if (idx === -1) return { channelId: routingKey };
  return { channelId: routingKey.slice(0, idx), threadTs: routingKey.slice(idx + 1) };
}

/**
 * Reconstruct the minimal inbound Slack Message from a forwarded deliverMessage.
 * `slackInboundDispatch` re-derives the routing key via
 * resolveRoutingKey(channelId, threadTs), so passing channel + thread + sender is
 * sufficient for the owner to resume/spawn the owned session.
 */
export function reconstructSlackMessage(opts: {
  sessionKey: string;
  messageId: string;
  text: string;
  senderUserId?: string;
}): Message {
  const { channelId, threadTs } = parseSlackRoutingKey(opts.sessionKey);
  return {
    id: opts.messageId,
    userId: opts.senderUserId ?? channelId,
    content: opts.text,
    channel: { type: 'slack', identifier: channelId },
    receivedAt: new Date().toISOString(),
    metadata: {
      channelId,
      threadTs,
      isDM: channelId.startsWith('D'),
      slackUserId: opts.senderUserId,
    },
  };
}
