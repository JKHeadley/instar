import { describe, expect, it } from 'vitest';
import { TelegramInboundHandoff } from '../../src/core/TelegramInboundHandoff.js';
import { isSystemOrProxyMessage } from '../../src/messaging/shared/isSystemOrProxyMessage.js';
import { INBOUND_RECEIVED_NOTICE, telegramInboundStatusNotice } from '../../src/messaging/userNotices.js';

describe('Telegram inbound handoff receipts', () => {
  it('requires transcript evidence for the exact journal row and reports it once', () => {
    const handoffs = new TelegramInboundHandoff();
    const message = { topicId: 8, messageId: 34 };
    handoffs.track(message, '8', 'current-row', 100);
    const states = new Map([['8:other-row', 'consumed'], ['8:current-row', 'unseen']]);
    const read = (conversationId: string, deliveryId: string) => ({
      transcriptState: states.get(`${conversationId}:${deliveryId}`) ?? 'unseen',
    });

    expect(handoffs.takeConfirmed(read, 200)).toEqual([]);
    states.set('8:current-row', 'consumed');
    expect(handoffs.takeConfirmed(read, 300)).toEqual([message]);
    expect(handoffs.takeConfirmed(read, 400)).toEqual([]);
  });

  it('leaves missing, unknown or expired evidence without a delivered notice', () => {
    const handoffs = new TelegramInboundHandoff();
    handoffs.track({ topicId: 8, messageId: 34 }, '8', 'first', 100);
    expect(handoffs.takeConfirmed(() => null, 200)).toEqual([]);
    expect(handoffs.takeConfirmed(() => ({ transcriptState: 'unknown' }), 300)).toEqual([]);
    expect(handoffs.takeConfirmed(() => ({ transcriptState: 'responded' }), 100 + 24 * 60 * 60_000)).toEqual([]);
  });

  it('keeps each custody label out of substantive replies', () => {
    expect(isSystemOrProxyMessage(INBOUND_RECEIVED_NOTICE)).toBe(true);
    expect(isSystemOrProxyMessage('Instar received your queued message.')).toBe(true);
    expect(isSystemOrProxyMessage('Instar received your queued message. Here is my answer.')).toBe(false);
    for (const status of ['waiting', 'delivered', 'expired'] as const) {
      expect(isSystemOrProxyMessage(telegramInboundStatusNotice(status, 34))).toBe(true);
    }
  });
});
