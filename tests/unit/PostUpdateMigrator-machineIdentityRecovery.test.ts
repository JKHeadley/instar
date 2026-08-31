import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const result = (): Result => ({ upgraded: [], skipped: [], errors: [] });

describe('PostUpdateMigrator machine identity recovery parity', () => {
  let root: string;
  let stateDir: string;
  let migrator: PostUpdateMigrator;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-migration-'));
    stateDir = path.join(root, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    migrator = new PostUpdateMigrator({ projectDir: root, stateDir, port: 4042, hasTelegram: false, projectName: 'test' });
  });
  afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'PostUpdateMigrator-machineIdentityRecovery:cleanup' }));

  it('backfills the three dry-run-first config blocks without writing an enabled override', () => {
    const configPath = path.join(stateDir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ projectName: 'test', authToken: 'x', multiMachine: { meshTransport: { enabled: true } } }));
    (migrator as unknown as { migrateConfig(r: Result): void }).migrateConfig(result());
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    for (const key of ['identityReannounce', 'observedEndpoints', 'recoveryKeyEscrow']) {
      expect(config.multiMachine[key].dryRun).toBe(true);
      expect(config.multiMachine[key]).not.toHaveProperty('enabled');
    }
    const once = fs.readFileSync(configPath, 'utf8');
    (migrator as unknown as { migrateConfig(r: Result): void }).migrateConfig(result());
    expect(fs.readFileSync(configPath, 'utf8')).toBe(once);
  });

  it('adds agent awareness once, including Registry First and proactive triggers', () => {
    const file = path.join(root, 'CLAUDE.md');
    fs.writeFileSync(file, '# Existing instructions\n');
    (migrator as unknown as { migrateClaudeMd(r: Result): void }).migrateClaudeMd(result());
    const once = fs.readFileSync(file, 'utf8');
    expect(once).toContain('### Machine Identity Recovery');
    expect(once).toContain('GET /identity-recovery');
    expect(once).toContain('why is this paired machine suddenly unauthorized?');
    (migrator as unknown as { migrateClaudeMd(r: Result): void }).migrateClaudeMd(result());
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  });

  it('backfills legacy local and peer identity epochs idempotently without lowering authority', () => {
    const localPath = path.join(stateDir, 'machine', 'identity.json');
    const peerPath = path.join(stateDir, 'machines', 'm_peer', 'identity.json');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.mkdirSync(path.dirname(peerPath), { recursive: true });
    const base = { signingPublicKey: 's', encryptionPublicKey: 'e', name: 'n', platform: 'p', createdAt: 'x', capabilities: [] };
    fs.writeFileSync(localPath, JSON.stringify({ ...base, machineId: 'm_local' }));
    fs.writeFileSync(peerPath, JSON.stringify({ ...base, machineId: 'm_peer', recoveryPublicKey: 'r' }));
    const epochPath = path.join(stateDir, 'state', 'identity-epochs.json');
    fs.mkdirSync(path.dirname(epochPath), { recursive: true });
    fs.writeFileSync(epochPath, JSON.stringify({
      version: 1,
      machines: { m_local: { keyEpoch: 4, recoveryEpoch: 0, signingTombstones: [{ epoch: 3, fingerprint: 'old' }], recoveryTombstones: [] } },
    }));

    (migrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(result());
    expect(JSON.parse(fs.readFileSync(localPath, 'utf8'))).toMatchObject({ keyEpoch: 0, recoveryEpoch: 0 });
    expect(JSON.parse(fs.readFileSync(peerPath, 'utf8'))).toMatchObject({ keyEpoch: 0, recoveryEpoch: 0 });
    expect(JSON.parse(fs.readFileSync(peerPath, 'utf8'))).not.toHaveProperty('recoveryPublicKey');
    const epochs = JSON.parse(fs.readFileSync(epochPath, 'utf8'));
    expect(epochs.machines.m_local).toMatchObject({ keyEpoch: 4, signingTombstones: [{ epoch: 3, fingerprint: 'old' }] });
    expect(epochs.machines.m_peer).toMatchObject({ keyEpoch: 0, recoveryEpoch: 0 });
    const once = fs.readFileSync(epochPath, 'utf8');
    (migrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(result());
    expect(fs.readFileSync(epochPath, 'utf8')).toBe(once);
  });

  it('never blesses a bearer-preseeded recovery root without independent epoch and ledger authority', () => {
    const peerPath = path.join(stateDir, 'machines', 'm_hostile', 'identity.json');
    fs.mkdirSync(path.dirname(peerPath), { recursive: true });
    fs.writeFileSync(peerPath, JSON.stringify({
      machineId: 'm_hostile', signingPublicKey: 's', encryptionPublicKey: 'e',
      name: 'n', platform: 'p', createdAt: 'x', capabilities: [],
      recoveryPublicKey: 'attacker-root', recoveryEpoch: 1, recoveryAnchorProvenance: 'first-hand',
    }));
    const r = result();
    (migrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(r);
    const migrated = JSON.parse(fs.readFileSync(peerPath, 'utf8'));
    expect(migrated).not.toHaveProperty('recoveryPublicKey');
    expect(migrated).not.toHaveProperty('recoveryAnchorProvenance');
    expect(migrated.recoveryEpoch).toBe(0);
    expect(r.upgraded.join('\n')).toContain('fresh pairing required');
  });

  it('quarantines a root even when identity, epoch, and unsigned ledger were all preseeded consistently', () => {
    const peerPath = path.join(stateDir, 'machines', 'm_hostile', 'identity.json');
    const epochPath = path.join(stateDir, 'state', 'identity-epochs.json');
    const ledgerPath = path.join(root, 'logs', 'identity-changes.jsonl');
    fs.mkdirSync(path.dirname(peerPath), { recursive: true });
    fs.mkdirSync(path.dirname(epochPath), { recursive: true });
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const recoveryPublicKey = 'attacker-root';
    fs.writeFileSync(peerPath, JSON.stringify({
      machineId: 'm_hostile', signingPublicKey: 's', encryptionPublicKey: 'e',
      recoveryPublicKey, recoveryEpoch: 9, recoveryAnchorProvenance: 'first-hand',
    }));
    fs.writeFileSync(epochPath, JSON.stringify({ version: 1, machines: {
      m_hostile: { keyEpoch: 0, recoveryEpoch: 9, signingTombstones: [], recoveryTombstones: [] },
    } }));
    fs.writeFileSync(ledgerPath, `${JSON.stringify({
      actor: 'pairing-trust', path: 'pair', machineId: 'm_hostile', recoveryEpoch: 9,
      newRecoveryFingerprint: crypto.createHash('sha256').update(recoveryPublicKey).digest('hex').slice(0, 32),
    })}\n`);
    (migrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(result());
    const migrated = JSON.parse(fs.readFileSync(peerPath, 'utf8'));
    expect(migrated).not.toHaveProperty('recoveryPublicKey');
    expect(migrated.recoveryEpoch).toBe(0);
  });

  it('keeps protected-era recovery anchors across a legitimate signing-key rotation', async () => {
    const secrets = new Map<string, unknown>();
    const secureStore = {
      isKeychainBacked: true,
      get: (key: string) => secrets.get(key),
      set: (key: string, value: unknown) => { secrets.set(key, value); },
    };
    const secureMigrator = new PostUpdateMigrator({
      projectDir: root, stateDir, port: 4042, hasTelegram: false, projectName: 'test',
      identityMigrationSecretStore: secureStore,
    });
    const manager = new MachineIdentityManager(stateDir);
    const local = await manager.generateIdentity({ name: 'local', role: 'awake' });
    (secureMigrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(result());
    const localWithRoot = manager.establishLocalRecoveryKey({ recoveryPublicKey: 'local-root', recoveryEpoch: 1 });
    const peerPath = path.join(stateDir, 'machines', 'm_peer', 'identity.json');
    fs.mkdirSync(path.dirname(peerPath), { recursive: true });
    fs.writeFileSync(peerPath, JSON.stringify({
      ...localWithRoot, machineId: 'm_peer', recoveryPublicKey: 'peer-root', recoveryEpoch: 1,
      recoveryAnchorProvenance: 'first-hand',
    }));
    const epochPath = path.join(stateDir, 'state', 'identity-epochs.json');
    const epochs = JSON.parse(fs.readFileSync(epochPath, 'utf8'));
    epochs.machines.m_peer = { keyEpoch: 0, recoveryEpoch: 1, signingTombstones: [], recoveryTombstones: [] };
    fs.writeFileSync(epochPath, JSON.stringify(epochs));
    manager.rotateLocalKeys('production recovery test');
    (secureMigrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(result());
    expect(manager.loadIdentity()).toMatchObject({ machineId: local.machineId, recoveryPublicKey: 'local-root', recoveryEpoch: 1 });
    expect(JSON.parse(fs.readFileSync(peerPath, 'utf8'))).toMatchObject({ recoveryPublicKey: 'peer-root', recoveryEpoch: 1 });
  });

  it('leaves established anchors byte-identical when the protected-era keychain is temporarily unavailable', async () => {
    const secrets = new Map<string, unknown>();
    const secureStore = {
      isKeychainBacked: true,
      get: (key: string) => secrets.get(key),
      set: (key: string, value: unknown) => { secrets.set(key, value); },
    };
    const setupMigrator = new PostUpdateMigrator({
      projectDir: root, stateDir, port: 4042, hasTelegram: false, projectName: 'test', identityMigrationSecretStore: secureStore,
    });
    const manager = new MachineIdentityManager(stateDir);
    const local = await manager.generateIdentity({ name: 'local', role: 'awake' });
    (setupMigrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(result());
    const localWithRoot = manager.establishLocalRecoveryKey({ recoveryPublicKey: 'local-root', recoveryEpoch: 1 });
    const peerPath = path.join(stateDir, 'machines', 'm_peer', 'identity.json');
    fs.mkdirSync(path.dirname(peerPath), { recursive: true });
    fs.writeFileSync(peerPath, JSON.stringify({
      ...localWithRoot, machineId: 'm_peer', recoveryPublicKey: 'peer-root', recoveryEpoch: 1,
      recoveryAnchorProvenance: 'first-hand',
    }));
    const epochPath = path.join(stateDir, 'state', 'identity-epochs.json');
    const epochs = JSON.parse(fs.readFileSync(epochPath, 'utf8'));
    epochs.machines.m_peer = { keyEpoch: 0, recoveryEpoch: 1, signingTombstones: [], recoveryTombstones: [] };
    fs.writeFileSync(epochPath, JSON.stringify(epochs));
    const markerPath = path.join(stateDir, 'state', 'machine-identity-migration-attestation.json');
    const protectedFiles = [manager.identityPath, peerPath, epochPath, markerPath];
    const before = protectedFiles.map((file) => fs.readFileSync(file));
    const unavailableMigrator = new PostUpdateMigrator({
      projectDir: root, stateDir, port: 4042, hasTelegram: false, projectName: 'test',
      identityMigrationSecretStore: {
        isKeychainBacked: true,
        get: () => { throw new Error('keychain locked'); },
        set: () => { throw new Error('keychain locked'); },
      },
    });
    const r = result();

    (unavailableMigrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(r);

    protectedFiles.forEach((file, index) => expect(fs.readFileSync(file)).toEqual(before[index]));
    expect(manager.loadIdentity()).toMatchObject({ machineId: local.machineId, recoveryPublicKey: 'local-root' });
    expect(r.errors.join('\n')).toContain('left trust anchors unchanged');
  });

  it('leaves established anchors unchanged when an existing protected-era marker has an invalid MAC', async () => {
    const secrets = new Map<string, unknown>();
    const secureStore = {
      isKeychainBacked: true,
      get: (key: string) => secrets.get(key),
      set: (key: string, value: unknown) => { secrets.set(key, value); },
    };
    const secureMigrator = new PostUpdateMigrator({
      projectDir: root, stateDir, port: 4042, hasTelegram: false, projectName: 'test', identityMigrationSecretStore: secureStore,
    });
    const manager = new MachineIdentityManager(stateDir);
    const local = await manager.generateIdentity({ name: 'local', role: 'awake' });
    (secureMigrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(result());
    manager.establishLocalRecoveryKey({ recoveryPublicKey: 'local-root', recoveryEpoch: 1 });
    const markerPath = path.join(stateDir, 'state', 'machine-identity-migration-attestation.json');
    fs.writeFileSync(markerPath, JSON.stringify({ version: 1, machineId: local.machineId, mac: '0'.repeat(64) }));
    const identityBefore = fs.readFileSync(manager.identityPath);
    const epochPath = path.join(stateDir, 'state', 'identity-epochs.json');
    const epochBefore = fs.readFileSync(epochPath);
    const markerBefore = fs.readFileSync(markerPath);
    const r = result();

    (secureMigrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(r);

    expect(fs.readFileSync(manager.identityPath)).toEqual(identityBefore);
    expect(fs.readFileSync(epochPath)).toEqual(epochBefore);
    expect(fs.readFileSync(markerPath)).toEqual(markerBefore);
    expect(r.errors.join('\n')).toContain('left trust anchors unchanged');
  });

  it('refuses to overwrite a corrupt existing epoch authority file', () => {
    const localPath = path.join(stateDir, 'machine', 'identity.json');
    fs.mkdirSync(path.dirname(localPath), { recursive: true });
    fs.writeFileSync(localPath, JSON.stringify({ machineId: 'm_local' }));
    const epochPath = path.join(stateDir, 'state', 'identity-epochs.json');
    fs.mkdirSync(path.dirname(epochPath), { recursive: true });
    fs.writeFileSync(epochPath, '{broken');
    const r = result();
    (migrator as unknown as { migrateMachineIdentityEpochs(r: Result): void }).migrateMachineIdentityEpochs(r);
    expect(fs.readFileSync(epochPath, 'utf8')).toBe('{broken');
    expect(r.errors).toContain('machine identity epochs: existing authority file is corrupt; refused to overwrite');
  });
});
