import { createHash } from 'node:crypto';
import type { TelegramAdapter } from './TelegramAdapter.js';
import type { CommitmentTracker } from '../monitoring/CommitmentTracker.js';
import { isQuietReceipt } from './NotificationSelectivityGate.js';

/** This observation describes one invocation, never the delivery history of its source. */
export const TELEGRAM_INJECTION_REFUSAL_NOTICE =
  'This attempt stopped before sending because the conversation was not ready to receive it. ' +
  'I cannot confirm whether an earlier attempt delivered your message. ' +
  'This notice does not mean the message is queued for automatic retry.';

export interface InjectionFailureDeps {
  telegram: Pick<TelegramAdapter, 'createAttentionItem' | 'isAttentionItemPersisted'>;
  getTracker: () => CommitmentTracker | null;
  sendNotice: (topicId: number, text: string) => Promise<unknown>;
  reportDegradation: (reason: string) => void;
}

/** No message text, session contents or credentials enter this source-specific receipt. */
export async function reportTelegramInjectionFailure(
  deps: InjectionFailureDeps,
  source: { namespace: string; topicId: number; messageId: string },
): Promise<{ attentionPersisted: boolean; followThroughRecorded: boolean; notice: 'delivered' | 'recorded' | 'unconfirmed' | 'failed' }> {
  const key = `telegram-injection-refusal:${createHash('sha256')
    .update(JSON.stringify([source.namespace, source.topicId, source.messageId])).digest('hex')}`;
  const outcome = { attentionPersisted: false, followThroughRecorded: false, notice: 'failed' as 'delivered' | 'recorded' | 'unconfirmed' | 'failed' };
  const degrade = (reason: string): void => {
    try { deps.reportDegradation(reason); } catch { /* @silent-fallback-ok: a reporting failure must not turn the refused input into success. */ }
  };
  try {
    const item = await deps.telegram.createAttentionItem({
      id: key, conditionKey: key, title: 'A message attempt could not reach its conversation',
      summary: TELEGRAM_INJECTION_REFUSAL_NOTICE, description: TELEGRAM_INJECTION_REFUSAL_NOTICE,
      category: 'delivery', priority: 'HIGH', sourceContext: 'telegram-injection-refusal',
      contextTopicIds: [source.topicId],
    }, { recordOnly: true });
    outcome.attentionPersisted = deps.telegram.isAttentionItemPersisted(item);
    if (!outcome.attentionPersisted) degrade('attention-persistence-unconfirmed');
  } catch { degrade('attention-persistence-failed'); }
  try {
    const tracker = deps.getTracker();
    if (!tracker) throw new Error('tracking unavailable');
    // record() synchronously returns the existing active externalKey, before any await.
    tracker.record({
      type: 'one-time-action', source: 'sentinel', owner: 'agent', blockedOn: 'none',
      topicId: source.topicId, sourceConversationKey: `telegram:${source.topicId}`, sourceMessageId: source.messageId,
      externalKey: key, beaconEnabled: true, verificationMethod: 'manual',
      userRequest: TELEGRAM_INJECTION_REFUSAL_NOTICE,
      agentResponse: 'Investigate this refused attempt and report the verified outcome or a supported recovery option. ' +
        'Do not resend automatically. An identity binding or notice acknowledgement does not prove delivery.',
    });
    outcome.followThroughRecorded = true;
  } catch { /* @silent-fallback-ok: report the failed tracking write and leave its outcome false. */ degrade('failure-follow-through-unavailable'); }
  try {
    let notice = TELEGRAM_INJECTION_REFUSAL_NOTICE;
    if (outcome.followThroughRecorded) notice += ' I have recorded a follow-up to investigate and report what can be verified.';
    else notice += ' I could not secure a tracked follow-up for this failure.';
    if (!outcome.attentionPersisted) notice += ' I could not confirm that the attention record was saved.';
    const receipt = await deps.sendNotice(source.topicId, notice);
    if (isQuietReceipt(receipt)) outcome.notice = 'recorded';
    else if (receipt && typeof receipt === 'object' && typeof (receipt as { messageId?: unknown }).messageId === 'number'
      && (receipt as { messageId: number }).messageId > 0) outcome.notice = 'delivered';
    else { outcome.notice = 'unconfirmed'; degrade('failure-notice-delivery-unconfirmed'); }
  } catch { /* @silent-fallback-ok: report the failed send and retain the failed notice outcome. */ degrade('failure-notice-send-failed'); }
  if (!outcome.attentionPersisted && !outcome.followThroughRecorded && outcome.notice !== 'delivered' && outcome.notice !== 'recorded') {
    degrade('failure-visibility-and-follow-through-unsecured');
  }
  return outcome;
}
