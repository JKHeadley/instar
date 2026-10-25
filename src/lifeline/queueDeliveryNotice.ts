export type QueueReason = 'server-unhealthy' | 'healthy-forward-failed';

export interface QueueDeliveryCounts {
  outage: number;
  delayedHandoff: number;
  legacyUnknown: number;
}

/** Every durable queue handoff gets an honest acknowledgement; only the copy differs. */
export function buildQueueAcknowledgement(reason: QueueReason, kind: 'message' | 'photo' | 'file'): string | null {
  if (reason === 'healthy-forward-failed') {
    return `I’m having trouble handing this ${kind} to the active session. It is safely queued and will retry automatically.`;
  }
  return null;
}

/**
 * Build replay notices without inventing a recovery event. Messages queued
 * after a slow/failed handoff get neutral delivery copy; old entries do too.
 */
export function buildQueueDeliveryNotices(counts: QueueDeliveryCounts): string[] {
  const notices: string[] = [];
  if (counts.outage > 0) {
    notices.push(counts.outage === 1
      ? '✓ Server recovered — your queued message has been delivered.'
      : `✓ Server recovered — ${counts.outage} queued messages delivered.`);
  }
  if (counts.delayedHandoff > 0) {
    notices.push(counts.delayedHandoff === 1
      ? '✓ Your delayed message has now been delivered to the session.'
      : `✓ ${counts.delayedHandoff} delayed messages have now been delivered to the session.`);
  }
  if (counts.legacyUnknown > 0) {
    notices.push(counts.legacyUnknown === 1
      ? '✓ Your queued message has been delivered.'
      : `✓ ${counts.legacyUnknown} queued messages delivered.`);
  }
  return notices;
}
