/** A queued reply has lost its place when the agent has answered again since
 * it was drafted. Only a newer AGENT message counts. A user message alone never
 * retires a held reply: a user who writes while a reply is held ("checking in")
 * is still waiting for it, and dropping it then loses the answer they asked for
 * (2026-11-11 incident: a check-in retired two held replies, silently). Delivery
 * notices and other automation never retire the reply they are explaining. The
 * caller supplies the topic's observed Telegram history; missing history is no
 * evidence. */
export function queuedReplyOvertaken(preparedAt: number, messages: ReadonlyArray<{
  timestamp: string;
  fromUser: boolean;
  provenance?: string;
}>): boolean {
  if (!Number.isFinite(preparedAt)) return false;
  return messages.some(message => {
    const at = Date.parse(message.timestamp);
    return Number.isFinite(at) && at > preparedAt &&
      !message.fromUser && message.provenance === 'agent';
  });
}

export type QueuedReplyReview = 'retire' | 'deliver' | 'hold';

/** Hold reason recorded on an operation retired because the agent answered again. */
export const OVERTAKEN_REPLY_HOLD_REASON = 'overtaken-reply';

/** How long a retried reply waits for a machine that cannot answer. A sleeping
 * laptop must not hold a reply until it expires: the unreachable peer is a doubt,
 * not evidence, and a late reply costs less than one that never arrives. */
export const QUEUED_REPLY_PEER_WAIT_MS = 15 * 60_000;

/** The pool read is needed when this machine has no newer message. A failed
 * peer cannot prove that another machine did not receive a newer reply, so it
 * waits, for a bounded time. A full page that does not reach the draft time
 * holds: the machines answered, and there is more history to read. */
export function reviewQueuedReplyHistory(input: {
  preparedAt: number;
  local: ReadonlyArray<{ timestamp: string; fromUser: boolean; provenance?: string }>;
  pooled?: ReadonlyArray<{ timestamp: string; fromUser: boolean; provenance?: string }>;
  failedPeers?: number;
  poolPageLimit?: number;
  now?: number;
}): QueuedReplyReview {
  if (queuedReplyOvertaken(input.preparedAt, input.local)) return 'retire';
  if (!input.pooled) return 'hold';
  if (queuedReplyOvertaken(input.preparedAt, input.pooled)) return 'retire';
  if (input.failedPeers && (input.now ?? Date.now()) - input.preparedAt < QUEUED_REPLY_PEER_WAIT_MS) return 'hold';
  const limit = input.poolPageLimit ?? 100;
  if (input.pooled.length >= limit && input.pooled.every(row => Date.parse(row.timestamp) > input.preparedAt)) return 'hold';
  return 'deliver';
}
