import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateEncryptionKeyPair, generateSigningKeyPair, MachineIdentityManager, pemToBase64 } from '../../src/core/MachineIdentity.js';
import { enforceMachineIdentityBootRecovery, runMachineIdentityBootRecovery } from '../../src/core/MachineIdentityBootRecovery.js';
import { MachineRecoveryKey, type RecoverySecretStore } from '../../src/core/MachineRecoveryKey.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

class RecordingKeychain implements RecoverySecretStore {
  isKeychainBacked = true;
  values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  set(key: string, value: unknown): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
}

const roots: string[] = [];
const removeTree = (target: string) => SafeFsExecutor.safeRmSync(target, {
  recursive: true, force: true, operation: 'machine-identity-boot-recovery.test:cleanup',
});
afterEach(() => { for (const root of roots.splice(0)) removeTree(root); });

function digestTree(root: string): string {
  const rows: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else rows.push(`${path.relative(root, file)}:${fs.readFileSync(file).toString('base64')}`);
    }
  };
  walk(root);
  return crypto.createHash('sha256').update(rows.join('\n')).digest('hex');
}

describe('machine identity production boot recovery', () => {
  it('dry-run is byte-identical across identity, PEM, epoch, ledger, and escrow stores', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-boot-dry-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    const manager = new MachineIdentityManager(stateDir);
    await manager.generateIdentity({ name: 'dry', role: 'awake' });
    const keychain = new RecordingKeychain();
    keychain.values.set('sentinel', { unchanged: true });
    const beforeTree = digestTree(root);
    const beforeEscrow = JSON.stringify([...keychain.values]);
    const config = {
      projectName: 'dry', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: {
        identityReannounce: { enabled: true, dryRun: true },
        observedEndpoints: { enabled: true, dryRun: true },
        recoveryKeyEscrow: { enabled: true, dryRun: true },
      },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    expect(await runMachineIdentityBootRecovery({ config, manager, recoveryStore: keychain })).toBe('dry-run');
    expect(digestTree(root)).toBe(beforeTree);
    expect(JSON.stringify([...keychain.values])).toBe(beforeEscrow);
  });

  it('live recovery failure stops the production boot barrier before coordinator/session startup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-boot-failclosed-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    const config = {
      projectName: 'live', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: false } },
      messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    let coordinatorStarted = false;
    await expect((async () => {
      await enforceMachineIdentityBootRecovery({
        config,
        run: async () => { throw new Error('injected escrow read fault'); },
      });
      coordinatorStarted = true;
    })()).rejects.toThrow('failed closed before coordinator start');
    expect(coordinatorStarted).toBe(false);
  });

  it('rejects a non-throwing unrecoverable missing identity instead of falling back awake', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-boot-missing-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    const manager = new MachineIdentityManager(stateDir);
    await manager.generateIdentity({ name: 'lost', role: 'awake' });
    removeTree(path.join(stateDir, 'machine'));
    const config = {
      projectName: 'live', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: false } }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    await expect(enforceMachineIdentityBootRecovery({
      config, manager, recoveryStore: new RecordingKeychain(), run: async () => 'unchanged',
    })).rejects.toThrow('established machine identity remains absent');
  });

  it('rejects identity.json with missing PEM material when escrow cannot restore it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-boot-partial-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    const manager = new MachineIdentityManager(stateDir);
    await manager.generateIdentity({ name: 'partial', role: 'awake' });
    removeTree(path.join(stateDir, 'machine', 'signing-key.pem'));
    const config = {
      projectName: 'live', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: false } }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    await expect(enforceMachineIdentityBootRecovery({
      config, manager, recoveryStore: new RecordingKeychain(),
    })).rejects.toThrow('private key material remains invalid or incomplete');
  });

  it('recovers malformed private keys from escrow before coordinator startup', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-boot-malformed-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    const manager = new MachineIdentityManager(stateDir);
    const identity = await manager.generateIdentity({ name: 'malformed', role: 'awake' });
    const keychain = new RecordingKeychain();
    const recovery = new MachineRecoveryKey(keychain);
    const material = recovery.ensure(identity.machineId, identity.recoveryEpoch ?? 0, identity.recoveryPublicKey);
    manager.establishLocalRecoveryKey(material!);
    fs.writeFileSync(path.join(stateDir, 'machine', 'signing-key.pem'), 'not a private key');
    fs.writeFileSync(path.join(stateDir, 'machine', 'encryption-key.pem'), 'also not a private key');
    const config = {
      projectName: 'live', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: false } }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;

    expect(await enforceMachineIdentityBootRecovery({ config, manager, recoveryStore: keychain })).toBe('keys-recovered');
    const recovered = manager.loadIdentity();
    expect(recovered.keyEpoch).toBe(identity.keyEpoch + 1);
    expect(() => crypto.sign(null, Buffer.from('proof'), manager.loadSigningKey())).not.toThrow();
    expect(() => crypto.diffieHellman({
      privateKey: crypto.createPrivateKey(manager.loadEncryptionKey()),
      publicKey: crypto.createPublicKey(manager.loadEncryptionKey()),
    })).not.toThrow();
  });

  it('recovers valid-but-substituted private keys whose public keys do not match identity.json', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-boot-substituted-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    const manager = new MachineIdentityManager(stateDir);
    const identity = await manager.generateIdentity({ name: 'substituted', role: 'awake' });
    const keychain = new RecordingKeychain();
    const recovery = new MachineRecoveryKey(keychain);
    const material = recovery.ensure(identity.machineId, identity.recoveryEpoch ?? 0, identity.recoveryPublicKey);
    manager.establishLocalRecoveryKey(material!);
    fs.writeFileSync(path.join(stateDir, 'machine', 'signing-key.pem'), generateSigningKeyPair().privateKey);
    fs.writeFileSync(path.join(stateDir, 'machine', 'encryption-key.pem'), generateEncryptionKeyPair().privateKey);
    const config = {
      projectName: 'live', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: false } }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;

    expect(await enforceMachineIdentityBootRecovery({ config, manager, recoveryStore: keychain })).toBe('keys-recovered');
    const recovered = manager.loadIdentity();
    expect(recovered.keyEpoch).toBe(identity.keyEpoch + 1);
    const signingPublic = crypto.createPublicKey(crypto.createPrivateKey(manager.loadSigningKey()))
      .export({ type: 'spki', format: 'der' }).toString('base64');
    const encryptionPublic = crypto.createPublicKey(crypto.createPrivateKey(manager.loadEncryptionKey()))
      .export({ type: 'spki', format: 'der' }).toString('base64');
    expect(signingPublic).toBe(recovered.signingPublicKey);
    expect(encryptionPublic).toBe(recovered.encryptionPublicKey);
  });

  it('fails closed on substituted private keys when escrow cannot authorize recovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-boot-substituted-no-escrow-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    const manager = new MachineIdentityManager(stateDir);
    await manager.generateIdentity({ name: 'substituted-no-escrow', role: 'awake' });
    fs.writeFileSync(path.join(stateDir, 'machine', 'signing-key.pem'), generateSigningKeyPair().privateKey);
    const config = {
      projectName: 'live', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: false } }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;

    await expect(enforceMachineIdentityBootRecovery({
      config, manager, recoveryStore: new RecordingKeychain(), run: async () => 'unchanged',
    })).rejects.toThrow('private key material remains invalid or incomplete');
  });

  it('refuses operational-key repair under a self-consistent but substituted escrow root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-boot-substituted-escrow-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    const manager = new MachineIdentityManager(stateDir);
    const initial = await manager.generateIdentity({ name: 'substituted-escrow', role: 'awake' });
    const keychain = new RecordingKeychain();
    const recovery = new MachineRecoveryKey(keychain);
    const material = recovery.ensure(initial.machineId)!;
    const established = manager.establishLocalRecoveryKey(material);
    recovery.rememberIdentity(established);
    const attacker = generateSigningKeyPair();
    keychain.set(`machineIdentityRecovery.${initial.machineId}.privateKeyPem`, attacker.privateKey);
    keychain.set(`machineIdentityRecovery.${initial.machineId}.publicKey`, pemToBase64(attacker.publicKey));
    fs.writeFileSync(path.join(stateDir, 'machine', 'signing-key.pem'), 'broken operational key');
    const config = {
      projectName: 'live', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: false } }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;

    await expect(enforceMachineIdentityBootRecovery({ config, manager, recoveryStore: keychain }))
      .rejects.toThrow('private key material remains invalid or incomplete');
    expect(manager.loadIdentity()).toMatchObject({
      machineId: initial.machineId, keyEpoch: established.keyEpoch, recoveryPublicKey: material.recoveryPublicKey,
    });
  });

  it('refuses full identity restoration under a substituted escrow root', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-boot-substituted-escrow-snapshot-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    const manager = new MachineIdentityManager(stateDir);
    const initial = await manager.generateIdentity({ name: 'substituted-escrow-snapshot', role: 'awake' });
    const keychain = new RecordingKeychain();
    const recovery = new MachineRecoveryKey(keychain);
    const material = recovery.ensure(initial.machineId)!;
    const established = manager.establishLocalRecoveryKey(material);
    recovery.rememberIdentity(established);
    const attacker = generateSigningKeyPair();
    keychain.set(`machineIdentityRecovery.${initial.machineId}.privateKeyPem`, attacker.privateKey);
    keychain.set(`machineIdentityRecovery.${initial.machineId}.publicKey`, pemToBase64(attacker.publicKey));
    removeTree(path.join(stateDir, 'machine'));
    const config = {
      projectName: 'live', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: false } }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;

    await expect(enforceMachineIdentityBootRecovery({ config, manager, recoveryStore: keychain }))
      .rejects.toThrow('established machine identity remains absent');
    expect(manager.hasIdentity()).toBe(false);
  });

  it('restores a lost local principal before holding remote mutation on an expired activation proof', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-boot-expired-proof-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    const manager = new MachineIdentityManager(stateDir);
    const local = await manager.generateIdentity({ name: 'local', role: 'awake' });
    manager.registerMachine({
      ...local, machineId: 'm_peer', name: 'peer', signingPublicKey: 'peer-signing', encryptionPublicKey: 'peer-encryption',
    }, 'standby');
    const keychain = new RecordingKeychain();
    const recovery = new MachineRecoveryKey(keychain);
    const material = recovery.ensure(local.machineId, 0);
    expect(material).not.toBeNull();
    const established = manager.establishLocalRecoveryKey(material!);
    recovery.rememberIdentity(established);
    removeTree(path.join(stateDir, 'machine'));
    const config = {
      projectName: 'live', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: {
        identityReannounce: { enabled: true, dryRun: false },
        observedEndpoints: { enabled: true, dryRun: false },
        recoveryKeyEscrow: { enabled: true, dryRun: false },
      }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;

    expect(await enforceMachineIdentityBootRecovery({ config, manager, recoveryStore: keychain })).toBe('coherence-held');
    expect(manager.loadIdentity()).toMatchObject({ machineId: local.machineId, keyEpoch: established.keyEpoch + 1 });
    expect(() => manager.loadSigningKey()).not.toThrow();
    expect(() => manager.loadEncryptionKey()).not.toThrow();
  });
});
