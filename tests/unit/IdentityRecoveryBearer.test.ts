import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  acceptIdentityRecoveryBearerResponse, identityRecoveryBearerResponseMessage,
  IdentityRecoveryBearerAuthority,
  IdentityRecoveryBearerCadence,
  shouldAttemptIdentityRecoveryBearer,
  type IdentityRecoveryBearerWire,
} from '../../src/core/IdentityRecoveryBearer.js';
import { generateEncryptionKeyPair, generateSigningKeyPair, pemToBase64, sign } from '../../src/core/MachineIdentity.js';
import { encryptForSync } from '../../src/core/SecretStore.js';

describe('IdentityRecoveryBearer authenticated response', () => {
  it('keeps the confirmed token immutable until the selected root authenticates a replacement', () => {
    const authority = new IdentityRecoveryBearerAuthority();
    authority.selectRoot('m-root-a');
    expect(authority.confirm('m-root-a', 'a'.repeat(64))).toBe(true);
    expect(authority.confirm('m-root-b', 'b'.repeat(64))).toBe(false);
    expect(authority.snapshot()).toEqual({ rootMachineId: 'm-root-a', token: 'a'.repeat(64), confirmed: true });
    authority.selectRoot('m-root-b');
    expect(authority.snapshot()).toEqual({ rootMachineId: 'm-root-b', token: undefined, confirmed: false });
    expect(authority.confirm('m-root-b', 'b'.repeat(64))).toBe(true);
  });
  const make = () => {
    const root = generateSigningKeyPair();
    const recipient = generateEncryptionKeyPair();
    const token = 'a'.repeat(64);
    const requestNonce = 'b'.repeat(64);
    const encrypted = JSON.stringify(encryptForSync({ identityRecoveryBearerToken: token }, pemToBase64(recipient.publicKey)));
    const fields = {
      responderMachineId: 'm-root', recipientMachineId: 'm-recipient', requestNonce,
      tokenHash: crypto.createHash('sha256').update(token).digest('hex'), encrypted,
    };
    const wire: IdentityRecoveryBearerWire = {
      ...fields, signature: sign(identityRecoveryBearerResponseMessage(fields), root.privateKey),
    };
    const accept = (candidate: IdentityRecoveryBearerWire, nonce = requestNonce) => acceptIdentityRecoveryBearerResponse({
      wire: candidate, expectedResponderMachineId: 'm-root', expectedRecipientMachineId: 'm-recipient',
      expectedRequestNonce: nonce, responderSigningPublicKeyPem: root.publicKey,
      recipientEncryptionPrivateKey: crypto.createPrivateKey(recipient.privateKey),
    });
    return { wire, token, accept, recipient };
  };

  it('accepts only the root-signed, recipient- and nonce-bound ciphertext', () => {
    const f = make();
    expect(f.accept(f.wire)).toBe(f.token);
    expect(f.accept({ ...f.wire, responderMachineId: 'm-other' })).toBeNull();
    expect(f.accept({ ...f.wire, recipientMachineId: 'm-other' })).toBeNull();
    expect(f.accept(f.wire, 'c'.repeat(64))).toBeNull();
    expect(f.accept({ ...f.wire, signature: 'invalid' })).toBeNull();
  });

  it('rejects substituted ciphertext and an old response replayed under a fresh nonce', () => {
    const f = make();
    const substituted = JSON.stringify(encryptForSync(
      { identityRecoveryBearerToken: 'd'.repeat(64) }, pemToBase64(f.recipient.publicKey),
    ));
    expect(f.accept({ ...f.wire, encrypted: substituted })).toBeNull();
    expect(f.accept(f.wire, 'e'.repeat(64))).toBeNull();
  });

  it('retries a stale unconfirmed local token every 30s until the root confirms it', () => {
    expect([1, 2, 3].map((tick) => shouldAttemptIdentityRecoveryBearer(false, tick))).toEqual([true, true, true]);
    expect(shouldAttemptIdentityRecoveryBearer(true, 1)).toBe(false);
    expect(shouldAttemptIdentityRecoveryBearer(true, 29)).toBe(false);
    expect(shouldAttemptIdentityRecoveryBearer(true, 30)).toBe(true);
  });

  it('reconciles an initially-root machine when a lower lexical root later joins', async () => {
    const authority = new IdentityRecoveryBearerAuthority();
    authority.selectRoot('m-b');
    authority.confirm('m-b', 'b'.repeat(64));
    let electedRoot = 'm-b';
    const cadence = new IdentityRecoveryBearerCadence({
      confirmed: () => authority.snapshot().confirmed,
      reconcile: async () => {
        authority.selectRoot(electedRoot);
        return authority.confirm(electedRoot, electedRoot === 'm-a' ? 'a'.repeat(64) : 'b'.repeat(64));
      },
    });
    electedRoot = 'm-a';
    for (let tick = 1; tick < 30; tick += 1) expect(await cadence.tick()).toBe(false);
    expect(await cadence.tick()).toBe(true);
    expect(authority.snapshot()).toEqual({ rootMachineId: 'm-a', token: 'a'.repeat(64), confirmed: true });
  });
});
