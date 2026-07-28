import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign, verify as verifySignature } from 'node:crypto';
import net from 'node:net';
import { MutualSshProbeScheduler } from '../../src/core/MutualSshProbeScheduler.js';
import { SshHostKeyLifecycle, type SignedHostKeyProposal } from '../../src/core/SshHostKeyLifecycle.js';
import { SshPeerAdmissionStore } from '../../src/core/SshPeerAdmissionStore.js';
import { MutualSshVerifier, type DirectionalSshProof } from '../../src/core/MutualSshVerifier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MutualSshRuntime, type MutualSshPeer } from '../../src/core/MutualSshRuntime.js';
import { canonicalSshBootstrapAdvert, type SshBootstrapAdvert } from '../../src/core/SshBootstrapAdvert.js';
import { canonicalDirectionalSshProof } from '../../src/core/MutualSshVerifier.js';
import { classifyMutualSshFailure } from '../../src/core/MutualSshHealthController.js';
import { MachineSshIdentity } from '../../src/core/MachineSshIdentity.js';
import { MachineSshEndpoint } from '../../src/core/MachineSshEndpoint.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'mutual-ssh-hardening.test.ts:cleanup' }); });

const publicKey = (seed: string) => {
  const type = Buffer.from('ssh-ed25519');
  const wire = Buffer.alloc(4 + type.length + 4 + 32);
  wire.writeUInt32BE(type.length);
  type.copy(wire, 4);
  wire.writeUInt32BE(32, 4 + type.length);
  wire.fill(seed.charCodeAt(0), 4 + type.length + 4);
  return `ssh-ed25519 ${wire.toString('base64')} instar:test`;
};

describe('mutual SSH hardened lifecycle', () => {
  it('fences host generations and promotes only a proven quarantined successor', () => {
    const lifecycle = new SshHostKeyLifecycle({ generation: 3, publicKey: publicKey('a') });
    const proposal: SignedHostKeyProposal = {
      agentId: 'agent', machineId: 'm-a', pairingEpoch: 2, generation: 4,
      previousGeneration: 3, publicKey: publicKey('b'), issuedAt: new Date().toISOString(),
      machineSignature: 'valid', previousHostSignature: 'valid',
    };
    const verifier = { verifyMachine: () => true, verifyPreviousHost: () => true };
    expect(lifecycle.propose(proposal, verifier, 1_000).state).toBe('overlap');
    expect(() => lifecycle.promote(4, false, 1_001)).toThrow('host-key-proofs-incomplete');
    expect(lifecycle.promote(4, true, 1_002).generation).toBe(4);
    expect(() => lifecycle.propose({ ...proposal, generation: 3, previousGeneration: 2 }, verifier)).toThrow('host-key-rollback-rejected');
  });

  it('quarantines an unsigned substitution and rejects competing generations', () => {
    const lifecycle = new SshHostKeyLifecycle({ generation: 1, publicKey: publicKey('a') });
    const proposal: SignedHostKeyProposal = {
      agentId: 'agent', machineId: 'm-a', pairingEpoch: 1, generation: 2,
      previousGeneration: 1, publicKey: publicKey('b'), issuedAt: new Date().toISOString(), machineSignature: 'bad',
    };
    expect(() => lifecycle.propose(proposal, { verifyMachine: () => false, verifyPreviousHost: () => false })).toThrow('host-key-machine-signature-invalid');
    lifecycle.propose({ ...proposal, machineSignature: 'valid' }, { verifyMachine: () => true, verifyPreviousHost: () => false });
    expect(lifecycle.snapshot().candidate?.state).toBe('quarantined');
    expect(() => lifecycle.propose({ ...proposal, generation: 3, previousGeneration: 2, publicKey: publicKey('c') }, { verifyMachine: () => true, verifyPreviousHost: () => false })).toThrow();
  });

  it('invalidates admissions after restart and prevents wall-clock rollback extending a lease', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ssh-admission-'));
    roots.push(root);
    let wall = 10_000;
    let mono = 1_000;
    const clock = { wallNow: () => wall, monotonicNow: () => mono };
    const store = new SshPeerAdmissionStore(root, clock);
    const key = publicKey('k');
    store.reconcile([{ agentId: 'a', machineId: 'm', pairingEpoch: 1, clientGeneration: 1, observerBootId: 'boot-1', publicKey: key, expiresAt: new Date(wall + 300_000).toISOString() }]);
    const raw = Buffer.from(key.split(/\s+/)[1], 'base64');
    expect(store.authenticate(raw)).not.toBeNull();
    wall = 1; // hostile/backwards wall-clock jump
    mono = 301_001;
    expect(store.authenticate(raw)).toBeNull();
    expect(new SshPeerAdmissionStore(root, clock).authenticate(raw)).toBeNull();
  });

  it('requires live boots, current generations and observer-local monotonic freshness', () => {
    const proof = (source: string, target: string, boot: string): DirectionalSshProof => ({
      sourceMachineId: source, targetMachineId: target, pairingEpoch: 5, observerBootId: boot,
      endpointId: 'private', sourceClientKeyGeneration: 2, targetHostKeyGeneration: 4,
      targetHostKeyFingerprint: 'fp', verifiedAt: new Date(1_000).toISOString(),
      expiresAt: new Date(301_000).toISOString(), challengeDigest: 'digest', monotonicDeadlineMs: 500,
    });
    const a = proof('a', 'b', 'boot-a');
    const b = proof('b', 'a', 'boot-b');
    const context = {
      monotonicNow: 499, liveBootIds: new Set(['boot-a', 'boot-b']),
      sourceClientGenerations: new Map([['a', 2], ['b', 2]]),
      targetHostGenerations: new Map([['a', 4], ['b', 4]]),
    };
    expect(MutualSshVerifier.mutual(a, b, 2_000, context)).toBe(true);
    expect(MutualSshVerifier.mutual(a, b, 2_000, { ...context, monotonicNow: 500 })).toBe(false);
    expect(MutualSshVerifier.mutual(a, b, 2_000, { ...context, liveBootIds: new Set(['boot-a']) })).toBe(false);
  });

  it('covers all 90 ten-machine directions with bounded concurrency and healthy reserve', async () => {
    const machines = Array.from({ length: 10 }, (_, i) => `m-${i}`);
    const directions = machines.flatMap(sourceMachineId => machines
      .filter(targetMachineId => targetMachineId !== sourceMachineId)
      .map((targetMachineId, i) => ({ sourceMachineId, targetMachineId, healthy: i % 5 === 0 })));
    const scheduler = new MutualSshProbeScheduler(4, 300_000, 8_000);
    scheduler.validate(10);
    let active = 0;
    let peak = 0;
    const result = await scheduler.sweep(directions, async () => {
      active += 1; peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
    });
    expect(new Set(result.attempted).size).toBe(90);
    expect(result.peakConcurrency).toBeLessThanOrEqual(4);
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.attempted.slice(0, 4).some(key => directions.find(d => `${d.sourceMachineId}->${d.targetMachineId}` === key)?.healthy)).toBe(true);
  });

  it('finishes 90 full 8-second timeout paths inside the five-minute proof window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const machines = Array.from({ length: 10 }, (_, i) => `timeout-${i}`);
      const directions = machines.flatMap(sourceMachineId => machines.filter(targetMachineId => targetMachineId !== sourceMachineId).map(targetMachineId => ({ sourceMachineId, targetMachineId, healthy: false })));
      const scheduler = new MutualSshProbeScheduler(4, 300_000, 8_000);
      const sweep = scheduler.sweep(directions, () => new Promise<void>(resolve => setTimeout(resolve, 8_000)));
      await vi.advanceTimersByTimeAsync(184_000);
      const result = await sweep;
      expect(result.attempted).toHaveLength(90);
      expect(result.peakConcurrency).toBe(4);
      expect(result.elapsedMs).toBe(184_000);
      expect(result.elapsedMs).toBeLessThan(300_000);
    } finally { vi.useRealTimers(); }
  });

  it('rejects delayed journal proofs after restart and revoke→re-pair epoch change', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ssh-runtime-'));
    roots.push(root);
    const sourceKeys = generateKeyPairSync('ed25519');
    const selfKeys = generateKeyPairSync('ed25519');
    const peers: MutualSshPeer[] = [];
    const signature = (key: typeof sourceKeys.privateKey, payload: string) => sign(null, Buffer.from(payload), key).toString('base64');
    const deps = (boot: string) => ({
      stateDir: root, agentId: 'agent', selfMachineId: 'self', selfMachineFingerprint: 'self-fp',
      observerBootId: boot, bindHost: '127.0.0.1', bindPort: 0, dryRun: true, requiredForReadiness: true,
      listPeers: () => peers,
      send: async () => ({}), sign: (payload: string) => signature(selfKeys.privateKey, payload),
      verify: (machineId: string, payload: string, sig: string) => {
        const key = machineId === 'source' ? sourceKeys.publicKey : selfKeys.publicKey;
        return verifySignature(null, Buffer.from(payload), key, Buffer.from(sig, 'base64'));
      },
    });
    const first = new MutualSshRuntime(deps('self-boot-1'));
    await first.start();
    expect(first.status()).toMatchObject({ enrollmentState: 'ready', readinessRequired: true, ready: true });
    peers.push({ machineId: 'source', pairingEpoch: 7, machineFingerprint: 'source-fp', endpoints: [] });
    expect(first.status()).toMatchObject({ enrollmentState: 'ssh-bootstrap', readinessRequired: true, ready: false });
    const unsignedAdvert: Omit<SshBootstrapAdvert, 'machineSignature'> = {
      machineId: 'source', agentId: 'agent', pairingEpoch: 7, observerBootId: 'source-boot-1',
      clientKeyGeneration: 2, hostKeyGeneration: 1, clientPublicKey: publicKey('s'),
      sshHostPublicKeys: [publicKey('h')], endpoints: [], issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    first.handleAdvert({ ...unsignedAdvert, machineSignature: signature(sourceKeys.privateKey, canonicalSshBootstrapAdvert(unsignedAdvert)) }, 'source');
    const unsignedProof: Omit<DirectionalSshProof, 'machineSignature' | 'monotonicDeadlineMs'> = {
      sourceMachineId: 'source', targetMachineId: 'self', pairingEpoch: 7, observerBootId: 'source-boot-1',
      endpointId: 'private', sourceClientKeyGeneration: 2, targetHostKeyGeneration: 1,
      targetHostKeyFingerprint: 'host-fp', verifiedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(), challengeDigest: 'challenge',
    };
    const proof = { ...unsignedProof, machineSignature: signature(sourceKeys.privateKey, canonicalDirectionalSshProof(unsignedProof)) };
    expect(first.handleJournalProof(proof, 'source')).toBe(true);
    peers[0] = { ...peers[0], pairingEpoch: 8 };
    expect(first.handleJournalProof(proof, 'source')).toBe(false);
    await first.rollback();
    expect(first.status()).toMatchObject({ enrollmentState: 'ready', readinessRequired: false, ready: true });

    peers[0] = { ...peers[0], pairingEpoch: 7 };
    await new Promise(resolve => setTimeout(resolve, 2));
    const restarted = new MutualSshRuntime(deps('self-boot-2'));
    await restarted.start();
    restarted.handleAdvert({ ...unsignedAdvert, machineSignature: signature(sourceKeys.privateKey, canonicalSshBootstrapAdvert(unsignedAdvert)) }, 'source');
    expect(restarted.handleJournalProof(proof, 'source')).toBe(false);
    await restarted.rollback();
  });

  it('maps environmental failures to stable non-security blocked reasons', () => {
    expect(classifyMutualSshFailure(new Error('EADDRINUSE'))).toBe('port-collision');
    expect(classifyMutualSshFailure(new Error('EACCES firewall'))).toBe('firewall-denied');
    expect(classifyMutualSshFailure(new Error('ENETUNREACH from VPN route'))).toBe('vpn-route-unavailable');
    expect(classifyMutualSshFailure(new Error('system-sleep detected'))).toBe('system-sleep');
  });

  it('refuses non-CGNAT public 100/8 binds and leaves personal SSH byte-identical through rollback', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ssh-isolation-'));
    roots.push(root);
    const personal = path.join(root, 'home', '.ssh');
    fs.mkdirSync(personal, { recursive: true });
    for (const [name, body] of [['id_ed25519', 'personal-private'], ['config', 'Host *\n  IdentityFile personal'], ['known_hosts', 'example key'], ['authorized_keys', 'operator key']]) fs.writeFileSync(path.join(personal, name), body);
    const before = Object.fromEntries(fs.readdirSync(personal).map(name => [name, fs.readFileSync(path.join(personal, name))]));
    const stateDir = path.join(root, 'state');
    const identity = new MachineSshIdentity(stateDir, 'agent', 'self').ensure();
    const admissions = new SshPeerAdmissionStore(stateDir);
    const endpoint = new MachineSshEndpoint({ hostPrivateKeyPath: identity.hostPrivateKeyPath, admissionStore: admissions, machineId: 'self', machineFingerprint: 'fp', hostGeneration: 1, respond: () => { throw new Error('unused'); } });
    await expect(endpoint.listen('100.10.20.30', 42000)).rejects.toThrow('ssh-public-bind-refused');
    const runtime = new MutualSshRuntime({ stateDir, agentId: 'agent', selfMachineId: 'self', selfMachineFingerprint: 'fp', observerBootId: 'self-boot', bindHost: '127.0.0.1', bindPort: 0, dryRun: true, listPeers: () => [], send: async () => ({}), sign: () => 'x'.repeat(64), verify: () => true });
    await runtime.start();
    await runtime.rollback();
    for (const [name, bytes] of Object.entries(before)) expect(fs.readFileSync(path.join(personal, name))).toEqual(bytes);
  });

  it('surfaces a port collision as blocked and recovers on the next reconcile', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ssh-port-recovery-'));
    roots.push(root);
    const blocker = net.createServer();
    await new Promise<void>((resolve, reject) => blocker.once('error', reject).listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('test-listener-address-missing');
    const runtime = new MutualSshRuntime({ stateDir: root, agentId: 'agent', selfMachineId: 'self', selfMachineFingerprint: 'fp', observerBootId: 'self-boot', bindHost: '127.0.0.1', bindPort: address.port, dryRun: false, listPeers: () => [], send: async () => ({}), sign: () => 'x'.repeat(64), verify: () => true });
    await runtime.start();
    expect(runtime.status().blockedReasons).toContain('port-collision');
    await new Promise<void>(resolve => blocker.close(() => resolve()));
    await runtime.tick();
    expect(runtime.status().listener).toBe(true);
    expect(runtime.status().blockedReasons).not.toContain('port-collision');
    await runtime.rollback();
  }, 10_000);
});
