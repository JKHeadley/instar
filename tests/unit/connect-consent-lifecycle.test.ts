import { createPublicKey } from 'node:crypto';
import { expect, it } from 'vitest';
import { ConnectConsentLifecycle } from '../../src/core/ConnectConsentLifecycle.js';
import vectors from '../fixtures/connect/connect-consent-activation-v1.json';

const [decision, ack, confirmation] = vectors.frames;
const request = {
  sessionId: decision.sessionId.replaceAll('-', ''),
  generation: decision.generation,
  nonce: '04'.repeat(32),
  requestDigest: decision.referencedDigest,
  expiresAt: 1795665601000,
};
const now = 1795665596000;
const bytes = (frame: { frameHex: string }) => Buffer.from(frame.frameHex, 'hex');
const companion = createPublicKey(vectors.publicKeys.companion);
const agent = createPublicKey(vectors.publicKeys.agent);

it('consumes one correctly chained activation and refuses replay', () => {
  const flow = new ConnectConsentLifecycle(request, companion, agent, () => true);
  expect(flow.confirm(bytes(confirmation), now)).toBeUndefined();
  expect(flow.decide(bytes(decision), now)).toBe('allow');
  expect(flow.prepare(bytes(ack), now)).toBe(true);
  expect(flow.confirm(bytes(confirmation), now)).toEqual(request);
  expect(flow.confirm(bytes(confirmation), now)).toBeUndefined();
});

it('refuses the wrong connection, request digest, or lost activation deadline', () => {
  for (const pending of [{ ...request, generation: '00'.repeat(32) }, { ...request, requestDigest: '00'.repeat(32) }]) {
    const flow = new ConnectConsentLifecycle(pending, companion, agent, () => true);
    expect(flow.decide(bytes(decision), now)).toBeUndefined();
  }
  const flow = new ConnectConsentLifecycle(request, companion, agent, () => true);
  expect(flow.decide(bytes(decision), now)).toBe('allow');
  expect(flow.prepare(bytes(ack), now)).toBe(true);
  expect(flow.confirm(bytes(confirmation), now + 4000)).toBeUndefined();
});

it('refuses confirmation after pairing revocation or cancellation', () => {
  for (const invalidate of ['revoke', 'cancel']) {
    let current = true;
    const flow = new ConnectConsentLifecycle(request, companion, agent, () => current);
    expect(flow.decide(bytes(decision), now)).toBe('allow');
    expect(flow.prepare(bytes(ack), now)).toBe(true);
    if (invalidate === 'revoke') current = false;
    else flow.cancel();
    expect(flow.confirm(bytes(confirmation), now)).toBeUndefined();
  }
});
