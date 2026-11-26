import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const run = promisify(execFile);
const moduleUrl = pathToFileURL(path.resolve('dist/core/AppRemovalReadCustody.js')).href;
const conversationKey = '2f0c8a3e-1b2c-4d5e-8f90-1234567890ab';

it('retains one immutable removal-read custodian across competing and restarted processes', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-removal-custody-process-'));
  const worker = `
    import { AppRemovalReadCustody } from ${JSON.stringify(moduleUrl)};
    const [dir, key, machineId] = process.argv.slice(1);
    const store = new AppRemovalReadCustody(dir);
    const result = machineId ? store.record(key, { eventId: 'creation', machineId }) : store.observe(key);
    process.stdout.write(JSON.stringify(result));
  `;
  const invoke = async (...args: string[]) => {
    const result = await run(process.execPath, ['--input-type=module', '-e', worker, stateDir, conversationKey, ...args]);
    return JSON.parse(result.stdout);
  };
  try {
    const competing = await Promise.all([invoke('m1'), invoke('m2')]);
    expect(competing.filter(Boolean)).toHaveLength(1);
    const winner = competing[0] ? 'm1' : 'm2';
    expect(await invoke()).toEqual({ kind: 'recorded', record: {
      version: 1, conversationKey, creationEventId: 'creation', custodianMachineId: winner,
    } });
    expect(await invoke(winner)).toBe(true);
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'app-removal-read-custody-e2e:cleanup' });
  }
});

it('can reopen an authenticated peer assignment while refusing a different envelope origin', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-removal-custody-import-process-'));
  const importer = pathToFileURL(path.resolve('dist/core/AppRemovalReadCustodyImport.js')).href;
  const worker = `
    import { AppRemovalReadCustody } from ${JSON.stringify(moduleUrl)};
    import { retainPeerRemovalReadCustody } from ${JSON.stringify(importer)};
    const [dir, key, origin] = process.argv.slice(1);
    const local = new AppRemovalReadCustody(dir);
    const result = origin ? retainPeerRemovalReadCustody({
      conversationKey: key, authenticatedOrigin: origin, local,
      payload: { version: 1, conversationKey: key, creationEventId: 'creation', custodianMachineId: 'm1' },
      creation: { kind: 'verified', conversationKey: key, eventId: 'creation', authenticatedOrigin: 'm1' },
    }) : local.observe(key);
    process.stdout.write(JSON.stringify(result));
  `;
  const invoke = async (...args: string[]) => {
    const result = await run(process.execPath, ['--input-type=module', '-e', worker, stateDir, conversationKey, ...args]);
    return JSON.parse(result.stdout);
  };
  try {
    expect(await invoke('peer')).toBe('refused');
    expect(await invoke()).toEqual({ kind: 'unrecorded' });
    expect(await invoke('m1')).toBe('retained');
    expect(await invoke()).toMatchObject({ kind: 'recorded', record: { creationEventId: 'creation', custodianMachineId: 'm1' } });
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'app-removal-read-custody-e2e:import-cleanup' });
  }
});

it('rechecks a signed custody admission in a fresh process', async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'app-removal-signed-custody-'));
  const core = (name: string) => JSON.stringify(new URL(name + '.js', moduleUrl).href);
  const worker = `
    import { AppRemovalReadCustody } from ${JSON.stringify(moduleUrl)};
    import { signAppRemovalCreation, verifyRetainedAppRemovalCreation } from ${core('AppRemovalCreationProof')};
    import { generateSigningKeyPair, sign } from ${core('MachineIdentity')};
    import { signerKeyHashOf } from ${core('AppRecordSignatures')};
    const [dir, conversationKey, operation, publicKey] = process.argv.slice(1);
    const store = new AppRemovalReadCustody(dir);
    const event = { kind: 'created', conversationKey, eventId: 'creation', machineId: 'm1',
      title: 'House plans', at: '2026-11-25T21:00:00.000Z' };
    if (operation === 'write') {
      const keys = generateSigningKeyPair();
      const signerKeyHash = signerKeyHashOf(keys.publicKey);
      const proof = signAppRemovalCreation('deployment-a', event, {
        machineId: () => 'm1', signerKeyHash: () => signerKeyHash,
        sign: (data) => ({ machineId: 'm1', signerKeyHash, sig: sign(data, keys.privateKey) }),
      }, 1);
      const admission = { authenticatedSender: 'm1', admittedAtMs: 2, historyRevision: 'revision-2', proof };
      if (!proof || !store.record(conversationKey, event, admission)) throw new Error('admission write failed');
      process.stdout.write(JSON.stringify(keys.publicKey));
    } else {
      const row = store.observe(conversationKey);
      const allowed = row.kind === 'recorded' && !!row.record.admission && verifyRetainedAppRemovalCreation(
        'deployment-a', event, row.record.admission,
        (admission) => operation === 'trusted' && admission.historyRevision === 'revision-2' ? publicKey : null,
      );
      process.stdout.write(JSON.stringify(allowed));
    }
  `;
  const invoke = async (...args: string[]) => {
    const result = await run(process.execPath, ['--input-type=module', '-e', worker, stateDir, conversationKey, ...args]);
    return JSON.parse(result.stdout);
  };
  try {
    const publicKey = await invoke('write');
    expect(await invoke('trusted', publicKey)).toBe(true);
    expect(await invoke('rolled-back', publicKey)).toBe(false);
  } finally {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'app-removal-read-custody-e2e:signed-cleanup' });
  }
});
