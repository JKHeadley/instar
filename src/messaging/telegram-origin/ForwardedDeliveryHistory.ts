// A reply forwarded from a peer and delivered by this machine (the lease
// holder) must appear in this machine's topic history too. The sending peer
// records its own row only when the forward answers cleanly; when the answer
// is lost ("acceptance unknown") no machine recorded the message at all.
// Readers of history then believed the topic was quiet: on 2026-11-11 a held
// progress note in topic 141868 was released AFTER a newer question because
// the "overtaken" review could not see the question (Telegram 141952), and the
// stale "report to follow" note landed under it. The pooled history read
// dedupes rows by direction + Telegram message id, so recording the same
// delivery on both machines shows it once.
import type { OriginPreparedBotOperation } from './TelegramOriginService.js';

export interface ForwardedDeliveryRow {
  chatId: string;
  /** The Telegram thread id the reply went to (always a forum topic, never General). */
  threadId: number;
  text: string;
  messageId: number;
  producerKind: string;
}

/** The history row for a peer reply this machine delivered, or null when the
 * operation is not a plain text reply to a topic with a concrete receipt. Pure:
 * it reads only the sealed request the holder already verified. */
export function forwardedDeliveryRow(operation: OriginPreparedBotOperation, messageId: unknown): ForwardedDeliveryRow | null {
  if (typeof messageId !== 'number' || !Number.isSafeInteger(messageId) || messageId < 1) return null;
  const { destination, producerKind } = operation.record;
  const chatId = destination.chatId;
  const threadId = Number(destination.topicId);
  if (typeof chatId !== 'string' || !chatId || destination.topicId === null || !Number.isSafeInteger(threadId) || threadId < 1) return null;
  let request: { method?: unknown; policy?: { text?: unknown }; body?: unknown };
  try { request = JSON.parse(operation.admission.children[0]?.materializations[0]?.requestJson ?? 'null') ?? {}; }
  catch { return null; }
  if (request.method !== 'sendMessage') return null;
  let text: unknown = request.policy?.text;
  if (typeof text !== 'string' && typeof request.body === 'string') {
    try { text = (JSON.parse(request.body) as { text?: unknown }).text; } catch { text = undefined; }
  }
  if (typeof text !== 'string' || !text) return null;
  return { chatId, threadId, text, messageId, producerKind };
}

/** Which history topic a delivered thread belongs to: the main chat uses the
 * thread id; the issues chat uses the 10_000_000_000 offset the adapter uses.
 * Any other chat has no topic history on this machine. */
export function forwardedDeliveryHistoryTopic(row: Pick<ForwardedDeliveryRow, 'chatId' | 'threadId'>, chats: { mainChatId?: unknown; issuesChatId?: unknown }): number | null {
  if (chats.mainChatId !== undefined && chats.mainChatId !== null && row.chatId === String(chats.mainChatId)) return row.threadId;
  if (chats.issuesChatId !== undefined && chats.issuesChatId !== null && row.chatId === String(chats.issuesChatId)) return 10_000_000_000 + row.threadId;
  return null;
}
