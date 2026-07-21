import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateSigningKeyPair, sign, verify } from '../../src/core/MachineIdentity.js';
import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import {
  FeedbackDrainTickProxy,
  resolveFeedbackDrainOwnerMachineId,
  signDrainTickProxyEnvelope,
  verifyDrainTickProxyEnvelope,
} from '../../src/feedback-factory/drain/FeedbackDrainTickProxy.js';
import type { FeedbackDrainService } from '../../src/feedback-factory/drain/FeedbackDrainService.js';

const KEY = 'proxy-signing-key'.repeat(4);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-tick-proxy.test.ts' });
});

function fakeService(onAccept: () => { runId: string; accepted: boolean }): FeedbackDrainService {
  return {
    canAgentMutateReadiness: (agentId: string) => agentId === 'codey',
    acceptTick: onAccept,
  } as unknown as FeedbackDrainService;
}

describe('FeedbackDrainTickProxy', () => {
  it('cryptographically binds sender, target, principal, nonce, expiry, and exactly one hop', () => {
    const now = 10_000;
    const envelope = signDrainTickProxyEnvelope({
      senderMachineId: 'machine-b', targetMachineId: 'machine-a', agentId: 'codey',
      nonce: 'proxy-nonce-00000001', issuedAt: now, expiresAt: now + 30_000,
    }, KEY);
    expect(verifyDrainTickProxyEnvelope(envelope, { selfMachineId: 'machine-a', signingKey: KEY, now, maxTtlMs: 30_000 })).toEqual({ ok: true });
    for (const changed of [
      { ...envelope, senderMachineId: 'machine-c' },
      { ...envelope, targetMachineId: 'machine-c' },
      { ...envelope, agentId: 'other-agent' },
      { ...envelope, nonce: 'proxy-nonce-00000002' },
      { ...envelope, expiresAt: now - 1 },
      { ...envelope, hopCount: 2 as 1 },
    ]) {
      expect(verifyDrainTickProxyEnvelope(changed, { selfMachineId: 'machine-a', signingKey: KEY, now, maxTtlMs: 30_000 }).ok).toBe(false);
    }
  });

  it('persists owner-side proxy replay rejection across restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-proxy-replay-')); dirs.push(dir);
    const dbPath = path.join(dir, 'feedback-drain.db');
    const envelope = signDrainTickProxyEnvelope({
      senderMachineId: 'machine-b', targetMachineId: 'machine-a', agentId: 'codey',
      nonce: 'proxy-restart-nonce-0001', issuedAt: 10_000, expiresAt: 40_000,
    }, KEY);
    let accepts = 0;
    const firstStore = new FeedbackDrainStore({ dbPath, tokenHmacKey: KEY, clock: () => 10_000 });
    const first = new FeedbackDrainTickProxy({ selfMachineId: 'machine-a', ownerMachineId: () => 'machine-a', isCanonicalOwner: () => true,
      store: firstStore, service: fakeService(() => ({ runId: `run-${++accepts}`, accepted: true })), signingKey: KEY, clock: () => 10_000 });
    expect((await first.receive(envelope)).status).toBe(202);
    firstStore.close();

    const restartedStore = new FeedbackDrainStore({ dbPath, tokenHmacKey: KEY, clock: () => 10_001 });
    const restarted = new FeedbackDrainTickProxy({ selfMachineId: 'machine-a', ownerMachineId: () => 'machine-a', isCanonicalOwner: () => true,
      store: restartedStore, service: fakeService(() => ({ runId: `run-${++accepts}`, accepted: true })), signingKey: KEY, clock: () => 10_001 });
    expect(await restarted.receive(envelope)).toMatchObject({ status: 409, body: { reason: 'replay' } });
    expect(accepts).toBe(1);
    restartedStore.close();
  });

  it('binds the claimed sender to its registered asymmetric machine identity', async () => {
    const keys = { b: generateSigningKeyPair(), c: generateSigningKeyPair() };
    const store = new FeedbackDrainStore({ dbPath: ':memory:', db: new Database(':memory:'), tokenHmacKey: KEY });
    const owner = new FeedbackDrainTickProxy({
      selfMachineId: 'machine-a', ownerMachineId: () => 'machine-a', isCanonicalOwner: () => true,
      store, service: fakeService(() => ({ runId: 'identity-run', accepted: true })), signingKey: KEY,
      verifyEnvelope: (sender, data, signature) => sender === 'machine-b' && verify(data, signature, keys.b.publicKey),
    });
    const legitimate = new FeedbackDrainTickProxy({
      selfMachineId: 'machine-b', ownerMachineId: () => 'machine-a', isCanonicalOwner: () => false,
      store, service: fakeService(() => ({ runId: 'must-not-run', accepted: true })), signingKey: KEY,
      signEnvelope: (data) => sign(data, keys.b.privateKey), transport: (_target, envelope) => owner.receive(envelope),
    });
    expect((await legitimate.request({ agentId: 'codey', nonce: 'identity-bound-nonce-001' })).status).toBe(202);

    const impersonator = new FeedbackDrainTickProxy({
      selfMachineId: 'machine-b', ownerMachineId: () => 'machine-a', isCanonicalOwner: () => false,
      store, service: fakeService(() => ({ runId: 'must-not-run', accepted: true })), signingKey: KEY,
      signEnvelope: (data) => sign(data, keys.c.privateKey), transport: (_target, envelope) => owner.receive(envelope),
    });
    expect(await impersonator.request({ agentId: 'codey', nonce: 'identity-forged-nonce-01' }))
      .toMatchObject({ status: 403, body: { error: 'proxy-machine-signature-invalid' } });
    store.close();
  });

  it('returns owner-unavailable and never executes a nonowner local fallback', async () => {
    const store = new FeedbackDrainStore({ dbPath: ':memory:', db: new Database(':memory:'), tokenHmacKey: KEY });
    let localExecutions = 0;
    const proxy = new FeedbackDrainTickProxy({
      selfMachineId: 'machine-b', ownerMachineId: () => 'machine-a', isCanonicalOwner: () => true,
      store, service: fakeService(() => ({ runId: `wrong-${++localExecutions}`, accepted: true })), signingKey: KEY,
    });
    expect(await proxy.request({ agentId: 'codey', nonce: 'owner-down-nonce-00001' }))
      .toMatchObject({ status: 503, body: { reason: 'owner-unavailable' } });
    expect(localExecutions).toBe(0);
    store.close();
  });

  it('does not self-elect when a multi-machine config omits the operated owner', () => {
    expect(resolveFeedbackDrainOwnerMachineId(undefined, 'machine-b', true)).toBeNull();
    expect(resolveFeedbackDrainOwnerMachineId(undefined, 'only-machine', false)).toBe('only-machine');
    expect(resolveFeedbackDrainOwnerMachineId('machine-a', 'machine-b', true)).toBe('machine-a');
  });
});
