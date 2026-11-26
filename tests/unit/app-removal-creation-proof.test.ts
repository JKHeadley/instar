import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppRemovalReadCustody } from '../../src/core/AppRemovalReadCustody.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { expect, it } from 'vitest';
import { generateSigningKeyPair, sign } from '../../src/core/MachineIdentity.js';
import { signerKeyHashOf } from '../../src/core/AppRecordSignatures.js';
import { signAppRemovalCreation, verifyNewAppRemovalCreation, verifyRetainedAppRemovalCreation } from '../../src/core/AppRemovalCreationProof.js';

const creation = {
  kind: 'created' as const, conversationKey: '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab',
  eventId: 'creation-a', machineId: 'm1', title: 'House plans', at: '2026-11-25T21:00:00.000Z',
};

it('binds the full record, deployment, sender and eligible key at first admission', () => {
  const keys = generateSigningKeyPair();
  const signerKeyHash = signerKeyHashOf(keys.publicKey);
  const signer = {
    machineId: () => 'm1', signerKeyHash: () => signerKeyHash,
    sign: (data: string) => ({ machineId: 'm1', signerKeyHash, sig: sign(data, keys.privateKey) }),
  };
  const proof = signAppRemovalCreation('deployment-a', creation, signer, 1)!;
  const currentKey = () => keys.publicKey;
  expect(verifyNewAppRemovalCreation('deployment-a', creation, proof, 'm1', currentKey)).toBe(true);
  expect(verifyNewAppRemovalCreation('deployment-b', creation, proof, 'm1', currentKey)).toBe(false);
  expect(verifyNewAppRemovalCreation('deployment-a', { ...creation, title: 'Changed' }, proof, 'm1', currentKey)).toBe(false);
  expect(verifyNewAppRemovalCreation('deployment-a', { ...creation, eventId: 'changed' }, proof, 'm1', currentKey)).toBe(false);
  expect(verifyNewAppRemovalCreation('deployment-a', creation, proof, 'm2', currentKey)).toBe(false);
  expect(verifyNewAppRemovalCreation('deployment-a', creation, proof, 'm1', () => null)).toBe(false);
  expect(verifyNewAppRemovalCreation('deployment-a', creation, proof, 'm1', () => generateSigningKeyPair().publicKey)).toBe(false);
  const admission = { proof, authenticatedSender: 'm1', admittedAtMs: 2, historyRevision: 'revision-2' };
  const reopened = JSON.parse(JSON.stringify(admission)) as typeof admission;
  const retainedAuthority = (saved: typeof admission) =>
    saved.historyRevision === 'revision-2' && saved.admittedAtMs === 2 ? keys.publicKey : null;
  expect(verifyRetainedAppRemovalCreation('deployment-a', creation, reopened, retainedAuthority)).toBe(true);
  expect(verifyRetainedAppRemovalCreation('deployment-a', creation, { ...reopened, historyRevision: 'revision-1' }, retainedAuthority)).toBe(false);
  expect(verifyRetainedAppRemovalCreation('deployment-a', creation, reopened, () => null)).toBe(false);
  expect(verifyRetainedAppRemovalCreation('deployment-a', creation, { ...reopened, authenticatedSender: 'm2' }, retainedAuthority)).toBe(false);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'app-removal-creation-proof-'));
  try {
    const custody = new AppRemovalReadCustody(directory, 'signed-peer');
    const local = new AppRemovalReadCustody(directory);
    expect(local.record(creation.conversationKey, creation, admission)).toBe(false);
    expect(custody.record(creation.conversationKey, creation)).toBe(false);
    expect(custody.record(creation.conversationKey, creation, admission)).toBe(true);
    expect(local.observe(creation.conversationKey)).toEqual({ kind: 'unrecorded' });
    expect(local.record(creation.conversationKey, creation)).toBe(true);
    expect(custody.record(creation.conversationKey, creation, { ...admission, admittedAtMs: 3 })).toBe(false);
    const retained = new AppRemovalReadCustody(directory, 'signed-peer').observe(creation.conversationKey);
    expect(retained).toMatchObject({ kind: 'recorded', record: { admission } });
    if (retained.kind !== 'recorded' || !retained.record.admission) throw new Error('missing durable admission');
    expect(verifyRetainedAppRemovalCreation('deployment-a', creation, retained.record.admission, retainedAuthority)).toBe(true);
    const file = path.join(directory, 'state', 'app-removal-signed-peer-custody', creation.conversationKey + '.json');
    fs.writeFileSync(file, JSON.stringify({ ...retained.record, admission: { ...admission, authenticatedSender: 'm2' } }));
    expect(new AppRemovalReadCustody(directory, 'signed-peer').observe(creation.conversationKey)).toEqual({ kind: 'unavailable' });
  } finally {
    SafeFsExecutor.safeRmSync(directory, { recursive: true, force: true, operation: 'app-removal-creation-proof-test:cleanup' });
  }
});
