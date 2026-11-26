import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  createOrderedFloorReader, orderedDecisionBytes, orderedFloorReadbackBytes, verifiedOrderedSuccessor,
  type OrderedFloorChallenge, type OrderedFloorReadback, type OrderedPublicationDecision,
} from '../../src/core/OrderedPublicationWitness.js';

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

it('requires a fresh signed readback for the observed destination, commit and enrolled witness', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const scope = { agentId: 'echo', namespace: 'mobile-ingress' } as const;
  const floor = {
    ...scope, epoch: 2, holder: 'studio', witness: 'mini',
    position: 1, witnessGeneration: 3, head: '1'.repeat(64),
  };
  const pins = new Map([['mini', publicKey.export({ type: 'spki', format: 'der' }).toString('base64')]]);
  const initialCommit = 'a'.repeat(40);
  let tip = initialCommit;
  let enrolled = { id: 'mini', generation: 3 };
  let respond: (challenge: OrderedFloorChallenge) => OrderedFloorReadback | null;
  let prior: OrderedFloorReadback;
  function signed(challenge: OrderedFloorChallenge): OrderedFloorReadback {
    return { floor, signature: sign(null, orderedFloorReadbackBytes(challenge, floor), privateKey) };
  }
  const read = createOrderedFloorReader({
    destination: 'private-fixture:refs/heads/disposable',
    pins,
    readGitTip: () => tip,
    currentWitness: () => enrolled,
    readWitness: challenge => respond(challenge),
  });
  respond = challenge => (prior = signed(challenge));
  expect(read(scope)).toEqual(floor);
  respond = () => prior;
  expect(read(scope)).toBeNull();
  respond = challenge => signed({ ...challenge, destination: 'other:refs/heads/disposable' });
  expect(read(scope)).toBeNull();
  respond = challenge => signed({ ...challenge, commit: 'b'.repeat(40) });
  expect(read(scope)).toBeNull();
  respond = challenge => {
    tip = 'b'.repeat(40);
    return signed(challenge);
  };
  expect(read(scope)).toBeNull();
  tip = initialCommit;
  respond = challenge => {
    enrolled = { id: 'm5', generation: 4 };
    return signed(challenge);
  };
  expect(read(scope)).toBeNull();
  respond = () => null;
  expect(read(scope)).toBeNull();
});
