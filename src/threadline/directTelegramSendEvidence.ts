import { createHash } from 'node:crypto';

interface TelegramSource {
  botScope: string;
  chatId: number;
  topicId: number;
  messageId: number;
  senderId: number;
  sentAt: number;
  text: string;
  forwarded: boolean;
  automaticForward: boolean;
  botOrChannelAuthor: boolean;
  quoteOrReply: boolean;
  hasMedia: boolean;
}

/** Only call on independently authenticated ingress evidence for the current owner.
 * The content parser does not authenticate the source or resolve a pairing.
 */
export function exactDirectTelegramSend(
  source: TelegramSource,
  ownerId: number,
): { ownerMessageRef: string; ownerEvidenceDigest: string; recipientFingerprint: string; message: string } | null {
  const { botScope, chatId, topicId, messageId, senderId, sentAt, text } = source;
  if (typeof botScope !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(botScope) || !Number.isSafeInteger(chatId) || chatId === 0
    || ![topicId, messageId, senderId, sentAt].every(value => Number.isSafeInteger(value) && value > 0)
    || senderId !== ownerId || source.forwarded !== false || source.automaticForward !== false
    || source.botOrChannelAuthor !== false || source.quoteOrReply !== false || source.hasMedia !== false
    || typeof text !== 'string' || Buffer.from(text, 'utf8').toString('utf8') !== text) return null;

  const header = /^Send via Threadline to ([a-f0-9]{32}):\n/.exec(text);
  if (!header) return null;
  const message = text.slice(header[0].length);
  if (!message.trim()) return null;

  const ownerMessageRef = `telegram:${botScope}:${chatId}:${topicId}:${messageId}`;
  const ownerEvidenceDigest = createHash('sha256')
    .update(JSON.stringify(['instar-telegram-direct-send-v1', ownerMessageRef, senderId, sentAt, text]))
    .digest('hex');
  return { ownerMessageRef, ownerEvidenceDigest, recipientFingerprint: header[1], message };
}
