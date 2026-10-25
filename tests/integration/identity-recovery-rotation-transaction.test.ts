import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateSigningKeyPair, MachineIdentityManager, pemToBase64 } from '../../src/core/MachineIdentity.js';
import { MachineRecoveryKey, type RecoverySecretStore } from '../../src/core/MachineRecoveryKey.js';
import { IdentityRecoveryRootPropagationQueue } from '../../src/core/IdentityRecoveryRootPropagation.js';
import { executeRecoveryRootRotationTransaction, type RecoveryRootRotationBoundary } from '../../src/core/IdentityRecoveryRootRotationTransaction.js';
import { recoveryRootDelegationHash, type MachineOperatorDelegation } from '../../src/core/MachineOperatorDelegation.js';
import { runMachineIdentityBootRecovery } from '../../src/core/MachineIdentityBootRecovery.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

class Keychain implements RecoverySecretStore {
  readonly isKeychainBacked = true;
  readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  set(key: string, value: unknown): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
}

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, {
  recursive: true, force: true, operation: 'identity-recovery-rotation-transaction.test:cleanup',
}); });

describe('production recovery-root rotation crash transaction', () => {
  it('performs zero identity or journal mutation when escrow does not match the pinned root', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-rotation-substituted-root-'));
    roots.push(stateDir);
    const manager = new MachineIdentityManager(stateDir);
    const generated = await manager.generateIdentity({ name: 'local', role: 'awake' });
    const keychain = new Keychain();
    const recovery = new MachineRecoveryKey(keychain);
    const initial = manager.establishLocalRecoveryKey(recovery.ensure(generated.machineId)!);
    recovery.rememberIdentity(initial);
    const substitute = generateSigningKeyPair();
    keychain.set(`machineIdentityRecovery.${initial.machineId}.privateKeyPem`, substitute.privateKey);
    keychain.set(`machineIdentityRecovery.${initial.machineId}.publicKey`, pemToBase64(substitute.publicKey));
    const propagation = new IdentityRecoveryRootPropagationQueue({
      stateDir, sendPeer: async () => 'rotated', validateDelegation: () => true, notify: vi.fn(),
    });
    const identityBefore = fs.readFileSync(manager.identityPath);
    const journal = path.join(stateDir, 'state', 'identity-recovery-establishment.json');

    await expect(executeRecoveryRootRotationTransaction({
      current: initial, peerIds: ['m-peer'], recoveryKey: recovery, propagation,
      rotateLocalRecoveryKey: (material) => manager.rotateLocalRecoveryKey(material),
      mintDelegations: () => { throw new Error('must not mint'); },
    })).rejects.toThrow('Pinned OS-keychain recovery root is unavailable or mismatched');

    expect(fs.readFileSync(manager.identityPath)).toEqual(identityBefore);
    expect(fs.existsSync(journal)).toBe(false);
    expect(propagation.status()).toEqual([]);
  });

  it('recovers safely after every durable boundary and finalizes retained old-root material', async () => {
    const boundaries: RecoveryRootRotationBoundary[] = [
      'prepared-key', 'attached-keychain-intent', 'prepared-file-outbox',
      'committed-public-identity', 'committed-escrow', 'remembered-identity-snapshot', 'committed-file-outbox',
    ];
    for (const crashAt of boundaries) {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `identity-rotation-${crashAt}-`));
      roots.push(stateDir);
      const manager = new MachineIdentityManager(stateDir);
      const generated = await manager.generateIdentity({ name: 'local', role: 'awake' });
      const keychain = new Keychain();
      const recovery = new MachineRecoveryKey(keychain);
      const initialMaterial = recovery.ensure(generated.machineId)!;
      const initial = manager.establishLocalRecoveryKey(initialMaterial);
      recovery.rememberIdentity(initial);
      const sendPeer = vi.fn(async () => 'rotated' as const);
      const queue = () => new IdentityRecoveryRootPropagationQueue({
        stateDir, sendPeer, notify: vi.fn(),
        validateDelegation: (_peer, identity, delegation) =>
          delegation.contentHash === recoveryRootDelegationHash(identity)
          && recovery.validateRetainedOperatorDelegation(identity.machineId, delegation),
      });
      const firstQueue = queue();
      await expect(executeRecoveryRootRotationTransaction({
        current: initial, peerIds: ['m-peer'], recoveryKey: recovery, propagation: firstQueue,
        rotateLocalRecoveryKey: (material) => manager.rotateLocalRecoveryKey(material),
        mintDelegations: (proposed) => {
          const unsigned = {
            version: 1 as const, action: 'rotate-recovery-root' as const,
            issuerMachineId: initial.machineId, recipientMachineId: 'm-peer', subjectMachineId: initial.machineId,
            epoch: proposed.recoveryEpoch!, contentHash: recoveryRootDelegationHash(proposed),
            nonce: 'a'.repeat(64), issuedAt: 1, expiresAt: 9999999999999,
          };
          return { 'm-peer': { ...unsigned, signature: recovery.signOperatorGrant(initial.machineId, initial.recoveryPublicKey!, unsigned)! } as MachineOperatorDelegation };
        },
        afterBoundary: (boundary) => { if (boundary === crashAt) throw new Error(`crash:${boundary}`); },
      })).rejects.toThrow(`crash:${crashAt}`);

      const config = {
        projectName: 'rotation', projectDir: stateDir, stateDir, developmentAgent: true,
        multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: false } }, messaging: [], monitoring: {}, updates: {},
      } as unknown as InstarConfig;
      await runMachineIdentityBootRecovery({ config, manager, recoveryStore: keychain });
      const restarted = queue();
      const current = manager.loadIdentity();
      const escrowCommitted = recovery.reconcileRotationCommit(current);
      if (escrowCommitted) recovery.rememberIdentity(current);
      const intent = recovery.loadRotationPropagationIntent(current.machineId);
      if (intent) restarted.recoverPrepared(intent.machineIdentity, intent.operatorDelegations);
      restarted.reconcile(current, escrowCommitted);
      const ticked = await restarted.tick();

      const publicCommitted = boundaries.indexOf(crashAt) >= boundaries.indexOf('committed-public-identity');
      if (!publicCommitted) {
        expect(manager.loadIdentity().recoveryEpoch, crashAt).toBe(initial.recoveryEpoch);
        expect(sendPeer, crashAt).not.toHaveBeenCalled();
      } else {
        expect(manager.loadIdentity().recoveryEpoch, crashAt).toBe((initial.recoveryEpoch ?? 0) + 1);
        expect(sendPeer, crashAt).toHaveBeenCalledTimes(1);
        const completed = ticked[0];
        expect(completed.completedAt, crashAt).toBeDefined();
        expect(restarted.retireCompleted(completed.id), crashAt).toBe(true);
        expect(recovery.finalizeRotationPropagation(current.machineId, current.recoveryEpoch ?? 0), crashAt).toBe(true);
        expect(recovery.loadRotationPropagationIntent(current.machineId), crashAt).toBeNull();
        expect(restarted.status(), crashAt).toEqual([]);
        await expect(queue().tick(), crashAt).resolves.toEqual([]);
      }
    }
  });
});
