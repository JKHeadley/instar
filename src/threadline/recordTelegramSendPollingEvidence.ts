import { editedTelegramMessageReference, exactDirectTelegramPollingSend } from './directTelegramSendEvidence.js';
import type { TelegramSendEvidenceStore } from './TelegramSendEvidenceStore.js';

interface RawPollingUpdate {
  message?: unknown;
  edited_message?: unknown;
}

/** Invoke only for an authenticated direct-poll update, before acknowledging it.
 * A refusal must stop the batch and close evidence coverage until replay succeeds.
 */
export function recordTelegramSendPollingEvidence(
  update: RawPollingUpdate,
  store: Pick<TelegramSendEvidenceStore, 'capture' | 'invalidate'>,
  botAccountId: number,
  ownerId: number,
): void {
  if (Object.hasOwn(update, 'edited_message')) {
    const reference = editedTelegramMessageReference(update.edited_message, botAccountId);
    if (!reference || !store.invalidate(reference)) throw new Error('edit coverage unavailable');
    return;
  }
  const captured = exactDirectTelegramPollingSend(update.message, botAccountId, ownerId);
  if (captured && store.capture(captured.ownerMessageRef, captured.ownerEvidenceDigest) === 'refused') {
    throw new Error('capture unavailable');
  }
}
