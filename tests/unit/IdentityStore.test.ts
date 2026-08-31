import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IdentityStore, IdentityStoreRefusal } from '../../src/core/IdentityStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineIdentity } from '../../src/core/types.js';

function identity(overrides: Partial<MachineIdentity> = {}): MachineIdentity {
  return {
    machineId: 'm_peer',
    signingPublicKey: 'signing-a',
    encryptionPublicKey: 'encryption-a',
    name: 'peer',
    platform: 'darwin-arm64',
    createdAt: '2026-08-30T00:00:00.000Z',
    capabilities: ['sessions'],
    keyEpoch: 0,
    recoveryEpoch: 0,
    ...overrides,
  };
}

describe('IdentityStore', () => {
  let root: string;
  let stateDir: string;
  let store: IdentityStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-store-'));
    stateDir = path.join(root, '.instar');
    store = new IdentityStore({ stateDir, now: () => Date.parse('2026-08-30T12:00:00.000Z') });
    fs.mkdirSync(path.join(stateDir, 'machines'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machines', 'registry.json'), JSON.stringify({
      version: 1,
      machines: { m_peer: { name: 'peer', status: 'active', role: 'standby', pairedAt: 'x', lastSeen: 'x' } },
    }));
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/IdentityStore.test.ts' });
  });

  it('establishes a first-hand recovery anchor only through pairing trust', () => {
    const first = identity({ recoveryPublicKey: 'recovery-a', recoveryEpoch: 1, recoveryAnchorProvenance: 'first-hand' });
    expect(() => store.apply({ identity: first, scope: 'remote', actor: 'replication-apply', path: 'replication' }))
      .toThrowError(IdentityStoreRefusal);
    store.apply({ identity: first, scope: 'remote', actor: 'pairing-trust', path: 'pair' });
    expect(store.loadIdentity('m_peer', 'remote')).toMatchObject({ recoveryPublicKey: 'recovery-a', recoveryEpoch: 1 });
  });

  it('requires exact next signing epoch and tombstones the old key', () => {
    store.apply({ identity: identity(), scope: 'remote', actor: 'pairing-trust', path: 'pair' });
    expect(() => store.apply({
      identity: identity({ signingPublicKey: 'signing-b', keyEpoch: 2 }),
      scope: 'remote', actor: 'reannounce', path: 'signing-rotation',
    })).toThrow(/stored \+ 1/);

    store.apply({
      identity: identity({ signingPublicKey: 'signing-b', keyEpoch: 1 }),
      scope: 'remote', actor: 'reannounce', path: 'signing-rotation',
    });
    expect(store.getEpoch('m_peer').signingTombstones).toHaveLength(1);
    expect(() => store.apply({
      identity: identity({ signingPublicKey: 'signing-a', keyEpoch: 2 }),
      scope: 'remote', actor: 'reannounce', path: 'signing-rotation',
    })).toThrow(/previously superseded/);
  });

  it('refuses a signing rotation that also replaces the recovery root', () => {
    store.apply({
      identity: identity({ recoveryPublicKey: 'recovery-a', recoveryEpoch: 1 }),
      scope: 'remote', actor: 'pairing-trust', path: 'pair',
    });
    expect(() => store.apply({
      identity: identity({ signingPublicKey: 'signing-b', keyEpoch: 1, recoveryPublicKey: 'recovery-b', recoveryEpoch: 2 }),
      scope: 'remote', actor: 'operator', path: 'signing-rotation',
    })).toThrow(/recovery trust fields/);
  });

  it('refuses metadata, provenance, and encryption-only mutations on a signing path', () => {
    const established = identity({ recoveryPublicKey: 'recovery-a', recoveryEpoch: 1, recoveryAnchorProvenance: 'first-hand' });
    store.apply({ identity: established, scope: 'remote', actor: 'pairing-trust', path: 'pair' });
    expect(() => store.apply({
      identity: { ...established, name: 'attacker-renamed', signingPublicKey: 'signing-b', keyEpoch: 1 },
      scope: 'remote', actor: 'reannounce', path: 'signing-rotation',
    })).toThrow(/metadata/);
    expect(() => store.apply({
      identity: { ...established, recoveryAnchorProvenance: 'replicated', signingPublicKey: 'signing-b', keyEpoch: 1 },
      scope: 'remote', actor: 'reannounce', path: 'signing-rotation',
    })).toThrow(/recovery trust fields/);
    expect(() => store.apply({
      identity: { ...established, encryptionPublicKey: 'encryption-b' },
      scope: 'remote', actor: 'replication-apply', path: 'replication',
    })).toThrow(/only with a signing-key rotation/);
  });

  it('keeps revocation sticky except for a fresh pairing-trust mutation', () => {
    store.apply({ identity: identity(), scope: 'remote', actor: 'pairing-trust', path: 'pair' });
    fs.mkdirSync(path.join(stateDir, 'machines'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machines', 'registry.json'), JSON.stringify({
      version: 1,
      machines: { m_peer: { name: 'peer', status: 'revoked', role: 'standby', pairedAt: 'x', lastSeen: 'x', revokedAt: 'x' } },
    }));
    expect(() => store.apply({ identity: identity(), scope: 'remote', actor: 'reannounce', path: 'signing-rotation' }))
      .toThrow(/fresh operator pairing/);
    expect(() => store.apply({ identity: identity(), scope: 'remote', actor: 'pairing-trust', path: 'pair', clearRevocation: true }))
      .not.toThrow();
  });

  it('appends an attributable audit row for every accepted mutation', () => {
    store.apply({ identity: identity(), scope: 'remote', actor: 'pairing-trust', path: 'pair', acceptedBy: 'm_local' });
    expect(store.readChanges()).toEqual([expect.objectContaining({
      machineId: 'm_peer', actor: 'pairing-trust', path: 'pair', keyEpoch: 0, acceptedBy: 'm_local',
    })]);
  });

  it('indexes only accepted signing rotations until the exact epoch is acknowledged', () => {
    store.apply({ identity: identity(), scope: 'remote', actor: 'pairing-trust', path: 'pair' });
    expect(store.listUnacknowledged()).toEqual([]);
    store.apply({
      identity: identity({ signingPublicKey: 'signing-b', keyEpoch: 1 }),
      scope: 'remote', actor: 'reannounce', path: 'signing-rotation', acceptedBy: 'm_local',
    });
    expect(store.hasUnacknowledged('m_peer')).toBe(true);
    expect(store.listUnacknowledged()).toEqual([expect.objectContaining({ machineId: 'm_peer', keyEpoch: 1 })]);
    expect(store.acknowledge('m_peer', 0)).toBe(false);
    expect(store.acknowledge('m_peer', 1)).toBe(true);
    expect(store.hasUnacknowledged('m_peer')).toBe(false);
  });

  it('commits the independent revocation tombstone and registry state through one funnel', () => {
    store.apply({ identity: identity(), scope: 'remote', actor: 'pairing-trust', path: 'pair' });
    fs.mkdirSync(path.join(stateDir, 'machines'), { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'machines', 'registry.json'), JSON.stringify({
      version: 1,
      machines: { m_peer: { name: 'peer', status: 'active', role: 'awake', pairedAt: 'x', lastSeen: 'x' } },
    }));
    store.revoke('m_peer', 'm_local', 'operator removed peer');
    expect(store.getEpoch('m_peer').revokedAt).toBe('2026-08-30T12:00:00.000Z');
    expect(store.getEpoch('m_peer').signingTombstones).toHaveLength(1);
    const registry = JSON.parse(fs.readFileSync(path.join(stateDir, 'machines', 'registry.json'), 'utf8'));
    expect(registry.machines.m_peer).toMatchObject({ status: 'revoked', role: 'standby', revokedBy: 'm_local' });
    expect(store.readChanges().at(-1)).toMatchObject({ path: 'revocation', machineId: 'm_peer' });
  });

  it('restores a revoked principal only through a fresh +1 pairing and clears both authority surfaces', () => {
    const established = identity({ recoveryPublicKey: 'recovery-a', recoveryEpoch: 1, recoveryAnchorProvenance: 'first-hand' });
    store.apply({ identity: established, scope: 'remote', actor: 'pairing-trust', path: 'pair' });
    store.revoke('m_peer', 'm_local', 'operator removed peer');
    const revokedEpoch = store.getEpoch('m_peer');
    expect(revokedEpoch.signingTombstones).toHaveLength(1);
    expect(revokedEpoch.recoveryTombstones).toHaveLength(1);

    expect(() => store.apply({
      identity: established, scope: 'remote', actor: 'pairing-trust', path: 'pair', clearRevocation: true,
    })).toThrow(/previously superseded/);
    store.apply({
      identity: {
        ...established,
        signingPublicKey: 'signing-fresh', encryptionPublicKey: 'encryption-fresh', keyEpoch: 1,
        recoveryPublicKey: 'recovery-fresh', recoveryEpoch: 2,
      },
      scope: 'remote', actor: 'pairing-trust', path: 'pair', clearRevocation: true, acceptedBy: 'm_local',
    });
    expect(store.getEpoch('m_peer').keyEpoch).toBe(1);
    expect(store.getEpoch('m_peer').revokedAt).toBeUndefined();
    const registry = JSON.parse(fs.readFileSync(path.join(stateDir, 'machines', 'registry.json'), 'utf8'));
    expect(registry.machines.m_peer).toMatchObject({ status: 'active' });
    expect(registry.machines.m_peer.revokedAt).toBeUndefined();
  });

  it.each(['after-journal', 'after-epoch', 'after-registry', 'after-ledger'] as const)(
    'recovers an interrupted revocation at %s with registry, tombstones, and one audit row',
    (faultStep) => {
      store.apply({ identity: identity(), scope: 'remote', actor: 'pairing-trust', path: 'pair' });
      const crashing = new IdentityStore({
        stateDir,
        now: () => Date.parse('2026-08-30T12:10:00.000Z'),
        faultInjector: (step) => { if (step === faultStep) throw new Error(`simulated-revoke:${step}`); },
      });
      expect(() => crashing.revoke('m_peer', 'm_local', 'operator removed peer')).toThrow(`simulated-revoke:${faultStep}`);
      const recovered = new IdentityStore({ stateDir });
      const registry = JSON.parse(fs.readFileSync(path.join(stateDir, 'machines', 'registry.json'), 'utf8'));
      expect(registry.machines.m_peer).toMatchObject({ status: 'revoked', revokedBy: 'm_local' });
      expect(recovered.getEpoch('m_peer')).toMatchObject({ revokedAt: '2026-08-30T12:10:00.000Z' });
      expect(recovered.getEpoch('m_peer').signingTombstones).toHaveLength(1);
      expect(recovered.readChanges().filter((row) => row.path === 'revocation')).toHaveLength(1);
      expect(fs.existsSync(recovered.transactionPath)).toBe(false);
    },
  );

  it.each(['after-identity', 'after-registry'] as const)(
    'recovers fresh re-pair revocation clearing at %s',
    (faultStep) => {
      const established = identity({ recoveryPublicKey: 'recovery-a', recoveryEpoch: 1, recoveryAnchorProvenance: 'first-hand' });
      store.apply({ identity: established, scope: 'remote', actor: 'pairing-trust', path: 'pair' });
      store.revoke('m_peer', 'm_local', 'operator removed peer');
      const crashing = new IdentityStore({
        stateDir,
        faultInjector: (step) => { if (step === faultStep) throw new Error(`simulated-repair:${step}`); },
      });
      expect(() => crashing.apply({
        identity: {
          ...established,
          signingPublicKey: 'signing-fresh', encryptionPublicKey: 'encryption-fresh', keyEpoch: 1,
          recoveryPublicKey: 'recovery-fresh', recoveryEpoch: 2,
        },
        scope: 'remote', actor: 'pairing-trust', path: 'pair', clearRevocation: true, acceptedBy: 'm_local',
      })).toThrow(`simulated-repair:${faultStep}`);
      const recovered = new IdentityStore({ stateDir });
      const registry = JSON.parse(fs.readFileSync(path.join(stateDir, 'machines', 'registry.json'), 'utf8'));
      expect(registry.machines.m_peer).toMatchObject({ status: 'active' });
      expect(registry.machines.m_peer.revokedAt).toBeUndefined();
      expect(recovered.loadIdentity('m_peer', 'remote')).toMatchObject({ signingPublicKey: 'signing-fresh', keyEpoch: 1 });
      expect(recovered.readChanges().filter((row) => row.path === 'pair')).toHaveLength(2);
    },
  );

  it.each(['after-journal', 'after-epoch', 'after-unacknowledged', 'after-ledger', 'after-private-keys', 'after-identity', 'after-registry'] as const)(
    'recovers an interrupted multi-file trust transaction at %s exactly once',
    (faultStep) => {
      store.apply({ identity: identity(), scope: 'remote', actor: 'pairing-trust', path: 'pair' });
      const crashing = new IdentityStore({
        stateDir,
        now: () => Date.parse('2026-08-30T12:05:00.000Z'),
        faultInjector: (step) => { if (step === faultStep) throw new Error(`simulated-crash:${step}`); },
      });
      expect(() => crashing.apply({
        identity: identity({ signingPublicKey: 'signing-b', encryptionPublicKey: 'encryption-b', keyEpoch: 1 }),
        scope: 'remote', actor: 'reannounce', path: 'signing-rotation', acceptedBy: 'm_local',
      })).toThrow(`simulated-crash:${faultStep}`);

      const recovered = new IdentityStore({ stateDir });
      expect(recovered.loadIdentity('m_peer', 'remote')).toMatchObject({
        signingPublicKey: 'signing-b', encryptionPublicKey: 'encryption-b', keyEpoch: 1,
      });
      expect(recovered.getEpoch('m_peer').keyEpoch).toBe(1);
      expect(recovered.listUnacknowledged()).toEqual([expect.objectContaining({ machineId: 'm_peer', keyEpoch: 1 })]);
      expect(recovered.readChanges().filter((row) => row.path === 'signing-rotation')).toHaveLength(1);
      expect(fs.existsSync(recovered.transactionPath)).toBe(false);
    },
  );

  it('fails closed when a pending journal disagrees with its authority projection', () => {
    store.apply({ identity: identity(), scope: 'remote', actor: 'pairing-trust', path: 'pair' });
    const crashing = new IdentityStore({
      stateDir,
      faultInjector: (step) => { if (step === 'after-journal') throw new Error('simulated-crash'); },
    });
    expect(() => crashing.apply({
      identity: identity({ signingPublicKey: 'signing-b', encryptionPublicKey: 'encryption-b', keyEpoch: 1 }),
      scope: 'remote', actor: 'reannounce', path: 'signing-rotation', acceptedBy: 'm_local',
    })).toThrow('simulated-crash');
    const journal = JSON.parse(fs.readFileSync(crashing.transactionPath, 'utf8'));
    journal.epochs.machines.m_peer.keyEpoch = 99;
    fs.writeFileSync(crashing.transactionPath, JSON.stringify(journal));
    expect(() => new IdentityStore({ stateDir })).toThrow(/journal is unreadable/);
    expect(store.loadIdentity('m_peer', 'remote')).toMatchObject({ signingPublicKey: 'signing-a', keyEpoch: 0 });
  });

  it('rolls private keys back before the identity commit point and finishes them on boot recovery', () => {
    const local = identity({ machineId: 'm_local' });
    store.apply({ identity: local, scope: 'local', actor: 'self-bootstrap', path: 'bootstrap' });
    const machineDir = path.join(stateDir, 'machine');
    const signingTarget = path.join(machineDir, 'signing-key.pem');
    const encryptionTarget = path.join(machineDir, 'encryption-key.pem');
    const signingStage = `${signingTarget}.stage.test`;
    const encryptionStage = `${encryptionTarget}.stage.test`;
    const signingBackup = `${signingTarget}.backup.test`;
    const encryptionBackup = `${encryptionTarget}.backup.test`;
    fs.writeFileSync(signingTarget, 'old-signing-private');
    fs.writeFileSync(encryptionTarget, 'old-encryption-private');
    fs.writeFileSync(signingStage, 'new-signing-private');
    fs.writeFileSync(encryptionStage, 'new-encryption-private');
    fs.writeFileSync(signingBackup, 'old-signing-private');
    fs.writeFileSync(encryptionBackup, 'old-encryption-private');
    const crashing = new IdentityStore({
      stateDir,
      faultInjector: (step) => { if (step === 'after-private-keys') throw new Error('simulated-private-key-crash'); },
    });
    expect(() => crashing.apply({
      identity: { ...local, signingPublicKey: 'signing-new', encryptionPublicKey: 'encryption-new', keyEpoch: 1 },
      scope: 'local', actor: 'self-bootstrap', path: 'signing-rotation',
      privateKeyReplacements: [
        { targetPath: signingTarget, stagedPath: signingStage, backupPath: signingBackup },
        { targetPath: encryptionTarget, stagedPath: encryptionStage, backupPath: encryptionBackup },
      ],
    })).toThrow('simulated-private-key-crash');
    expect(fs.readFileSync(signingTarget, 'utf8')).toBe('old-signing-private');
    expect(store.loadIdentity('m_local', 'local')?.keyEpoch).toBe(0);

    const recovered = new IdentityStore({ stateDir });
    expect(fs.readFileSync(signingTarget, 'utf8')).toBe('new-signing-private');
    expect(fs.readFileSync(encryptionTarget, 'utf8')).toBe('new-encryption-private');
    expect(recovered.loadIdentity('m_local', 'local')).toMatchObject({ keyEpoch: 1, signingPublicKey: 'signing-new' });
    expect(fs.existsSync(signingStage)).toBe(false);
    expect(fs.existsSync(signingBackup)).toBe(false);
  });
});
