import type { TelegramAdapter } from '../TelegramAdapter.js';
import type { TelegramOriginRuntimeOptions } from './TelegramOriginRuntime.js';
import { sessionDeliveryNotice } from './SessionDeliveryNotice.js';
import { topicRef } from '../shared/topicRef.js';

type DeliveryEvent = Parameters<NonNullable<TelegramOriginRuntimeOptions['onSessionDeliveryHeld']>>[0];
type Attention = Pick<TelegramAdapter, 'getAttentionItem' | 'upsertAttentionItem' | 'clearAttentionCondition'>;

/** Reconcile durable reply-delivery evidence; live failures retain the notice path. */
export async function reportSessionDelivery(entry: DeliveryEvent, topicId: number | null, deps: {
  telegram: Attention; sendNotice: (topicId: number, text: string, logicalSendId: string) => Promise<Response>;
}): Promise<void> {
  const { telegram } = deps;
  const attentionId = `telegram-origin-held-reply:${entry.operationId}`;
  const previous = telegram.getAttentionItem(attentionId);
  if (entry.state === 'accepted') {
    if (previous) telegram.clearAttentionCondition({ id: attentionId }, 'Telegram accepted the original reply.', { reconcile: true });
    return;
  }
  const copy = sessionDeliveryNotice(entry.state ?? 'held', entry.uncertain);
  await telegram.upsertAttentionItem({ id: attentionId,
    category: 'telegram-origin', priority: 'HIGH', title: 'A reply needs delivery attention',
    sourceContext: 'telegram-origin-session-hold', summary: copy.summary,
    description: `Original reply to ${topicRef(topicId)}; delivery state ${entry.state ?? 'held'}.`,
    contextTopicIds: topicId === null ? undefined : [topicId],
  }, entry.source === 'scan' ? { recordOnly: true } : undefined);
  // A historical exception is evidence for the dashboard, not a fresh
  // conversational turn. Never turn a scan/restart into one send per reply.
  if (entry.source === 'scan' || topicId === null) return;
  const noticeState = entry.uncertain || entry.state === 'outcome-unknown' ? 'uncertain'
      : entry.state === 'expired' || entry.state === 'known-failed' ? 'failed' : 'delayed';
  const response = await deps.sendNotice(topicId, copy.topicText, `reply-delivery-notice:${entry.operationId}:${noticeState}`);
  if (response.status !== 200) throw new Error(`origin notice not confirmed: HTTP ${response.status}`);
}
