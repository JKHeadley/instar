/** A queued reply has lost its place when the conversation has moved on.
 * Only user and agent messages count: delivery notices and other automation
 * must never retire the reply they are explaining. The caller supplies the
 * topic's locally observed Telegram history; missing history is no evidence. */
export function queuedReplyOvertaken(preparedAt: number, messages: ReadonlyArray<{
  timestamp: string;
  fromUser: boolean;
  provenance?: string;
}>): boolean {
  if (!Number.isFinite(preparedAt)) return false;
  return messages.some(message => {
    const at = Date.parse(message.timestamp);
    return Number.isFinite(at) && at > preparedAt &&
      (message.fromUser || message.provenance === 'agent');
  });
}

export type QueuedReplyReview = 'retire' | 'deliver' | 'hold';

/** The pool read is needed when this machine has no newer message. A failed
 * peer or a full page that does not reach the draft time cannot prove that
 * another machine did not receive a newer reply. */
export function reviewQueuedReplyHistory(input: {
  preparedAt: number;
  local: ReadonlyArray<{ timestamp: string; fromUser: boolean; provenance?: string }>;
  pooled?: ReadonlyArray<{ timestamp: string; fromUser: boolean; provenance?: string }>;
  failedPeers?: number;
  poolPageLimit?: number;
}): QueuedReplyReview {
  if (queuedReplyOvertaken(input.preparedAt, input.local)) return 'retire';
  if (!input.pooled) return 'hold';
  if (queuedReplyOvertaken(input.preparedAt, input.pooled)) return 'retire';
  if (input.failedPeers) return 'hold';
  const limit = input.poolPageLimit ?? 100;
  if (input.pooled.length >= limit && input.pooled.every(row => Date.parse(row.timestamp) > input.preparedAt)) return 'hold';
  return 'deliver';
}
