import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { expect, it } from 'vitest';
import { ConnectViewerEnrollment, connectViewerEnrollmentMessage } from '../../src/core/ConnectViewerEnrollment.js';
import { isStrictLowSDer } from '../../src/core/MobileDeviceKeys.js';

it('requires a live, target-bound viewer proof and consumes it once', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const encoded = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url');
  const keyDigest = createHash('sha256').update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
  const binding = { agentId: 'agent-a', targetMachineId: 'machine-a', keyDigest };
  const enrollment = new ConnectViewerEnrollment(binding, 100);
  function proof(targetMachineId: string): string {
    const message = connectViewerEnrollmentMessage({ ...enrollment.challenge, targetMachineId });
    for (let attempt = 0; attempt < 100; attempt++) {
      const signature = sign('sha256', message, privateKey);
      if (isStrictLowSDer(signature)) return signature.toString('base64url');
    }
    throw new Error('could not produce low-S test signature');
  }
  const signature = proof('machine-a');
  expect(enrollment.accept(encoded, proof('machine-b'), 200)).toBeUndefined();
  expect(enrollment.accept(encoded, signature, enrollment.challenge.expiresAt)).toBeUndefined();
  expect(enrollment.accept(encoded, signature, 200)).toEqual(binding);
  expect(enrollment.accept(encoded, signature, 201)).toBeUndefined();
});
