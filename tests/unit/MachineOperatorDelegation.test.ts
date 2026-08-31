import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSigningKeyPair, pemToBase64, sign } from '../../src/core/MachineIdentity.js';
import {
  acceptMachineOperatorDelegation, machineOperatorGrantMessage, MachineOperatorDelegationReplayStore,
  verifyMachineOperatorDelegation,
} from '../../src/core/MachineOperatorDelegation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, {
  recursive: true, force: true, operation: 'MachineOperatorDelegation.test:cleanup',
}); });

describe('MachineOperatorDelegation', () => {
  it('verifies only a grant signed by the pinned recovery root over exact fields', () => {
    const recovery = generateSigningKeyPair();
    const other = generateSigningKeyPair();
    const unsigned = {
      version: 1 as const, action: 'rotate-recovery-root' as const,
      issuerMachineId: 'issuer', recipientMachineId: 'recipient', subjectMachineId: 'issuer',
      epoch: 2, contentHash: 'h', nonce: 'a'.repeat(64), issuedAt: 1000, expiresAt: 61_000,
    };
    const delegation = { ...unsigned, signature: sign(machineOperatorGrantMessage(unsigned), recovery.privateKey) };
    expect(verifyMachineOperatorDelegation(delegation, pemToBase64(recovery.publicKey))).toBe(true);
    expect(verifyMachineOperatorDelegation(delegation, pemToBase64(other.publicKey))).toBe(false);
    expect(verifyMachineOperatorDelegation({ ...delegation, recipientMachineId: 'other' }, pemToBase64(recovery.publicKey))).toBe(false);
  });

  it('allows exact idempotent retry but rejects nonce rebinding across restart', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-delegation-'));
    roots.push(root);
    const first = new MachineOperatorDelegationReplayStore(root, () => 1000);
    expect(first.authorize('b'.repeat(64), 'c'.repeat(64), 2000)).toBe('new');
    const restarted = new MachineOperatorDelegationReplayStore(root, () => 1000);
    expect(restarted.authorize('b'.repeat(64), 'c'.repeat(64), 2000)).toBe('repeat');
    expect(restarted.authorize('b'.repeat(64), 'd'.repeat(64), 2000)).toBe(false);
  });

  it('fails closed on every scoped field, expiry, and a machine-key-only signature', () => {
    const recovery = generateSigningKeyPair();
    const machine = generateSigningKeyPair();
    const unsigned = {
      version: 1 as const, action: 'acknowledge-signing-rotation' as const,
      issuerMachineId: 'issuer', recipientMachineId: 'recipient', subjectMachineId: 'subject',
      epoch: 7, contentHash: 'e'.repeat(64), nonce: 'f'.repeat(64), issuedAt: 1000, expiresAt: 2000,
    };
    const valid = { ...unsigned, signature: sign(machineOperatorGrantMessage(unsigned), recovery.privateKey) };
    const expected = { action: unsigned.action, issuerMachineId: 'issuer', recipientMachineId: 'recipient', subjectMachineId: 'subject', epoch: 7, contentHash: 'e'.repeat(64) };
    const accept = (grant: unknown, now = 1500) => acceptMachineOperatorDelegation({
      grant, expected, issuerRecoveryPublicKey: pemToBase64(recovery.publicKey), now,
    });
    expect(accept(valid)).toMatchObject({ ok: true });
    for (const changed of [
      { action: 'rotate-recovery-root' }, { issuerMachineId: 'other' }, { recipientMachineId: 'other' },
      { subjectMachineId: 'other' }, { epoch: 8 }, { contentHash: '0'.repeat(64) },
    ]) expect(accept({ ...valid, ...changed })).toMatchObject({ ok: false });
    expect(accept(valid, 2001)).toMatchObject({ ok: false });
    const machineOnly = { ...unsigned, signature: sign(machineOperatorGrantMessage(unsigned), machine.privateKey) };
    expect(accept(machineOnly)).toMatchObject({ ok: false });
  });
});
