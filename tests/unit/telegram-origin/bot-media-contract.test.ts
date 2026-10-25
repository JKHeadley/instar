import { describe, expect, it } from 'vitest';
import { assertOutgoingPayloadVisible } from '../../../src/messaging/invisible-payload.js';
import { correlateBotReceipt } from '../../../src/messaging/telegram-origin/OriginBotReceipt.js';
import { isOriginMessageMethod } from '../../../src/messaging/telegram-origin/OriginBotEgress.js';
import type { SealedBotRequest } from '../../../src/messaging/telegram-origin/types.js';

const request: SealedBotRequest = { method: 'forwardMessages', accountId: 'bot', contentType: 'application/json',
  body: JSON.stringify({ message_ids: [10, 11] }), destination: { version: 1, transport: 'bot-api', accountId: 'bot',
    chatId: '-100123', topicId: '42', messageId: null, inlineMessageId: null, scheduledMessageId: null } };
describe('Telegram media and receipt contracts', () => {
  it('treats the actual media reference as opaque content while still refusing invisible text-only content', () => {
    expect(() => assertOutgoingPayloadVisible('sendDocument', { document: 'known-file-id', caption: '\u200b' })).not.toThrow();
    expect(() => assertOutgoingPayloadVisible('sendDocument', { caption: '\u200b' })).toThrow();
    expect(() => assertOutgoingPayloadVisible('sendMessage', { document: 'irrelevant-file-id', text: '\u200b' })).toThrow();
    expect(() => assertOutgoingPayloadVisible('sendMediaGroup', { media: [{ type: 'photo', media: 'file-id', caption: '\u200b' }] })).not.toThrow();
  });
  it('correlates documented ID-only results to the sealed request without confusing the source IDs', () => {
    const receipt = correlateBotReceipt(request, [{ message_id: 80 }, { message_id: 81 }], 123);
    expect(receipt?.messages?.map(row => [row.chatId, row.topicId, row.messageId])).toEqual([
      ['-100123', '42', '80'], ['-100123', '42', '81'] ]);
  });
  it.each([[{ message_id: 80 }], [{ message_id: 80 }, { message_id: 80 }],
    [{ message_id: 80 }, { message_id: 0 }], [{ message_id: 80, chat: { id: -9 } }, { message_id: 81 }]])(
    'does not certify skipped, duplicate, invalid or mismatched group receipts: %j', (...result) => {
      expect(correlateBotReceipt(request, result, 123)).toBeNull();
    });
  it('routes rich-message methods to origin handling so unsupported rendering cannot bypass recording', () => {
    expect(isOriginMessageMethod('sendRichMessage')).toBe(true);
    expect(isOriginMessageMethod('editMessageText')).toBe(true);
    expect(isOriginMessageMethod('createForumTopic')).toBe(false);
    expect(isOriginMessageMethod('sendChatAction')).toBe(false);
  });
});
