import { randomUUID } from 'node:crypto';
import { canonicalOrigin, parseOriginJson, wireDigest } from './CanonicalOrigin.js';
import { TelegramOriginHoldError } from './types.js';
import type { SealedBotRequest } from './types.js';
import type { OriginServiceStore, OriginPreparedBotOperation } from './TelegramOriginService.js';
import type { StoredChildInput, StoredMaterializationInput } from './StoreTypes.js';

/** Derive only the reply binding promised by the immutable companion plan.
 * Text, namespace, display and author remain byte-identical. The parent receipt
 * must be durably accepted in this SAME logical operation and destination. */
export async function bindBotCompanion(store: OriginServiceStore, operation: OriginPreparedBotOperation,
  child: StoredChildInput, original: SealedBotRequest): Promise<StoredMaterializationInput> {
  const fail = (reason: string): never => { throw new TelegramOriginHoldError(reason, operation.record.operationId); };
  const parent = operation.admission.children.find(c => c.childId === original.companionOf);
  if (!parent || parent.childId === child.childId || !child.allowedDerivations?.includes('companion-receipt')) return fail('invalid-companion-plan');
  const audit = await store.getOrigin(operation.record.originId);
  const receiptJson = audit?.attempts.find(a => a.childId === parent.childId && a.outcome === 'accepted')?.receiptJson;
  if (!receiptJson) return fail('companion-parent-unconfirmed');
  const receipt = JSON.parse(receiptJson);
  if (!receipt.messageId || !Number.isSafeInteger(Number(receipt.messageId)) || Number(receipt.messageId) <= 0 ||
    receipt.accountId !== original.accountId || receipt.chatId !== original.destination.chatId ||
    receipt.topicId !== original.destination.topicId) return fail('companion-parent-mismatch');
  const params = parseOriginJson(original.body) as Record<string, unknown>;
  const derived: SealedBotRequest = { ...original, body: canonicalOrigin({ ...params,
    reply_parameters: { message_id: Number(receipt.messageId) } }) };
  const requestJson = canonicalOrigin(derived), requestDigest = wireDigest(requestJson);
  let current = await store.getChild(child.childId);
  if (!current) return fail('companion-child-unavailable');
  if (current.generation === 0) {
    const materialization = { materializationId: randomUUID(), requestJson, requestDigest };
    await store.addMaterialization({ childId: child.childId, expectedGeneration: 0, kind: 'companion-receipt',
      canonicalContentDigest: child.canonicalContentDigest, destinationJson: child.destinationJson,
      inputDigest: wireDigest(receiptJson), materialization });
    current = await store.getChild(child.childId);
  }
  const stored = current?.materializations.find(m => m.requestJson === requestJson && m.requestDigest === requestDigest);
  if (current?.generation !== 1 || !stored) return fail('companion-derivation-mismatch');
  return stored;
}
