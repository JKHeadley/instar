import { generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyConsentActivation, type ConsentActivationKind } from '../../src/core/ConnectConsentActivation.js';
import { isStrictLowSDer } from '../../src/core/MobileDeviceKeys.js';

it('verifies role-bound activation frames and rejects wrong domains, keys, and deadlines', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const wrong = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey;
  const digest = Buffer.alloc(32, 1), session = Buffer.alloc(16, 2), generation = Buffer.alloc(32, 3);
  const nonce = Buffer.alloc(32, 4);
  const deadline = Buffer.alloc(8);
  deadline.writeBigUInt64BE(1234n);
  function frame(kind: ConsentActivationKind, ...fields: Buffer[]) {
    const domain = Buffer.from('instar-connect-consent-' + kind + '-v1');
    const transcript = Buffer.concat([Buffer.from([0, domain.length]), domain, ...fields]);
    for (let attempt = 0; attempt < 100; attempt++) {
      const signature = sign('sha256', transcript, privateKey);
      if (!isStrictLowSDer(signature)) continue;
      const header = Buffer.alloc(4);
      header.writeUInt32BE(transcript.length);
      return Buffer.concat([header, transcript, Buffer.from([0, signature.length]), signature]);
    }
    throw new Error('Low-S fixture signature unavailable');
  }
  const decision = frame('decision', digest, session, nonce, generation, Buffer.from([0, 5]), Buffer.from('allow'));
  expect(verifyConsentActivation(decision, publicKey, 'decision')).toMatchObject({ decision: 'allow', nonce: nonce.toString('hex') });
  expect(verifyConsentActivation(decision, wrong, 'decision')).toBeUndefined();
  expect(verifyConsentActivation(decision, publicKey, 'confirm')).toBeUndefined();
  expect(verifyConsentActivation(frame('ack', session, digest, generation, deadline), publicKey, 'ack')).toMatchObject({ deadline: 1234 });
  expect(verifyConsentActivation(frame('confirm', digest, session, generation), publicKey, 'confirm')).toMatchObject({ sessionId: session.toString('hex') });
  expect(verifyConsentActivation(frame('active', digest, session, generation, deadline), publicKey, 'active')).toMatchObject({ deadline: 1234 });
  deadline.writeBigUInt64BE(1n << 53n);
  expect(verifyConsentActivation(frame('active', digest, session, generation, deadline), publicKey, 'active')).toBeUndefined();
});
