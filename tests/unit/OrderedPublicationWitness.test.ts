import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { orderedDecisionBytes, verifiedOrderedSuccessor, type OrderedPublicationDecision } from '../../src/core/OrderedPublicationWitness.js';

it('binds a witness signature to exact scope, bytes and generation', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pins = new Map([['mini', publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]]);
  const payload = 'reviewed payload';
  const decision: OrderedPublicationDecision = {
    agentId: 'echo', namespace: 'needs-you', epoch: 2, holder: 'studio', witness: 'mini',
    position: 0, witnessGeneration: 1, head: '1'.repeat(64), operationKey: 'operation',
    payloadDigest: createHash('sha256').update(payload).digest('hex'),
  };
  const signature = sign(null, orderedDecisionBytes(decision), privateKey);
  expect(verifiedOrderedSuccessor(decision, decision, payload, signature, pins)?.position).toBe(1);
  expect(verifiedOrderedSuccessor(decision, decision, 'substitution', signature, pins)).toBeNull();
  for (const changed of [
    { ...decision, namespace: 'mobile-ingress' as const },
    { ...decision, namespace: 'delete' as const },
    { ...decision, epoch: 3 },
    { ...decision, witnessGeneration: 2 },
    { ...decision, holder: 'mini' },
  ]) expect(verifiedOrderedSuccessor(changed, changed, payload, signature, pins)).toBeNull();
});
