/**
 * Unit tests for the WS5.2 Account Follow-Me AAD-bound credential crypto pair
 * (`encryptAccountCredential` / `decryptAccountCredential`) — spec §8.1, R3/I2.
 *
 * These are the FIRST-PR shared security primitives. They prove the secure
 * mechanism exists BEFORE any credential-bearing code path is wired (CMT-1413).
 *
 * Covered properties:
 *  - AAD fail-closed: decrypt throws on absent / wrong AAD (gap 2).
 *  - Recipient binding: a blob sealed for machine X fails on machine Y (S1/S2).
 *  - Post-rotation inertness: rotating the recipient X25519 key (a fresh keypair)
 *    makes an old sealed blob undecryptable (R4b key-rotation effect, S3/S4).
 *  - Domain separation: a credential blob can NOT be consumed by the permissive
 *    secret-sync decryptor, and a secret-sync blob can NOT be consumed here
 *    (the §3.1 foundational finding — defense in depth on the wire-verb split).
 *  - AAD field binding: account / mandate / grant / epoch mismatch all fail.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  encryptAccountCredential,
  decryptAccountCredential,
  encryptForSync,
  decryptFromSync,
  type AccountCredentialAAD,
  type EncryptedAccountCredentialPayload,
} from '../../src/core/SecretStore.js';

/** Make an X25519 keypair, returning the raw 32-byte public key (base64) + private KeyObject. */
function makeX25519(): { publicKeyB64: string; privateKey: crypto.KeyObject } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const raw = spki.subarray(spki.length - 32);
  return { publicKeyB64: raw.toString('base64'), privateKey };
}

function baseAAD(overrides: Partial<AccountCredentialAAD> = {}): AccountCredentialAAD {
  return {
    recipientFingerprint: 'fp-machine-x',
    accountId: 'acct-personal-1',
    mandateId: 'MND-001',
    grantId: 'grant-abc',
    pairingEpoch: 0,
    ...overrides,
  };
}

const SECRET = { authToken: 's3cr3t-value', email: 'user@example.com' };

describe('account-credential crypto (WS5.2 R3/I2)', () => {
  it('round-trips with the correct recipient key and matching AAD', () => {
    const r = makeX25519();
    const aad = baseAAD({ recipientFingerprint: 'fp-r' });
    const payload = encryptAccountCredential(SECRET, r.publicKeyB64, aad);
    const out = decryptAccountCredential(payload, r.privateKey, aad);
    expect(out).toEqual(SECRET);
  });

  it('the sealed AAD is returned field-ordered and authenticated, never confidential', () => {
    const r = makeX25519();
    const payload = encryptAccountCredential(SECRET, r.publicKeyB64, baseAAD());
    expect(payload.aad).toMatchObject(baseAAD());
    // ciphertext must not contain the plaintext secret
    const ct = Buffer.from(payload.ciphertext, 'base64').toString('latin1');
    expect(ct.includes('s3cr3t-value')).toBe(false);
  });

  it('FAILS CLOSED when expectedAAD is absent', () => {
    const r = makeX25519();
    const payload = encryptAccountCredential(SECRET, r.publicKeyB64, baseAAD());
    // @ts-expect-error intentionally omitting required arg
    expect(() => decryptAccountCredential(payload, r.privateKey, undefined)).toThrow(/AAD/);
  });

  it('FAILS CLOSED when the payload AAD is stripped', () => {
    const r = makeX25519();
    const payload = encryptAccountCredential(SECRET, r.publicKeyB64, baseAAD());
    const tampered = { ...payload, aad: undefined } as unknown as EncryptedAccountCredentialPayload;
    expect(() => decryptAccountCredential(tampered, r.privateKey, baseAAD())).toThrow(/AAD/);
  });

  it('FAILS CLOSED on any AAD field mismatch (account / mandate / grant / epoch / recipient)', () => {
    const r = makeX25519();
    const sealed = baseAAD();
    const payload = encryptAccountCredential(SECRET, r.publicKeyB64, sealed);
    for (const wrong of [
      baseAAD({ accountId: 'acct-OTHER' }),
      baseAAD({ mandateId: 'MND-999' }),
      baseAAD({ grantId: 'grant-REPLAYED' }),
      baseAAD({ pairingEpoch: 1 }),
      baseAAD({ recipientFingerprint: 'fp-OTHER' }),
    ]) {
      expect(() => decryptAccountCredential(payload, r.privateKey, wrong)).toThrow();
    }
  });

  it('a blob sealed for machine X cannot be decrypted with machine Y key (recipient binding)', () => {
    const x = makeX25519();
    const y = makeX25519();
    const aad = baseAAD();
    const payload = encryptAccountCredential(SECRET, x.publicKeyB64, aad);
    // Even with the SAME (matching) AAD, the wrong private key cannot decrypt.
    expect(() => decryptAccountCredential(payload, y.privateKey, aad)).toThrow();
  });

  it('after recipient key rotation (fresh keypair), an old sealed blob is undecryptable (R4b)', () => {
    const before = makeX25519();
    const aad = baseAAD();
    const payload = encryptAccountCredential(SECRET, before.publicKeyB64, aad);
    // De-pair rotates the recipient X25519 key — model as a new keypair.
    const after = makeX25519();
    expect(() => decryptAccountCredential(payload, after.privateKey, aad)).toThrow();
  });

  it('domain separation: a secret-sync blob CANNOT be consumed as an account credential', () => {
    const r = makeX25519();
    const syncPayload = encryptForSync(SECRET, r.publicKeyB64);
    const asCred = { ...syncPayload, aad: baseAAD() } as unknown as EncryptedAccountCredentialPayload;
    // Distinct HKDF info → derived key differs → GCM tag fails.
    expect(() => decryptAccountCredential(asCred, r.privateKey, baseAAD())).toThrow();
  });

  it('domain separation: an account-credential blob CANNOT be consumed by the legacy secret-sync decryptor', () => {
    const r = makeX25519();
    const credPayload = encryptAccountCredential(SECRET, r.publicKeyB64, baseAAD());
    // decryptFromSync has no AAD concept and a different HKDF info — must NOT yield the secret.
    expect(() => decryptFromSync(credPayload as unknown as Parameters<typeof decryptFromSync>[0], r.privateKey)).toThrow();
  });

  it('rejects a malformed AAD (missing field / wrong type / extra key) at seal time', () => {
    const r = makeX25519();
    expect(() => encryptAccountCredential(SECRET, r.publicKeyB64, baseAAD({ pairingEpoch: -1 }))).toThrow();
    expect(() =>
      encryptAccountCredential(SECRET, r.publicKeyB64, { ...baseAAD(), extra: 'x' } as unknown as AccountCredentialAAD),
    ).toThrow();
    expect(() =>
      encryptAccountCredential(SECRET, r.publicKeyB64, { ...baseAAD(), accountId: '' }),
    ).toThrow();
  });
});
