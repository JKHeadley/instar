/**
 * Unit tests for WS5.2 R4b — de-pair X25519 key-rotation + durable epoch anchor
 * (PairingEpochManager.ts) — spec §8.1, §8.4.
 *
 * Proves: stable identity across "reboot" (anchor reload), rotation bumps epoch + changes key,
 * a credential sealed to the pre-rotation key is undecryptable after rotation (the R4b effect),
 * and the encrypted-store-backed anchor round-trips.
 */

import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  PairingEpochManager,
  secretStoreKeyAnchor,
  type PairingKeyAnchor,
  type PairingEpochState,
  type EncryptedKvStore,
} from '../../src/core/PairingEpochManager.js';
import {
  encryptAccountCredential,
  decryptAccountCredential,
  type AccountCredentialAAD,
} from '../../src/core/SecretStore.js';

function memoryAnchor(): PairingKeyAnchor {
  let s: PairingEpochState | null = null;
  return { load: () => s, save: (v) => { s = v; } };
}

function memoryKv(): EncryptedKvStore {
  const m = new Map<string, unknown>();
  return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); } };
}

function aadFor(pub: string, epoch: number): AccountCredentialAAD {
  return { recipientFingerprint: 'fp-mini', accountId: 'a1', mandateId: 'M1', grantId: 'g1', pairingEpoch: epoch };
}

describe('PairingEpochManager (WS5.2 R4b)', () => {
  it('initializes epoch 0 and returns a stable identity across reload (reboot)', () => {
    const anchor = memoryAnchor();
    const m1 = new PairingEpochManager(anchor);
    const a = m1.current();
    expect(a.epoch).toBe(0);
    // A fresh manager over the SAME anchor = a reboot: same key + epoch.
    const m2 = new PairingEpochManager(anchor);
    const b = m2.current();
    expect(b.epoch).toBe(0);
    expect(b.publicKeyB64).toBe(a.publicKeyB64);
  });

  it('rotateOnDepair bumps the epoch and changes the key', () => {
    const m = new PairingEpochManager(memoryAnchor());
    const before = m.current();
    const rot = m.rotateOnDepair();
    expect(rot.epoch).toBe(before.epoch + 1);
    expect(rot.publicKeyB64).not.toBe(before.publicKeyB64);
    expect(m.currentEpoch()).toBe(before.epoch + 1);
    expect(m.currentPublicKeyB64()).toBe(rot.publicKeyB64);
  });

  it('a credential sealed to the pre-rotation key is UNDECRYPTABLE after de-pair (R4b effect)', () => {
    const m = new PairingEpochManager(memoryAnchor());
    const before = m.current();
    const sealed = encryptAccountCredential({ tok: 'x' }, before.publicKeyB64, aadFor(before.publicKeyB64, before.epoch));
    // Sanity: decrypts fine before rotation.
    expect(decryptAccountCredential(sealed, before.privateKey, aadFor(before.publicKeyB64, before.epoch))).toEqual({ tok: 'x' });
    // De-pair rotates the key.
    m.rotateOnDepair();
    const after = m.current();
    // The new private key cannot open the old blob; and the epoch no longer matches.
    expect(() => decryptAccountCredential(sealed, after.privateKey, aadFor(before.publicKeyB64, before.epoch))).toThrow();
    expect(() => decryptAccountCredential(sealed, after.privateKey, aadFor(after.publicKeyB64, after.epoch))).toThrow();
  });

  it('encrypted-store-backed anchor round-trips and survives a fresh manager (reboot)', () => {
    const kv = memoryKv();
    const m1 = new PairingEpochManager(secretStoreKeyAnchor(kv));
    const a = m1.current();
    m1.rotateOnDepair();
    const epochAfter = m1.currentEpoch();
    // New manager reading the SAME store recovers the rotated state.
    const m2 = new PairingEpochManager(secretStoreKeyAnchor(kv));
    expect(m2.currentEpoch()).toBe(epochAfter);
    expect(m2.currentEpoch()).toBe(a.epoch + 1);
  });

  it('a malformed anchor record is treated as absent (re-initializes, never crashes)', () => {
    const kv = memoryKv();
    kv.set('multiMachine.accountFollowMe.pairingKey', { garbage: true });
    const m = new PairingEpochManager(secretStoreKeyAnchor(kv));
    expect(m.current().epoch).toBe(0);
  });
});
