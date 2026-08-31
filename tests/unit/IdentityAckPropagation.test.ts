import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertIdentityAckPropagationSettled, IdentityAckPropagationQueue } from '../../src/core/IdentityAckPropagation.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, {
  recursive: true, force: true, operation: 'IdentityAckPropagation.test:cleanup',
}); });
const grant = { version: 1 as const, action: 'acknowledge-signing-rotation' as const,
  issuerMachineId: 'local', recipientMachineId: 'peer-b', subjectMachineId: 'machine-a', epoch: 2,
  contentHash: 'a'.repeat(64), nonce: 'b'.repeat(64), issuedAt: 1, expiresAt: 999999999, signature: 'sig' };

describe('IdentityAckPropagationQueue', () => {
  it('persists pending peers, retries after restart, and completes idempotently', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-ack-'));
    roots.push(stateDir);
    let now = 1_000_000;
    let reachable = false;
    const deps = {
      stateDir, now: () => now,
      validateDelegation: () => true,
      sendPeer: vi.fn(async () => reachable ? 'already-acknowledged' as const : 'pending' as const),
      notify: vi.fn(),
    };
    const first = new IdentityAckPropagationQueue(deps);
    first.enqueue('machine-a', 2, { 'peer-b': grant });
    await first.tick();
    expect(first.status()[0].completedAt).toBeUndefined();
    reachable = true;
    now += 60_001;
    const restarted = new IdentityAckPropagationQueue(deps);
    const completed = await restarted.tick();
    expect(completed[0].completedAt).toBeDefined();
    expect(restarted.status()).toEqual([]);
  });

  it('resurfaces once at 24h and escalates once at 72h', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-ack-'));
    roots.push(stateDir);
    let now = 1_000_000;
    const notify = vi.fn();
    const queue = new IdentityAckPropagationQueue({
      stateDir, now: () => now,
      validateDelegation: () => true,
      sendPeer: async () => 'pending', notify,
    });
    queue.enqueue('machine-a', 2, { 'peer-b': grant });
    await queue.tick();
    now += 24 * 60 * 60_000 + 1;
    await queue.tick();
    await queue.tick();
    now += 48 * 60 * 60_000 + 1;
    await queue.tick();
    await queue.tick();
    expect(notify.mock.calls.map((call) => call[0].priority)).toEqual(['high', 'critical']);
  });

  it('keeps an active URL-less peer pending and delivers when its URL appears without restart', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-ack-'));
    roots.push(stateDir);
    let now = 1_000_000;
    let peerUrl: string | undefined;
    const sendPeer = vi.fn(async () => peerUrl ? 'acknowledged' as const : 'pending' as const);
    const queue = new IdentityAckPropagationQueue({
      stateDir, now: () => now, validateDelegation: () => true, sendPeer, notify: vi.fn(),
    });
    queue.enqueue('machine-a', 2, { 'peer-b': grant });
    await queue.tick();
    expect(queue.status()[0].peers['peer-b'].status).toBe('pending');
    peerUrl = 'https://peer.example';
    now += 60_001;
    const completed = await queue.tick();
    expect(completed[0].completedAt).toBeDefined();
    expect(queue.status()).toEqual([]);
    expect(sendPeer).toHaveBeenCalledTimes(2);
  });

  it('refuses a hostile preseeded journal before it can clear local acknowledgement authority', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-ack-hostile-'));
    roots.push(stateDir);
    const file = path.join(stateDir, 'state', 'identity-rotation-ack-propagation.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify({ version: 1, jobs: { 'machine-a:2': {
      id: 'machine-a:2', machineId: 'machine-a', keyEpoch: 2, createdAt: at, updatedAt: at,
      nextAttemptAt: at, attempts: 0, local: 'acknowledged', peers: { 'peer-b': { status: 'acknowledged', attempts: 0 } },
      operatorDelegations: { 'peer-b': grant }, completedAt: at,
    } } }));
    const queue = new IdentityAckPropagationQueue({
      stateDir, validateDelegation: () => false, sendPeer: vi.fn(async () => 'acknowledged'), notify: vi.fn(),
    });
    await expect(queue.tick()).rejects.toThrow('queue is corrupt');
  });

  it('retires completed old-root grants and fences recovery-root rotation while an ACK is pending', async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-ack-root-fence-'));
    roots.push(stateDir);
    let reachable = false;
    let oldRootValid = true;
    const queue = new IdentityAckPropagationQueue({
      stateDir, validateDelegation: () => oldRootValid,
      sendPeer: async () => reachable ? 'acknowledged' : 'pending', notify: vi.fn(),
    });
    queue.enqueue('machine-a', 2, { 'peer-b': grant });
    await queue.tick();
    expect(() => assertIdentityAckPropagationSettled(queue)).toThrow('must converge');
    reachable = true;
    const file = path.join(stateDir, 'state', 'identity-rotation-ack-propagation.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.jobs['machine-a:2'].nextAttemptAt = new Date(0).toISOString();
    fs.writeFileSync(file, JSON.stringify(data));
    await queue.tick();
    expect(queue.status()).toEqual([]);
    oldRootValid = false; // models the recovery-root rotation completing
    expect(() => assertIdentityAckPropagationSettled(queue)).not.toThrow();
  });
});
