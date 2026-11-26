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
function clock() {
  return { wallTime: now, monoTime: 0, wall() { return this.wallTime; }, monotonic() { return this.monoTime; } };
}
const accept = () => true;
const bytes = (frame: { frameHex: string }) => Buffer.from(frame.frameHex, 'hex');
const companion = createPublicKey(vectors.publicKeys.companion);
const agent = createPublicKey(vectors.publicKeys.agent);

it('consumes one correctly chained activation and refuses replay', () => {
  const flow = new ConnectConsentLifecycle(request, companion, agent, () => true, clock());
  expect(flow.confirm(bytes(confirmation), accept)).toBe(false);
  expect(flow.decide(bytes(decision))).toBe('allow');
  expect(flow.prepare(bytes(ack))).toBe(true);
  expect(flow.confirm(bytes(confirmation), value => value === flow.request)).toBe(true);
  expect(flow.confirm(bytes(confirmation), accept)).toBe(false);
});

it('refuses the wrong connection, request digest, or lost activation deadline', () => {
  for (const pending of [{ ...request, generation: '00'.repeat(32) }, { ...request, requestDigest: '00'.repeat(32) }]) {
    const flow = new ConnectConsentLifecycle(pending, companion, agent, () => true, clock());
    expect(flow.decide(bytes(decision))).toBeUndefined();
  }
  const time = clock();
  const flow = new ConnectConsentLifecycle(request, companion, agent, () => true, time);
  expect(flow.decide(bytes(decision))).toBe('allow');
  expect(flow.prepare(bytes(ack))).toBe(true);
  time.monoTime = 4000;
  expect(flow.confirm(bytes(confirmation), accept)).toBe(false);
  time.monoTime = 0;
  expect(flow.confirm(bytes(confirmation), accept)).toBe(false);
});

it('refuses confirmation after pairing revocation or cancellation', () => {
  for (const invalidate of ['revoke', 'cancel']) {
    let current = true;
    const flow = new ConnectConsentLifecycle(request, companion, agent, () => current, clock());
    expect(flow.decide(bytes(decision))).toBe('allow');
    expect(flow.prepare(bytes(ack))).toBe(true);
    if (invalidate === 'revoke') current = false;
    else flow.cancel();
    expect(flow.confirm(bytes(confirmation), accept)).toBe(false);
    current = true;
    expect(flow.confirm(bytes(confirmation), accept)).toBe(false);
  }
});
