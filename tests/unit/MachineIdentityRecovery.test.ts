import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineIdentityManager, sign, verify, base64ToSigningPem } from '../../src/core/MachineIdentity.js';
import { MachineRecoveryKey, type RecoverySecretStore } from '../../src/core/MachineRecoveryKey.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { establishPairingRecoveryRoot } from '../../src/commands/machine.js';

class FakeKeychain implements RecoverySecretStore {
  readonly isKeychainBacked = true;
  readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  set(key: string, value: unknown): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
}

describe('MachineIdentityManager recovery pairing', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'MachineIdentityRecovery.test.ts' });
    }
  });

  it('prepares fresh signing, encryption, and recovery roots while retaining machineId', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-fresh-pair-'));
    roots.push(root);
    const manager = new MachineIdentityManager(root);
    const initial = await manager.generateIdentity({ name: 'returning', role: 'standby' });
    const recovery = new MachineRecoveryKey(new FakeKeychain());
    const firstRoot = recovery.ensure(initial.machineId)!;
    const established = manager.establishLocalRecoveryKey(firstRoot);
    recovery.rememberIdentity(established);

    const nextRoot = recovery.rotate(initial.machineId, established.recoveryEpoch ?? 0, established.recoveryPublicKey!)!;
    const fresh = manager.prepareFreshPairingIdentity(nextRoot);
    recovery.rememberIdentity(fresh);

    expect(fresh.machineId).toBe(initial.machineId);
    expect(fresh.keyEpoch).toBe((established.keyEpoch ?? 0) + 1);
    expect(fresh.recoveryEpoch).toBe((established.recoveryEpoch ?? 0) + 1);
    expect(fresh.signingPublicKey).not.toBe(established.signingPublicKey);
    expect(fresh.encryptionPublicKey).not.toBe(established.encryptionPublicKey);
    expect(fresh.recoveryPublicKey).not.toBe(established.recoveryPublicKey);
    const proof = sign('fresh-pair-proof', manager.loadSigningKey());
    expect(verify('fresh-pair-proof', proof, base64ToSigningPem(fresh.signingPublicKey))).toBe(true);
    expect(recovery.has(initial.machineId)).toBe(true);
  });

  it('rotates the recovery root as a separate operator mutation and commits escrow after identity', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-recovery-rotate-'));
    roots.push(root);
    const manager = new MachineIdentityManager(root);
    const initial = await manager.generateIdentity({ name: 'rotating', role: 'standby' });
    const recovery = new MachineRecoveryKey(new FakeKeychain());
    const first = recovery.ensure(initial.machineId)!;
    const established = manager.establishLocalRecoveryKey(first);
    const prepared = recovery.prepareRotation(initial.machineId, established.recoveryEpoch ?? 0, established.recoveryPublicKey!)!;
    const rotated = manager.rotateLocalRecoveryKey(prepared);
    expect(rotated.signingPublicKey).toBe(established.signingPublicKey);
    expect(rotated.keyEpoch).toBe(established.keyEpoch);
    expect(rotated.recoveryEpoch).toBe((established.recoveryEpoch ?? 0) + 1);
    expect(recovery.commitRotation(initial.machineId)).toEqual(prepared);
    expect(recovery.ensure(initial.machineId, rotated.recoveryEpoch, rotated.recoveryPublicKey)).toEqual(prepared);
  });

  it('keeps identity and escrow storage byte-identical in recovery-key dry-run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'machine-recovery-dryrun-'));
    roots.push(root);
    const manager = new MachineIdentityManager(root);
    await manager.generateIdentity({ name: 'dry-run', role: 'standby' });
    const snapshot = (): Record<string, string> => {
      const rows: Record<string, string> = {};
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const absolute = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(absolute);
          else rows[path.relative(root, absolute)] = fs.readFileSync(absolute).toString('base64');
        }
      };
      walk(root);
      return rows;
    };
    const before = snapshot();
    await establishPairingRecoveryRoot({
      stateDir: root, developmentAgent: true,
      multiMachine: { recoveryKeyEscrow: { enabled: true, dryRun: true } },
    } as never, manager);
    expect(snapshot()).toEqual(before);
  });
});
