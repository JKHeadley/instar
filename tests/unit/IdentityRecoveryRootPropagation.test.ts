import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityRecoveryRootPropagationQueue } from '../../src/core/IdentityRecoveryRootPropagation.js';
import type { MachineIdentity } from '../../src/core/types.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, {
  recursive: true, force: true, operation: 'IdentityRecoveryRootPropagation.test:cleanup',
}); });
const identity = { machineId: 'machine-a', recoveryEpoch: 1, recoveryPublicKey: 'root', signingPublicKey: 'sign', encryptionPublicKey: 'enc' } as MachineIdentity;
const grant = (peer: string, epoch = 1) => ({
  version: 1 as const, action: 'rotate-recovery-root' as const, issuerMachineId: 'machine-a',
  recipientMachineId: peer, subjectMachineId: 'machine-a', epoch, contentHash: 'a'.repeat(64),
  nonce: peer.padEnd(64, '0'), issuedAt: 1, expiresAt: 999999, signature: 'sig',
});

describe('IdentityRecoveryRootPropagationQueue', () => {
  it('retries a dark peer after restart and completes without re-sending completed peers', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-propagation-'));
    roots.push(stateDir);
    let now = 1000;
    let b = false;
    const sendPeer = vi.fn(async (peer: string) => peer === 'a' || b ? 'rotated' as const : 'pending' as const);
    const deps = { stateDir, now: () => now, sendPeer, validateDelegation: () => true, notify: vi.fn() };
    const queue = new IdentityRecoveryRootPropagationQueue(deps);
    queue.enqueue(identity, { a: grant('a'), b: grant('b') });
    await queue.tick();
    expect(queue.status()[0].peers.a.status).toBe('rotated');
    b = true;
    now += 60_001;
    const restarted = new IdentityRecoveryRootPropagationQueue(deps);
    await restarted.tick();
    expect(restarted.status()[0].completedAt).toBeDefined();
    expect(sendPeer.mock.calls.filter((call) => call[0] === 'a')).toHaveLength(1);
  });

  it('keeps a committed epoch immutable when a later caller supplies a new peer', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-propagation-'));
    roots.push(stateDir);
    const queue = new IdentityRecoveryRootPropagationQueue({ stateDir, sendPeer: async () => 'already-current', validateDelegation: () => true, notify: vi.fn() });
    queue.enqueue(identity, { a: grant('a') });
    await queue.tick();
    queue.enqueue(identity, { a: grant('a'), b: grant('b') });
    expect(queue.status()[0].peers.b).toBeUndefined();
  });

  it('never sends a prepared transaction until local identity and escrow reconcile', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-propagation-'));
    roots.push(stateDir);
    const sendPeer = vi.fn(async () => 'rotated' as const);
    const queue = new IdentityRecoveryRootPropagationQueue({ stateDir, sendPeer, validateDelegation: () => true, notify: vi.fn() });
    const prepared = queue.prepare(identity, { a: grant('a') });
    await queue.tick();
    expect(sendPeer).not.toHaveBeenCalled();
    const restarted = new IdentityRecoveryRootPropagationQueue({ stateDir, sendPeer, validateDelegation: () => true, notify: vi.fn() });
    restarted.reconcile(identity, true);
    await restarted.tick();
    expect(restarted.status()[0]).toMatchObject({ id: prepared.id, phase: 'committed' });
    expect(restarted.status()[0].completedAt).toBeDefined();
  });

  it('rolls back an uncommitted prepared outbox when the public identity never changed', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-propagation-'));
    roots.push(stateDir);
    const queue = new IdentityRecoveryRootPropagationQueue({ stateDir, sendPeer: async () => 'rotated', validateDelegation: () => true, notify: vi.fn() });
    queue.prepare(identity, { a: grant('a') });
    queue.reconcile({ ...identity, recoveryEpoch: 0, recoveryPublicKey: undefined }, true);
    expect(queue.status()).toEqual([]);
  });

  it('reconstructs a corrupt file outbox from the redundant signed intent', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-propagation-'));
    roots.push(stateDir);
    const queue = new IdentityRecoveryRootPropagationQueue({ stateDir, sendPeer: async () => 'rotated', validateDelegation: () => true, notify: vi.fn(), now: () => 1234 });
    const file = path.join(stateDir, 'state', 'identity-recovery-establishment.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{corrupt');
    queue.recoverPrepared(identity, { a: grant('a') });
    expect(queue.status()[0].phase).toBe('prepared');
    expect(fs.existsSync(`${file}.corrupt.1234`)).toBe(true);
  });

  it('terminalizes after 72h and requires explicit reauthorization before retry', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-propagation-'));
    roots.push(stateDir);
    let now = 1_000_000;
    let reachable = false;
    const queue = new IdentityRecoveryRootPropagationQueue({
      stateDir, now: () => now, notify: vi.fn(),
      validateDelegation: () => true,
      sendPeer: async () => reachable ? 'rotated' : 'pending',
    });
    const job = queue.enqueue(identity, { a: grant('a') });
    await queue.tick();
    now += 72 * 60 * 60_000 + 1;
    await queue.tick();
    expect(queue.status()[0].failedAt).toBeDefined();
    reachable = true;
    now += 6 * 60 * 60_000;
    await queue.tick();
    expect(queue.status()[0].completedAt).toBeUndefined();
    queue.reauthorize(job.id, { a: grant('a') });
    await queue.tick();
    expect(queue.status()[0].completedAt).toBeDefined();
  });

  it('terminalizes an explicitly revoked pending recipient and permits the next root rotation', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-propagation-revoked-'));
    roots.push(stateDir);
    const sendPeer = vi.fn(async (peer: string) => peer === 'a' ? 'rotated' as const : 'pending' as const);
    const queue = new IdentityRecoveryRootPropagationQueue({
      stateDir, sendPeer, validateDelegation: () => true, notify: vi.fn(),
    });
    const first = queue.enqueue(identity, { a: grant('a'), b: grant('b') });
    await queue.tick();
    expect(queue.status()[0].peers.b.status).toBe('pending');

    queue.reconcileRevokedPeers(['b']);
    expect(queue.status()[0]).toMatchObject({
      completedAt: expect.any(String), peers: { a: { status: 'rotated' }, b: { status: 'not-required' } },
    });
    expect(queue.retireCompleted(first.id)).toBe(true);

    const nextIdentity = { ...identity, recoveryEpoch: 2, recoveryPublicKey: 'root-2' };
    const second = queue.enqueue(nextIdentity, { a: grant('a', 2) });
    expect(second.id).toBe('machine-a:2');
  });

  it('refuses a hostile completed next-epoch preseed instead of retiring the retained root', () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-propagation-hostile-'));
    roots.push(stateDir);
    const file = path.join(stateDir, 'state', 'identity-recovery-establishment.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({ version: 3, jobs: { 'machine-a:1': {
      id: 'machine-a:1', machineIdentity: identity, createdAt: at, updatedAt: at, nextAttemptAt: at,
      attempts: 0, phase: 'committed', peers: { a: { status: 'rotated', attempts: 0 } },
      operatorDelegations: { a: grant('a') }, completedAt: at,
    } } }));
    const queue = new IdentityRecoveryRootPropagationQueue({
      stateDir, validateDelegation: () => false, sendPeer: async () => 'rotated', notify: vi.fn(),
    });
    expect(() => queue.prepare(identity, { a: grant('a') })).toThrow('queue is corrupt');
  });
});
