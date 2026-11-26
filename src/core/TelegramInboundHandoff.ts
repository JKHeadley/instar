/** The original Telegram message associated with an exact delivery journal row. */
export interface TelegramInboundIdentity {
  topicId: number;
  messageId: number;
}

interface TrackedHandoff extends TelegramInboundIdentity {
  conversationId: string;
  deliveryId: string;
  expiresAt: number;
}

const HANDOFF_TTL_MS = 24 * 60 * 60_000;
const MAX_TRACKED_HANDOFFS = 256;

/**
 * Tracks optional user-facing acknowledgements. The delivery journal remains
 * the authority. A restart or capacity limit can omit an acknowledgement.
 */
export class TelegramInboundHandoff {
  private readonly pending = new Map<string, TrackedHandoff>();

  track(identity: TelegramInboundIdentity, conversationId: string, deliveryId: string, now = Date.now()): void {
    if (!Number.isSafeInteger(identity.topicId) || identity.topicId <= 0 ||
        !Number.isSafeInteger(identity.messageId) || identity.messageId <= 0) return;
    const key = `${identity.topicId}:${identity.messageId}`;
    if (this.pending.has(key) || this.pending.size >= MAX_TRACKED_HANDOFFS) return;
    this.pending.set(key, { ...identity, conversationId, deliveryId, expiresAt: now + HANDOFF_TTL_MS });
  }

  takeConfirmed(
    read: (conversationId: string, deliveryId: string) => { transcriptState: string } | null,
    now = Date.now(),
  ): TelegramInboundIdentity[] {
    const confirmed: TelegramInboundIdentity[] = [];
    for (const [key, entry] of this.pending) {
      if (entry.expiresAt <= now) {
        this.pending.delete(key);
        continue;
      }
      const row = read(entry.conversationId, entry.deliveryId);
      if (row?.transcriptState !== 'consumed' && row?.transcriptState !== 'responded') continue;
      this.pending.delete(key);
      confirmed.push({ topicId: entry.topicId, messageId: entry.messageId });
    }
    return confirmed;
  }
}
