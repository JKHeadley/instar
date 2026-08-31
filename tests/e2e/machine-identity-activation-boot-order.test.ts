import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { activateMachineIdentityAfterAuthenticatedPull, hasFreshMachineIdentityActivationProof } from '../../src/core/MachineIdentityActivationGate.js';
import type { MachineCapacity } from '../../src/core/types.js';
import { MachineIdentityManager, generateEncryptionKeyPair, generateSigningKeyPair, pemToBase64 } from '../../src/core/MachineIdentity.js';
import { MachineRecoveryKey, type RecoverySecretStore } from '../../src/core/MachineRecoveryKey.js';
import { runMachineIdentityBootRecovery } from '../../src/core/MachineIdentityBootRecovery.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const roots: string[] = [];
const removeTree = (target: string) => SafeFsExecutor.safeRmSync(target, {
  recursive: true, force: true, operation: 'machine-identity-activation-boot-order.test:cleanup',
});
afterEach(() => { for (const root of roots.splice(0)) removeTree(root); });
const NOW = 1_800_000_000_000;
const modes = {
  'identityReannounce.enabled': 'live' as const,
  'observedEndpoints.enabled': 'dry-run' as const,
  'recoveryKeyEscrow.enabled': 'live' as const,
};

function peer(receivedAt: number): MachineCapacity {
  return {
    machineId: 'm-peer', online: true, sessions: 0, maxSessions: 1, availableSlots: 1,
    loadAvg: 0, memoryPressure: 'normal', routerReceivedAt: new Date(NOW).toISOString(),
    coherenceAdvertReceivedAt: new Date(receivedAt).toISOString(),
    coherenceAdvert: {
      instarVersion: '1.3.1217', protocolVersion: 1, manifestHash: 'a'.repeat(64),
      guard: 'dry-run', beatSeq: 1, flags: { ...modes },
    },
  } as MachineCapacity;
}

class Keychain implements RecoverySecretStore {
  readonly isKeychainBacked = true;
  readonly values = new Map<string, unknown>();
  get(key: string): unknown { return this.values.get(key); }
  set(key: string, value: unknown): void { this.values.set(key, value); }
  delete(key: string): void { this.values.delete(key); }
}

describe('machine identity activation production boot order', () => {
  it('allows a two-machine pool only after the authenticated pull supplies fresh exact adverts', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-activation-order-'));
    roots.push(stateDir);
    const events: string[] = [];
    let capacities: MachineCapacity[] = [];
    const verdict = await activateMachineIdentityAfterAuthenticatedPull({
      pullAuthenticatedPresence: async () => { events.push('pull'); capacities = [peer(NOW - 1_000)]; },
      selfMachineId: 'm-self', requiredPeerMachineIds: ['m-peer'], capacities: () => {
        events.push('evaluate'); return capacities;
      }, localModes: modes, stateDir, now: () => NOW,
    });
    expect(events).toEqual(['pull', 'evaluate']);
    expect(verdict.allowed).toBe(true);
    expect(hasFreshMachineIdentityActivationProof(stateDir, modes, ['m-peer'], NOW + 1)).toBe(true);
  });

  it('refuses absent or stale authenticated peer evidence and writes no activation proof', async () => {
    for (const capacities of [[], [peer(NOW - 120_001)]]) {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-activation-held-'));
      roots.push(stateDir);
      const verdict = await activateMachineIdentityAfterAuthenticatedPull({
        pullAuthenticatedPresence: async () => {}, selfMachineId: 'm-self',
        requiredPeerMachineIds: ['m-peer'], capacities: () => capacities,
        localModes: modes, stateDir, now: () => NOW,
      });
      expect(verdict.allowed).toBe(false);
      expect(fs.existsSync(path.join(stateDir, 'state', 'machine-identity-activation-proof.json'))).toBe(false);
    }
  });

  it('periodic authenticated refresh keeps a >24h proof usable for destructive boot recovery', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-activation-refresh-'));
    roots.push(root);
    const stateDir = path.join(root, '.instar');
    const manager = new MachineIdentityManager(stateDir);
    const original = await manager.generateIdentity({ name: 'self', role: 'awake' });
    const keychain = new Keychain();
    const recovery = new MachineRecoveryKey(keychain);
    const material = recovery.ensure(original.machineId)!;
    recovery.rememberIdentity(manager.establishLocalRecoveryKey(material));
    const peerSigning = generateSigningKeyPair();
    const peerEncryption = generateEncryptionKeyPair();
    manager.registerMachine({
      machineId: 'm-peer', name: 'peer', platform: 'test', createdAt: new Date(NOW).toISOString(),
      capabilities: ['sessions'], signingPublicKey: pemToBase64(peerSigning.publicKey),
      encryptionPublicKey: pemToBase64(peerEncryption.publicKey),
    }, 'standby');
    let clock = NOW;
    let capacities = [peer(clock - 1_000)];
    const refresh = () => activateMachineIdentityAfterAuthenticatedPull({
      pullAuthenticatedPresence: async () => {}, selfMachineId: original.machineId,
      requiredPeerMachineIds: ['m-peer'], capacities: () => capacities,
      localModes: modes, stateDir, now: () => clock,
    });
    expect((await refresh()).allowed).toBe(true);
    clock += 25 * 60 * 60_000;
    capacities = [peer(clock - 1_000)];
    expect((await refresh()).allowed).toBe(true);
    removeTree(path.join(stateDir, 'machine'));
    const config = {
      projectName: 'refresh', projectDir: root, stateDir, developmentAgent: true,
      multiMachine: {
        identityReannounce: { enabled: true, dryRun: false },
        observedEndpoints: { enabled: true, dryRun: true },
        recoveryKeyEscrow: { enabled: true, dryRun: false },
      }, messaging: [], monitoring: {}, updates: {},
    } as unknown as InstarConfig;
    expect(await runMachineIdentityBootRecovery({ config, manager, recoveryStore: keychain, now: clock + 1 })).toBe('identity-recovered');
  });

  it('refreshes proof membership when the active peer set changes', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-activation-membership-'));
    roots.push(stateDir);
    const second = { ...peer(NOW - 1_000), machineId: 'm-peer-2' };
    await activateMachineIdentityAfterAuthenticatedPull({
      pullAuthenticatedPresence: async () => {}, selfMachineId: 'm-self',
      requiredPeerMachineIds: ['m-peer'], capacities: () => [peer(NOW - 1_000)],
      localModes: modes, stateDir, now: () => NOW,
    });
    await activateMachineIdentityAfterAuthenticatedPull({
      pullAuthenticatedPresence: async () => {}, selfMachineId: 'm-self',
      requiredPeerMachineIds: ['m-peer', 'm-peer-2'], capacities: () => [peer(NOW - 1_000), second],
      localModes: modes, stateDir, now: () => NOW + 1,
    });
    expect(hasFreshMachineIdentityActivationProof(stateDir, modes, ['m-peer', 'm-peer-2'], NOW + 2)).toBe(true);
    expect(hasFreshMachineIdentityActivationProof(stateDir, modes, ['m-peer'], NOW + 2)).toBe(false);
  });
});
