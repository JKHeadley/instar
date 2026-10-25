import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdentityReannounceClaimant, resolveContinuityBootstrapBearer } from '../../src/core/IdentityReannounceClaimant.js';
import { generateEncryptionKeyPair, generateSigningKeyPair, pemToBase64 } from '../../src/core/MachineIdentity.js';
import { MachineRecoveryKey, type RecoverySecretStore } from '../../src/core/MachineRecoveryKey.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MachineIdentity } from '../../src/core/types.js';

class FakeSecrets implements RecoverySecretStore {
  isKeychainBacked = true;
  data = new Map<string, unknown>();
  get(k: string): unknown { return this.data.get(k); }
  set(k: string, v: unknown): void { this.data.set(k, v); }
  delete(k: string): void { this.data.delete(k); }
}

describe('IdentityReannounceClaimant', () => {
  let root: string;
  let now: number;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'identity-claimant-')); now = 1_000_000; });
  afterEach(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'IdentityReannounceClaimant.test.ts' }));

  function fixture(admit = true, rotatedAt = now, continuityAvailable = true) {
    const signing = generateSigningKeyPair();
    const encryption = generateEncryptionKeyPair();
    const recovery = new MachineRecoveryKey(new FakeSecrets());
    const material = recovery.ensure('m-local')!;
    const identity: MachineIdentity = {
      machineId: 'm-local', signingPublicKey: pemToBase64(signing.publicKey), encryptionPublicKey: pemToBase64(encryption.publicKey),
      name: 'local', platform: 'test', createdAt: new Date(0).toISOString(), capabilities: ['sessions'], keyEpoch: 1,
      recoveryPublicKey: material.recoveryPublicKey, recoveryEpoch: 1, recoveryAnchorProvenance: 'first-hand',
      keysRotatedAt: new Date(rotatedAt).toISOString(), keysRotatedReason: 'lost local keys',
    };
    const notify = vi.fn();
    const submitClaim = vi.fn(async () => ({ outcome: 'accepted' as const }));
    const peers = [{ machineId: 'm-peer', url: 'https://peer.invalid' }];
    const requestChallenge = vi.fn(async (peer: { machineId: string }) => ({
      challengeId: `c-${peer.machineId}`, nonce: 'a'.repeat(64), challengerMachineId: peer.machineId, protocolVersion: 1,
    }));
    const deps = {
      stateDir: root,
      identity: () => identity,
      signingPrivateKey: () => signing.privateKey,
      recoveryContinuitySignature: (binding) => continuityAvailable ? recovery.signContinuity('m-local', binding) : null,
      peers: () => peers,
      requestChallenge,
      submitClaim,
      admit: async () => admit,
      notify,
      now: () => now,
    };
    const claimant = new IdentityReannounceClaimant(deps);
    return { claimant, deps, notify, submitClaim, requestChallenge, peers, identity };
  }

  function eligible(claimant: IdentityReannounceClaimant) {
    for (let i = 0; i < 10; i += 1) { claimant.recordAuthRejected('m-peer'); now += 100_000; }
  }

  it('loads a configured bearer before activation only for pinned automatic continuity recovery', () => {
    const identity = fixture().identity;
    identity.keysRotatedReason = 'automatic recovery: local private key material missing at boot';
    const token = 'a'.repeat(64);
    const base = {
      identityMutationCoherenceAllowed: false,
      recoveryEscrowDryRun: false,
      identity,
      escrowMatchesPinnedRoot: true,
      configuredBearerToken: token,
    };
    expect(resolveContinuityBootstrapBearer(base)).toBe(token);
    expect(resolveContinuityBootstrapBearer({ ...base, escrowMatchesPinnedRoot: false })).toBeNull();
    expect(resolveContinuityBootstrapBearer({ ...base, identity: { ...identity, recoveryPublicKey: undefined } })).toBeNull();
    expect(resolveContinuityBootstrapBearer({ ...base, identity: { ...identity, keysRotatedReason: 'operator rotation' } })).toBeNull();
    expect(resolveContinuityBootstrapBearer({ ...base, configuredBearerToken: 'not-a-token' })).toBeNull();
    expect(resolveContinuityBootstrapBearer({ ...base, identityMutationCoherenceAllowed: true })).toBeNull();
  });

  it('opens only after ten typed refusals spanning fifteen minutes and posts once on first acceptance', async () => {
    const f = fixture();
    eligible(f.claimant);
    await f.claimant.tick();
    expect(f.submitClaim).toHaveBeenCalledOnce();
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'first-acceptance', keyEpoch: 1 }));
    expect(f.claimant.status().episodes['m-local:1'].peers['m-peer']).toMatchObject({ status: 'accepted', attempts: 1 });
  });

  it('opens an escrow-continuity boot recovery immediately without refusal timing evidence', async () => {
    const f = fixture();
    f.claimant.openContinuityRecovery();
    await f.claimant.tick();
    expect(f.submitClaim).toHaveBeenCalledOnce();
    expect(f.claimant.status().episodes['m-local:1']).toMatchObject({
      continuityRequired: true, peers: { 'm-peer': { status: 'accepted', attempts: 1 } },
    });
  });

  it('adds and recovers a continuity peer when its route appears after the episode opens', async () => {
    const f = fixture();
    f.peers.splice(0, 1);
    f.claimant.openContinuityRecovery();
    expect(f.claimant.status().episodes['m-local:1'].peers).toEqual({});

    f.peers.push({ machineId: 'm-late', url: 'https://late.invalid' });
    await f.claimant.tick();

    expect(f.requestChallenge).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm-late' }), f.identity);
    expect(f.claimant.status().episodes['m-local:1'].peers['m-late']).toMatchObject({ status: 'accepted', attempts: 1 });
  });

  it('gives a peer first becoming routable after the horizon a fresh bounded recovery window', async () => {
    const f = fixture();
    f.peers.splice(0, 1);
    f.claimant.openContinuityRecovery();
    now += 73 * 60 * 60_000;
    await f.claimant.tick();

    f.peers.push({ machineId: 'm-late', url: 'https://late.invalid' });
    await f.claimant.tick();

    expect(f.requestChallenge).toHaveBeenCalledOnce();
    expect(f.claimant.status().episodes['m-local:1']).toMatchObject({
      openedAt: now,
      peers: { 'm-late': { status: 'accepted', attempts: 1 } },
    });
  });

  it('limits a recovery tick to four concurrent peer RPC sequences', async () => {
    const f = fixture();
    f.peers.splice(0, 1, ...Array.from({ length: 6 }, (_, index) => ({
      machineId: `m-peer-${index}`, url: `https://peer-${index}.invalid`,
    })));
    let releaseFirstBatch!: () => void;
    const firstBatch = new Promise<void>((resolve) => { releaseFirstBatch = resolve; });
    f.requestChallenge.mockImplementation(async (peer) => {
      if (peer.machineId !== 'm-peer-4' && peer.machineId !== 'm-peer-5') await firstBatch;
      return { challengeId: `c-${peer.machineId}`, nonce: 'a'.repeat(64), challengerMachineId: peer.machineId, protocolVersion: 1 };
    });
    f.claimant.openContinuityRecovery();

    const firstTick = f.claimant.tick();
    await vi.waitFor(() => expect(f.requestChallenge).toHaveBeenCalledTimes(4));
    expect(f.requestChallenge.mock.calls.map(([peer]) => peer.machineId)).toEqual([
      'm-peer-0', 'm-peer-1', 'm-peer-2', 'm-peer-3',
    ]);
    releaseFirstBatch();
    await firstTick;

    await f.claimant.tick();
    expect(f.requestChallenge).toHaveBeenCalledTimes(6);
    expect(f.claimant.status().episodes['m-local:1'].peers['m-peer-5']).toMatchObject({ status: 'accepted', attempts: 1 });
  });

  it('never downgrades a continuity-required boot episode when the escrow signature is unavailable', async () => {
    const f = fixture(true, now, false);
    f.claimant.openContinuityRecovery();
    await f.claimant.tick();
    expect(f.submitClaim).not.toHaveBeenCalled();
    expect(f.claimant.status().episodes['m-local:1'].peers['m-peer']).toMatchObject({
      status: 'refused', lastReason: 'recovery-continuity-unavailable',
    });
  });

  it('opens when the production ordering is rotation first, then the refusal run', async () => {
    const f = fixture(true, now - 1);
    eligible(f.claimant);
    await f.claimant.tick();
    expect(f.submitClaim).toHaveBeenCalledOnce();
  });

  it('resets refusal evidence that predates the current signing generation', async () => {
    const f = fixture();
    for (let i = 0; i < 9; i += 1) { f.claimant.recordAuthRejected('m-peer'); now += 120_000; }
    f.identity.keysRotatedAt = new Date(now).toISOString();
    f.claimant.recordAuthRejected('m-peer');
    expect(f.claimant.status().failures['m-peer']).toMatchObject({ count: 1, firstAt: now });
  });

  it('an interleaved verified success resets the refusal run', async () => {
    const f = fixture();
    for (let i = 0; i < 9; i += 1) { f.claimant.recordAuthRejected('m-peer'); now += 120_000; }
    f.claimant.recordSuccess('m-peer');
    f.claimant.recordAuthRejected('m-peer');
    await f.claimant.tick();
    expect(f.submitClaim).not.toHaveBeenCalled();
  });

  it('a governor deny parks the peer without consuming an attempt', async () => {
    const f = fixture(false);
    eligible(f.claimant);
    await f.claimant.tick();
    expect(f.claimant.status().episodes['m-local:1'].peers['m-peer']).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('persists an attempt before network work and retries an absent route with bounded backoff', async () => {
    const f = fixture();
    f.submitClaim.mockRejectedValue(Object.assign(new Error('route absent'), { status: 404 }));
    eligible(f.claimant);
    await f.claimant.tick();
    let row = f.claimant.status().episodes['m-local:1'].peers['m-peer'];
    expect(row).toMatchObject({ status: 'route-absent', attempts: 1, lastReason: 'peer-lacks-accept-route' });
    const firstRetryAt = row.nextAttemptAt;
    await f.claimant.tick();
    expect(f.submitClaim).toHaveBeenCalledTimes(1);
    now = firstRetryAt;
    await f.claimant.tick();
    row = f.claimant.status().episodes['m-local:1'].peers['m-peer'];
    expect(row).toMatchObject({ status: 'route-absent', attempts: 2 });
  });

  it('caps a rejected key generation at three durable attempts and gives up loudly', async () => {
    const f = fixture();
    f.submitClaim.mockResolvedValue({ outcome: 'refused', reason: 'peer-not-ready' });
    eligible(f.claimant);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await f.claimant.tick();
      const row = f.claimant.status().episodes['m-local:1'].peers['m-peer'];
      expect(row.attempts).toBe(attempt);
      if (attempt < 3) now = row.nextAttemptAt;
    }
    const row = f.claimant.status().episodes['m-local:1'].peers['m-peer'];
    expect(row.status).toBe('exhausted');
    expect(row.attempts).toBe(3);
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'horizon-exhausted' }));
  });

  it('terminalizes a crash-owned third attempt on restart without sending a fourth request', async () => {
    const f = fixture();
    f.claimant.openContinuityRecovery();
    f.requestChallenge.mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 500 }));
    await f.claimant.tick();
    now = f.claimant.status().episodes['m-local:1'].peers['m-peer'].nextAttemptAt;
    f.requestChallenge.mockRejectedValueOnce(Object.assign(new Error('server error'), { status: 500 }));
    await f.claimant.tick();
    now = f.claimant.status().episodes['m-local:1'].peers['m-peer'].nextAttemptAt;

    const neverReturns = new Promise<never>(() => {});
    f.requestChallenge.mockImplementationOnce(() => neverReturns);
    void f.claimant.tick();
    await vi.waitFor(() => expect(f.requestChallenge).toHaveBeenCalledTimes(3));
    const owned = f.claimant.status().episodes['m-local:1'].peers['m-peer'];
    expect(owned).toMatchObject({ status: 'pending', attempts: 3 });

    now = owned.nextAttemptAt;
    const restarted = new IdentityReannounceClaimant(f.deps);
    await restarted.tick();
    expect(f.requestChallenge).toHaveBeenCalledTimes(3);
    expect(restarted.status().episodes['m-local:1'].peers['m-peer']).toMatchObject({ status: 'exhausted', attempts: 3 });
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'horizon-exhausted' }));
  });

  it('freezes the horizon and refunds the generation cap while the peer is unreachable', async () => {
    const f = fixture();
    f.submitClaim.mockRejectedValue(new Error('network down'));
    eligible(f.claimant);
    await f.claimant.tick();
    let episode = f.claimant.status().episodes['m-local:1'];
    expect(episode.peers['m-peer']).toMatchObject({ status: 'pending', attempts: 0, lastReason: 'attempt-failed' });
    const openedAt = episode.openedAt;
    now = openedAt + 80 * 60 * 60_000;
    await f.claimant.tick();
    episode = f.claimant.status().episodes['m-local:1'];
    expect(episode.peers['m-peer'].status).toBe('pending');
    expect(f.notify).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'horizon-exhausted' }));
  });

  it.each([
    ['route-absent', Object.assign(new Error('route absent'), { status: 404 })],
    ['refused', null],
  ] as const)('marks retryable %s state exhausted at the 72-hour horizon', async (expectedStatus, thrown) => {
    const f = fixture();
    if (thrown) f.submitClaim.mockRejectedValue(thrown);
    else f.submitClaim.mockResolvedValue({ outcome: 'refused', reason: 'peer-not-ready' });
    eligible(f.claimant);
    await f.claimant.tick();
    const openedAt = f.claimant.status().episodes['m-local:1'].openedAt;
    expect(f.claimant.status().episodes['m-local:1'].peers['m-peer'].status).toBe(expectedStatus);
    now = openedAt + 72 * 60 * 60_000;
    await f.claimant.tick();
    expect(f.claimant.status().episodes['m-local:1'].peers['m-peer'].status).toBe('exhausted');
    expect(f.notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'horizon-exhausted' }));
  });
});
