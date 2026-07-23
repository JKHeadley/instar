import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MachineSshIdentity } from '../../src/core/MachineSshIdentity.js';
import { SshPeerAdmissionStore } from '../../src/core/SshPeerAdmissionStore.js';
import { MutualSshVerifier } from '../../src/core/MutualSshVerifier.js';
import { MutualSshHealthController } from '../../src/core/MutualSshHealthController.js';
import { validateSshBootstrapAdvert } from '../../src/core/SshBootstrapAdvert.js';
import { MutualSshProbeScheduler } from '../../src/core/MutualSshProbeScheduler.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
function temp(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ssh-')); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'mutual-ssh-autobootstrap.test.ts:cleanup' }); });

describe('mutual SSH bootstrap security invariants', () => {
  it('generates dedicated idempotent 0600 keypairs and rotates corruption', () => {
    const root = temp();
    const identity = new MachineSshIdentity(root, 'agent-a', 'machine-a');
    const first = identity.ensure();
    expect(first.clientPublicKey).toMatch(/^ssh-ed25519 /);
    expect(fs.statSync(first.clientPrivateKeyPath).mode & 0o777).toBe(0o600);
    expect(identity.ensure().clientGeneration).toBe(1);
    fs.writeFileSync(first.clientPrivateKeyPath, 'corrupt', { mode: 0o600 });
    expect(identity.ensure().clientGeneration).toBe(2);
    const second = identity.ensure();
    SafeFsExecutor.safeUnlinkSync(second.clientPrivateKeyPath, { operation: 'mutual-ssh-autobootstrap.test.ts:delete-corrupt-pair-private' });
    SafeFsExecutor.safeUnlinkSync(`${second.clientPrivateKeyPath}.pub`, { operation: 'mutual-ssh-autobootstrap.test.ts:delete-corrupt-pair-public' });
    expect(identity.ensure().clientGeneration).toBe(3);
    expect(fs.existsSync(path.join(root, 'machine-ssh'))).toBe(true);
  });

  it('fences admissions by epoch/generation and refuses cross-identity key reuse', () => {
    const root = temp();
    const key = new MachineSshIdentity(root, 'agent-a', 'a').ensure().clientPublicKey;
    const store = new SshPeerAdmissionStore(root);
    const expiry = new Date(Date.now() + 60_000).toISOString();
    store.reconcile([{ agentId: 'agent-a', machineId: 'a', pairingEpoch: 2, clientGeneration: 2, observerBootId: 'boot', publicKey: key, expiresAt: expiry }]);
    store.reconcile([{ agentId: 'agent-a', machineId: 'a', pairingEpoch: 1, clientGeneration: 99, observerBootId: 'boot', publicKey: key, expiresAt: expiry }]);
    expect(store.list()[0].pairingEpoch).toBe(2);
    expect(() => store.reconcile([
      { agentId: 'agent-a', machineId: 'a', pairingEpoch: 3, clientGeneration: 3, observerBootId: 'boot', publicKey: key, expiresAt: expiry },
      { agentId: 'agent-b', machineId: 'b', pairingEpoch: 3, clientGeneration: 3, observerBootId: 'boot', publicKey: key, expiresAt: expiry },
    ])).toThrow('identity-conflict');
  });

  it('never declares mutual from one direction or expired evidence', () => {
    const proof = { sourceMachineId: 'a', targetMachineId: 'b', pairingEpoch: 1, observerBootId: 'boot-a', endpointId: 'lan', sourceClientKeyGeneration: 1, targetHostKeyGeneration: 1, targetHostKeyFingerprint: 'x', verifiedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 1000).toISOString(), challengeDigest: 'x' };
    expect(MutualSshVerifier.mutual(proof, undefined)).toBe(false);
    expect(MutualSshVerifier.mutual(proof, { ...proof, sourceMachineId: 'b', targetMachineId: 'a', observerBootId: 'boot-b' })).toBe(true);
    expect(MutualSshVerifier.mutual(proof, { ...proof, sourceMachineId: 'b', targetMachineId: 'a', expiresAt: new Date(0).toISOString() })).toBe(false);
  });

  it('rejects public and stale adverts', () => {
    const identity = new MachineSshIdentity(temp(), 'agent', 'key-source').ensure();
    const base = { machineId: 'a', agentId: 'agent', pairingEpoch: 1, observerBootId: 'boot', clientKeyGeneration: 1, hostKeyGeneration: 1, clientPublicKey: identity.clientPublicKey, sshHostPublicKeys: [identity.hostPublicKey], issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), endpoints: [{ host: '8.8.8.8', port: 4045, source: 'lan' }] };
    expect(() => validateSshBootstrapAdvert(base, 'a', 'agent')).toThrow('endpoint-invalid');
    expect(() => validateSshBootstrapAdvert({ ...base, endpoints: [], expiresAt: new Date(0).toISOString() }, 'a', 'agent')).toThrow('expired');
  });

  it('enforces the ten-machine sweep bound and bounded repair breaker', async () => {
    MutualSshHealthController.validateCapacity(10, 4, 8_000, 300_000);
    expect(() => MutualSshHealthController.validateCapacity(20, 1, 8_000, 300_000)).toThrow('capacity-invalid');
    const verifier = { probe: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) } as any;
    const hooks = { refreshAdvert: vi.fn(), reconcileAdmission: vi.fn(), rotateSourceKey: vi.fn(), notifySecurity: vi.fn(), notifyExhausted: vi.fn() };
    const controller = new MutualSshHealthController(verifier, hooks);
    const target = { sourceMachineId: 'a', targetMachineId: 'b', host: '10.0.0.2', port: 4045, endpointId: 'lan', pairingEpoch: 1, observerBootId: 'boot', sourceClientKeyGeneration: 1, targetHostKeyGeneration: 1, targetHostPublicKey: 'ssh-ed25519 AAAA', clientPrivateKeyPath: '/none', expectedMachineFingerprint: 'fp', expectedSourceClientKeyFingerprint: 'client-fp', verifyMachineResponse: () => true };
    await controller.check(target);
    expect(verifier.probe).toHaveBeenCalledTimes(4);
    expect(hooks.notifyExhausted).toHaveBeenCalledOnce();
  }, 15_000);

  it('covers all 90 ten-machine directions within the full timeout-path budget without starvation', async () => {
    const scheduler = new MutualSshProbeScheduler(4, 300_000, 8_000);
    const machines = Array.from({ length: 10 }, (_, index) => `m${index}`);
    const directions = machines.flatMap(sourceMachineId => machines
      .filter(targetMachineId => targetMachineId !== sourceMachineId)
      .map((targetMachineId, index) => ({ sourceMachineId, targetMachineId, healthy: index % 4 === 0 })));
    scheduler.validate(machines.length);
    expect(scheduler.worstCaseSweepMs(machines.length)).toBe(184_000);
    const result = await scheduler.sweep(directions, async () => { await Promise.resolve(); });
    expect(new Set(result.attempted).size).toBe(90);
    expect(result.peakConcurrency).toBeLessThanOrEqual(4);
    expect(result.attempted.slice(0, 8).some(id => directions.find(row => `${row.sourceMachineId}->${row.targetMachineId}` === id)?.healthy)).toBe(true);
  });
});
