import { randomUUID } from 'node:crypto';
import { splitTag, verifyMessage } from '../../core/agentSignatureProvenance.js';
import { browserOperationDigest } from './BrowserTypes.js';
import type { PreparedBrowserChild } from './BrowserTypes.js';
import { canonicalOrigin, parseOriginJson, wireDigest } from './CanonicalOrigin.js';
import type { OriginStore } from './OriginStore.js';
import type { OriginPreparedBotOperation } from './TelegramOriginService.js';
import type { StoredChildInput, StoredMaterializationInput } from './StoreTypes.js';
import { TelegramOriginHoldError } from './types.js';

export type SealedBrowserRequest = Omit<PreparedBrowserChild, 'childId' | 'originId' | 'claimFence'>;
/** The immutable parent permits only a new ASP tag and its absolute dispatch
 * deadline. The original body, random_id, peer, edit target and author survive. */
export async function materializeBrowserSignature(options: {
  store: OriginStore; operation: OriginPreparedBotOperation; child: StoredChildInput;
  resolveAgentPublicKey: (agentId: string) => Buffer | null | undefined;
  signBody: (body: string, topicId: number, timestamp: number) => string; now: number;
}): Promise<StoredMaterializationInput> {
  const { store, operation, child, now } = options;
  const fail = (reason: string): never => { throw new TelegramOriginHoldError(reason, operation.record.operationId); };
  if (now >= operation.admission.deadlineAt) return fail('browser-recovery-deadline');
  const original = parseOriginJson(child.materializations[0].requestJson) as unknown as SealedBrowserRequest;
  if (typeof original.args.message !== 'string') return fail('invalid-browser-original');
  const originalVerdict = verifyMessage({ raw: original.args.message, expectedTopicId: original.expectedAspTopicId,
    resolvePublicKey: id => id === original.expectedAgentId ? options.resolveAgentPublicKey(id) : null,
    nowSeconds: Math.floor(operation.record.createdAt / 1000) });
  if (originalVerdict.classification !== 'agent-verified') return fail('original-signature-unavailable');
  const withoutFreshness = (request: SealedBrowserRequest) => {
    const { deadlineMs: _deadline, digest: _digest, args, ...rest } = request;
    const { message: _message, ...otherArgs } = args;
    return canonicalOrigin({ ...rest, args: otherArgs });
  };
  const validate = (materialization: StoredMaterializationInput): SealedBrowserRequest => {
    const request = parseOriginJson(materialization.requestJson) as unknown as SealedBrowserRequest;
    if (wireDigest(materialization.requestJson) !== materialization.requestDigest || typeof request.args?.message !== 'string'
      || withoutFreshness(request) !== withoutFreshness(original)
      || request.digest !== browserOperationDigest(request.method, request.args)) return fail('browser-renewal-mismatch');
    const tag = splitTag(request.args.message).tag;
    if (!tag || tag.timestamp * 1000 < operation.record.createdAt - 1000 || tag.timestamp * 1000 > now + 60_000) return fail('browser-renewal-time-invalid');
    const verdict = verifyMessage({ raw: request.args.message, expectedTopicId: original.expectedAspTopicId,
      resolvePublicKey: id => id === original.expectedAgentId ? options.resolveAgentPublicKey(id) : null, nowSeconds: tag.timestamp });
    if (verdict.classification !== 'agent-verified' || verdict.body !== originalVerdict.body
      || request.deadlineMs > (tag.timestamp + 780) * 1000 || request.deadlineMs > operation.admission.deadlineAt
      || materialization.dispatchDeadline !== request.deadlineMs) return fail('browser-renewal-mismatch');
    return request;
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const current = await store.getChild(child.childId);
    if (!current || current.materializations.length !== 1 || current.operationId !== operation.record.operationId) return fail('browser-child-unavailable');
    const materialization = current.materializations[0], request = validate(materialization);
    if (request.deadlineMs > now + 60_000 || current.state !== 'queued') return materialization;
    if (!child.allowedDerivations?.includes('signature-renewal')) return fail('browser-signature-renewal-not-authorized');
    const timestamp = Math.floor(now / 1000);
    let message: string;
    try { message = options.signBody(originalVerdict.body, original.expectedAspTopicId, timestamp); }
    catch { return fail('browser-signing-unavailable'); }
    if (message.length > 4096) return fail('browser-signature-capacity');
    const args = { ...original.args, message };
    const renewed: SealedBrowserRequest = { ...original, args, digest: browserOperationDigest(original.method, args),
      deadlineMs: Math.min(operation.admission.deadlineAt, (timestamp + 780) * 1000) };
    const requestJson = canonicalOrigin(renewed);
    const next = { materializationId: randomUUID(), requestJson, requestDigest: wireDigest(requestJson), dispatchDeadline: renewed.deadlineMs };
    validate(next);
    const won = await store.addMaterialization({ childId: child.childId, expectedGeneration: current.generation, kind: 'signature-renewal',
      canonicalContentDigest: child.canonicalContentDigest, destinationJson: child.destinationJson,
      inputDigest: wireDigest(canonicalOrigin({ originId: operation.record.originId, parentDigest: materialization.requestDigest })), materialization: next });
    if (won) return next;
  }
  return fail('browser-renewal-raced');
}
