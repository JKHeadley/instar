import { describe, expect, it } from 'vitest';
import { generateSigningKeyPair, sign } from '../../src/core/MachineIdentity.js';
import {
  acceptIdentityProjectionBatch, identityProjectionBatchMessage,
} from '../../src/core/IdentityProjectionEnvelope.js';

describe('signed identity projection batch', () => {
  it('excludes tampered, wrong-responder, stale-nonce, and invalid-signature views', () => {
    const root = generateSigningKeyPair();
    const nonce = 'a'.repeat(64);
    const projections = [{
      machineId: 'm-subject', keyEpoch: 2, signingFingerprint: 'b'.repeat(32),
      recoveryEpoch: 1, recoveryFingerprint: 'c'.repeat(32), registryStatus: 'active' as const,
    }];
    const wire = {
      projections, responderMachineId: 'm-peer', nonce,
      signature: sign(identityProjectionBatchMessage(nonce, 'm-peer', projections), root.privateKey),
    };
    const accept = (candidate: typeof wire, expectedNonce = nonce) => acceptIdentityProjectionBatch({
      wire: candidate, expectedResponderMachineId: 'm-peer', expectedNonce,
      responderSigningPublicKeyPem: root.publicKey,
    });
    expect(accept(wire)).toEqual(projections);
    expect(accept({ ...wire, projections: [{ ...projections[0], signingFingerprint: 'd'.repeat(32) }] })).toBeNull();
    expect(accept({ ...wire, responderMachineId: 'm-other' })).toBeNull();
    expect(accept(wire, 'e'.repeat(64))).toBeNull();
    expect(accept({ ...wire, signature: 'invalid' })).toBeNull();
  });
});
