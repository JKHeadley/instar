import type { OutboundContentDedup } from '../OutboundContentDedup.js';
import type { OriginSendPolicyAuthority } from './OriginSendPolicy.js';
import type { TelegramOriginRecord } from './types.js';

/** Shares the reply route's configured authority. Its configured forum keeps
 * the existing numeric topic keys; other browser destinations are namespaced. */
export function originContentDedup(dedup: OutboundContentDedup, configuredChatId: string | undefined): Pick<OriginSendPolicyAuthority, 'reserveContent' | 'completeContent'> {
  const key = (record: TelegramOriginRecord): number | string => {
    const d = record.destination;
    const chatId = d.chatId?.startsWith('channel:') ? `-100${d.chatId.slice(8)}` : d.chatId?.startsWith('chat:') ? `-${d.chatId.slice(5)}` : d.chatId;
    if (configuredChatId && chatId === configuredChatId && (d.topicId === null || /^[0-9]+$/.test(d.topicId)) && Number.isSafeInteger(Number(d.topicId ?? 0))) return Number(d.topicId ?? 0);
    return JSON.stringify(['telegram-origin', d.accountId, d.chatId, d.topicId, d.messageId]);
  };
  return {
    reserveContent: async (record, input, deadlineAt) => {
      // Editing an existing message is a distinct user action, not a duplicate
      // new message. Include the target identity for edits and other namespaces.
      const destination = record.destination.messageId === null ? key(record) : JSON.stringify([key(record), 'edit', record.destination.messageId]);
      const result = dedup.reserveOrigin(destination, input.text, record.operationId, deadlineAt);
      if (result === 'reserved') return { ok: true };
      if (result === 'duplicate') return { ok: false, status: 200, reason: 'duplicate-content',
        body: { ok: true, suppressedDuplicate: true, originId: record.originId } };
      return { ok: false, status: 409, reason: 'content-dedup-unavailable', body: { error: 'content-dedup-unavailable', retryable: false } };
    },
    completeContent: async (record, input) => {
      const destination = record.destination.messageId === null ? key(record) : JSON.stringify([key(record), 'edit', record.destination.messageId]);
      dedup.completeOrigin(destination, input.text, record.operationId);
    },
  };
}
