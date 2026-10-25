import { describe, expect, it } from 'vitest';
import { base64ToSigningPem, generateSigningKeyPair, pemToBase64, sign, verify } from '../../src/core/MachineIdentity.js';
import {
  MachineRecoveryKey,
  recoveryContinuityMessage,
  signingRotationMessage,
  verifyRecoveryContinuity,
  verifySigningPossession,
  type RecoverySecretStore,
  type RotationBinding,
} from '../../src/core/MachineRecoveryKey.js';
import { machineOperatorGrantMessage } from '../../src/core/MachineOperatorDelegation.js';
import type { MachineIdentity } from '../../src/core/types.js';

class FakeStore implements RecoverySecretStore {
  readonly values = new Map<string, unknown>();
  constructor(public isKeychainBacked: boolean) {}
  get(key: string): unknown { return this.values.get(key); }
  set(key: string, value: unknown): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
}

function binding(): { value: RotationBinding; signingPrivate: string } {
  const pair = generateSigningKeyPair();
  return {
    signingPrivate: pair.privateKey,
    value: {
      nonce: 'a'.repeat(64),
      claimantMachineId: 'm_claimant',
      newSigningPublicKey: pemToBase64(pair.publicKey),
      newEncryptionPublicKey: 'new-encryption',
      challengerMachineId: 'm_peer',
      keyEpoch: 2,
      recoveryEpoch: 1,
    },
  };
}

describe('MachineRecoveryKey', () => {
  it('never mints into a file-backed store', () => {
    const store = new FakeStore(false);
    expect(new MachineRecoveryKey(store).ensure('m_a')).toBeNull();
    expect(store.values.size).toBe(0);
  });

  it('mints once and returns the same key material idempotently', () => {
    const store = new FakeStore(true);
    const recovery = new MachineRecoveryKey(store);
    const first = recovery.ensure('m_a');
    const second = recovery.ensure('m_a');
    expect(first).toEqual(second);
    expect(first).toMatchObject({ recoveryEpoch: 1 });
    expect(recovery.has('m_a')).toBe(true);
  });

  it('rotates to the exact next recovery generation through a replayable vault record', () => {
    const store = new FakeStore(true);
    const recovery = new MachineRecoveryKey(store);
    const first = recovery.ensure('m_a')!;
    const rotated = recovery.rotate('m_a', first.recoveryEpoch, first.recoveryPublicKey)!;
    expect(rotated.recoveryEpoch).toBe(first.recoveryEpoch + 1);
    expect(rotated.recoveryPublicKey).not.toBe(first.recoveryPublicKey);
    expect(recovery.has('m_a')).toBe(true);
    expect(store.values.has('machineIdentityRecovery.m_a.pendingRotation')).toBe(false);
  });

  it('retains the old signing root and intent while peers are pending, then erases both on completion', () => {
    const store = new FakeStore(true);
    const recovery = new MachineRecoveryKey(store);
    const first = recovery.ensure('m_a')!;
    const next = recovery.prepareRotation('m_a', first.recoveryEpoch, first.recoveryPublicKey)!;
    const identity = {
      machineId: 'm_a', name: 'a', platform: 'test', createdAt: '2026-08-30T00:00:00Z', capabilities: [],
      signingPublicKey: 'sign', encryptionPublicKey: 'enc', keyEpoch: 0,
      recoveryPublicKey: next.recoveryPublicKey, recoveryEpoch: next.recoveryEpoch,
      recoveryAnchorProvenance: 'first-hand',
    } as MachineIdentity;
    const unsigned = {
      version: 1 as const, action: 'rotate-recovery-root' as const,
      issuerMachineId: 'm_a', recipientMachineId: 'm_b', subjectMachineId: 'm_a',
      epoch: 2, contentHash: 'a'.repeat(64), nonce: 'b'.repeat(64),
      issuedAt: 1, expiresAt: 999999,
    };
    recovery.attachRotationPropagationIntent('m_a', identity, {
      m_b: { ...unsigned, signature: 'already-signed' },
    });
    recovery.commitRotation('m_a');
    expect(store.values.has('machineIdentityRecovery.m_a.pendingRotation')).toBe(true);
    expect(recovery.loadRotationPropagationIntent('m_a')?.machineIdentity.recoveryEpoch).toBe(2);
    const retainedSignature = recovery.signRetainedOperatorGrant('m_a', unsigned)!;
    expect(verify(machineOperatorGrantMessage(unsigned), retainedSignature, base64ToSigningPem(first.recoveryPublicKey))).toBe(true);
    expect(recovery.finalizeRotationPropagation('m_a', 1)).toBe(false);
    expect(recovery.finalizeRotationPropagation('m_a', 2)).toBe(true);
    expect(store.values.has('machineIdentityRecovery.m_a.pendingRotation')).toBe(false);
    expect(recovery.has('m_a')).toBe(true);
  });

  it('never mints a deceptive replacement when an established public root lost its private half', () => {
    const store = new FakeStore(true);
    const recovery = new MachineRecoveryKey(store);
    expect(recovery.ensure('m_a', 1, 'already-established-public-key')).toBeNull();
    expect(recovery.has('m_a')).toBe(false);
  });

  it('fails closed when the escrow private and public halves do not match', () => {
    const store = new FakeStore(true);
    const recovery = new MachineRecoveryKey(store);
    const original = recovery.ensure('m_a')!;
    const other = generateSigningKeyPair();
    store.set('machineIdentityRecovery.m_a.publicKey', pemToBase64(other.publicKey));

    expect(recovery.has('m_a')).toBe(false);
    expect(recovery.ensure('m_a', original.recoveryEpoch, original.recoveryPublicKey)).toBeNull();
    expect(recovery.signContinuity('m_a', binding().value)).toBeNull();
  });

  it('fails closed on malformed escrow key material', () => {
    const store = new FakeStore(true);
    store.set('machineIdentityRecovery.m_a.privateKeyPem', 'not-a-private-key');
    store.set('machineIdentityRecovery.m_a.publicKey', 'not-a-public-key');
    const recovery = new MachineRecoveryKey(store);

    expect(recovery.has('m_a')).toBe(false);
    expect(recovery.ensure('m_a')).toBeNull();
  });

  it('verifies both new-key possession and recovery continuity over bound fields', () => {
    const store = new FakeStore(true);
    const recovery = new MachineRecoveryKey(store);
    const material = recovery.ensure('m_claimant')!;
    const { value, signingPrivate } = binding();
    value.newRecoveryPublicKey = material.recoveryPublicKey;
    const possession = sign(signingRotationMessage(value), signingPrivate);
    const continuity = recovery.signContinuity('m_claimant', value)!;
    expect(verifySigningPossession(value, possession)).toBe(true);
    expect(verifyRecoveryContinuity(value, continuity, material.recoveryPublicKey)).toBe(true);
    expect(verifyRecoveryContinuity({ ...value, keyEpoch: 3 }, continuity, material.recoveryPublicKey)).toBe(false);
  });

  it('destroys every escrow field', () => {
    const store = new FakeStore(true);
    const recovery = new MachineRecoveryKey(store);
    recovery.ensure('m_a');
    recovery.destroy('m_a');
    expect(store.values.size).toBe(0);
  });

  it('retains a public identity snapshot outside the machine directory', () => {
    const store = new FakeStore(true);
    const recovery = new MachineRecoveryKey(store);
    const material = recovery.ensure('m_a')!;
    recovery.rememberIdentity({
      machineId: 'm_a', signingPublicKey: 'signing', encryptionPublicKey: 'encryption',
      name: 'studio', platform: 'darwin-arm64', createdAt: '2026-08-30T00:00:00Z', capabilities: ['sessions'],
      keyEpoch: 4, recoveryPublicKey: material.recoveryPublicKey, recoveryEpoch: material.recoveryEpoch,
      recoveryAnchorProvenance: 'first-hand',
    });
    expect(recovery.recoverIdentitySnapshot()).toMatchObject({
      machineId: 'm_a', name: 'studio', signingPublicKey: 'signing', recoveryPublicKey: material.recoveryPublicKey,
    });
  });

  it('rejects a self-consistent escrow pair that does not match the snapshot-pinned recovery root', () => {
    const store = new FakeStore(true);
    const recovery = new MachineRecoveryKey(store);
    const material = recovery.ensure('m_a')!;
    recovery.rememberIdentity({
      machineId: 'm_a', signingPublicKey: 'signing', encryptionPublicKey: 'encryption',
      name: 'studio', platform: 'darwin-arm64', createdAt: '2026-08-30T00:00:00Z', capabilities: ['sessions'],
      keyEpoch: 4, recoveryPublicKey: material.recoveryPublicKey, recoveryEpoch: material.recoveryEpoch,
      recoveryAnchorProvenance: 'first-hand',
    });
    const substitute = generateSigningKeyPair();
    store.set('machineIdentityRecovery.m_a.privateKeyPem', substitute.privateKey);
    store.set('machineIdentityRecovery.m_a.publicKey', pemToBase64(substitute.publicKey));

    expect(recovery.has('m_a')).toBe(true);
    expect(recovery.has('m_a', material.recoveryPublicKey)).toBe(false);
    expect(recovery.recoverIdentitySnapshot()).toBeNull();
  });

  it('cannot sign operator grants or prepare rotation under a substituted escrow root', () => {
    const store = new FakeStore(true);
    const recovery = new MachineRecoveryKey(store);
    const pinned = recovery.ensure('m_a')!;
    const substitute = generateSigningKeyPair();
    store.set('machineIdentityRecovery.m_a.privateKeyPem', substitute.privateKey);
    store.set('machineIdentityRecovery.m_a.publicKey', pemToBase64(substitute.publicKey));
    const unsigned = {
      version: 1 as const, action: 'acknowledge-signing-rotation' as const,
      issuerMachineId: 'm_a', recipientMachineId: 'm_b', subjectMachineId: 'm_b',
      epoch: 1, contentHash: 'a'.repeat(64), nonce: 'b'.repeat(64), issuedAt: 1, expiresAt: 2,
    };
    const before = JSON.stringify([...store.values]);

    expect(recovery.signOperatorGrant('m_a', pinned.recoveryPublicKey, unsigned)).toBeNull();
    expect(recovery.prepareRotation('m_a', pinned.recoveryEpoch, pinned.recoveryPublicKey)).toBeNull();
    expect(JSON.stringify([...store.values])).toBe(before);
  });
});
