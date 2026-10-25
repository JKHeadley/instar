import type { OriginPlatformReceipt, SealedBotRequest } from './types.js';

export interface OriginBotReceipt extends OriginPlatformReceipt {
  messages?: OriginPlatformReceipt[];
  partial?: true;
  expectedCount?: number;
}
/** Telegram's copy/forward-many methods return MessageId, while media albums
 * return Message[]. See https://core.telegram.org/bots/api#forwardmessages .
 * The namespace for MessageId comes from the exact accepted request; other
 * methods must corroborate it in the returned Message object. */
function inspectBotReceipt(request: SealedBotRequest, result: unknown, now: number, allowPartial: boolean): OriginBotReceipt | null {
  const many = ['sendMediaGroup', 'forwardMessages', 'copyMessages'].includes(request.method);
  const idsOnly = ['copyMessage', 'forwardMessages', 'copyMessages'].includes(request.method);
  if (many !== Array.isArray(result)) return null;
  const values = many ? result as unknown[] : [result];
  if (!values.length || values.length > 100) return null;
  let expectedCount = values.length;
  if (many) {
    const body = JSON.parse(request.body);
    let expected = request.method === 'sendMediaGroup' ? body.media : body.message_ids;
    if (typeof expected === 'string') { try { expected = JSON.parse(expected); } catch { return null; } }
    // Forward/copy can silently skip source messages. Do not call that full
    // delivery or send a success-shaped companion for the whole group.
    if (!Array.isArray(expected) || expected.length > 100 || expected.length < values.length || (!allowPartial && expected.length !== values.length)) return null;
    expectedCount = expected.length;
  }
  const messages: OriginPlatformReceipt[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (!Number.isSafeInteger(row.message_id) || Number(row.message_id) <= 0) return null;
    const messageId = String(row.message_id);
    if (seen.has(messageId)) return null; seen.add(messageId);
    const chat = row.chat && typeof row.chat === 'object' ? (row.chat as Record<string, unknown>).id : null;
    if ((!idsOnly || chat !== null) && String(chat) !== request.destination.chatId) return null;
    if ((!idsOnly || row.message_thread_id !== undefined) && request.destination.topicId !== null &&
      String(row.message_thread_id) !== request.destination.topicId) return null;
    if (request.method.startsWith('edit') && request.destination.messageId !== null && messageId !== request.destination.messageId) return null;
    messages.push({ ...request.destination, messageId, acceptedAt: now });
  }
  return { ...messages[0], ...(many ? { messages } : {}),
    ...(expectedCount > messages.length ? { partial: true as const, expectedCount } : {}) };
}
export function correlateBotReceipt(request: SealedBotRequest, result: unknown, now: number): OriginBotReceipt | null {
  return inspectBotReceipt(request, result, now, false);
}
/** Retain confirmed destination IDs without guessing which skipped source produced each ID. */
export function correlatePartialBotReceipt(request: SealedBotRequest, result: unknown, now: number): OriginBotReceipt | null {
  const receipt = inspectBotReceipt(request, result, now, true);
  return receipt?.partial ? receipt : null;
}
export function replayBotReceipt(receipt: OriginBotReceipt): Response {
  const row = (value: OriginPlatformReceipt) => ({ message_id: Number(value.messageId), chat: { id: value.chatId },
    ...(value.topicId === null ? {} : { message_thread_id: Number(value.topicId) }) });
  return new Response(JSON.stringify({ ok: true, result: receipt.messages ? receipt.messages.map(row) : row(receipt) }));
}
