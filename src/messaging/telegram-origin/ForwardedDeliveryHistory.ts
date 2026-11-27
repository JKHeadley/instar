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
import { lateRecoveredReplyNotice } from './SessionDeliveryNotice.js';
import { escapeOriginFooter } from './OriginPresentation.js';

/** History consumes the retained authored representation, never Telegram's formatted
 * wire body when the source exists. Already-sealed wire-only records retain their
 * prior fallback; no heuristic HTML decoding can recover lost Markdown. */
export function originMessageHistoryText(request: { policy?: { text?: unknown }; body?: unknown },
  timing?: { firstPreparedAt: number; lateMarkedAt: number | null; footer?: string | null }): string | null {
  if (typeof request.policy?.text === 'string') {
    const late = timing?.lateMarkedAt != null
      ? lateRecoveredReplyNotice(timing.firstPreparedAt, timing.lateMarkedAt) : null;
    if (!late) return request.policy.text;
    // Older late replacements may have retained the entire already-marked
    // wire body as their policy. Compare exact sealed representations and the
    // known footer, never strip authored prose because it resembles a notice.
    if (typeof request.body === 'string') {
      try {
        const body = JSON.parse(request.body) as { text?: unknown; parse_mode?: unknown } | null;
        const tail = timing?.footer ? `\n\n${escapeOriginFooter(timing.footer,
          typeof body?.parse_mode === 'string' ? body.parse_mode : undefined)}` : '';
        if (body?.text === request.policy.text || (tail && body?.text === `${request.policy.text}${tail}`)) return request.policy.text;
      } catch { /* @silent-fallback-ok: retained authored text still receives its recorded late marker. */ }
    }
    return `${late}\n\n${request.policy.text}`;
  }
  if (typeof request.body !== 'string') return null;
  try {
    const body = JSON.parse(request.body) as { text?: unknown } | null;
    return typeof body?.text === 'string' ? body.text : null;
  } catch { return null; /* @silent-fallback-ok: an unreadable history source records no row, never a new send. */ }
}

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
  const text = originMessageHistoryText(request);
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
