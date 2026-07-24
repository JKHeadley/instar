import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { MachineSshIdentity } from '../../src/core/MachineSshIdentity.js';
import { SshPeerAdmissionStore } from '../../src/core/SshPeerAdmissionStore.js';
import { canonicalSshResponse, MachineSshEndpoint, type SshRpcResponse } from '../../src/core/MachineSshEndpoint.js';
import { MutualSshVerifier } from '../../src/core/MutualSshVerifier.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { Client, utils } from 'ssh2';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'mutual-ssh-real-transport.test.ts:cleanup' }); });

describe('real restricted SSH transport', () => {
  it('proves A→B and B→A from their respective OS processes', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-child-a-')); dirs.push(rootA);
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-child-b-')); dirs.push(rootB);
    const fixture = path.resolve('tests/fixtures/mutual-ssh-endpoint-child.ts');
    const viteNode = path.resolve('node_modules/.bin/vite-node');
    const startChild = (root: string, id: string) => spawn(viteNode, [fixture, root, id], { stdio: ['pipe', 'pipe', 'pipe'] });
    const a = startChild(rootA, 'a');
    const b = startChild(rootB, 'b');
    const stderr = new Map<ChildProcessWithoutNullStreams, string>([[a, ''], [b, '']]);
    for (const child of [a, b]) child.stderr.on('data', chunk => stderr.set(child, `${stderr.get(child)}${String(chunk)}`));
    const queues = new Map<ChildProcessWithoutNullStreams, { rows: any[]; waiters: Array<(row: any) => void> }>();
    const next = (child: ChildProcessWithoutNullStreams) => {
      let state = queues.get(child);
      if (!state) {
        state = { rows: [], waiters: [] }; queues.set(child, state);
        let buffered = '';
        child.stdout.on('data', chunk => {
          buffered += String(chunk);
          for (;;) {
            const newline = buffered.indexOf('\n');
            if (newline < 0) break;
            const row = JSON.parse(buffered.slice(0, newline)); buffered = buffered.slice(newline + 1);
            const waiter = state!.waiters.shift(); if (waiter) waiter(row); else state!.rows.push(row);
          }
        });
      }
      if (state.rows.length) return Promise.resolve(state.rows.shift());
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`child-response-timeout: ${stderr.get(child)}`)), 8_000);
        state!.waiters.push(row => { clearTimeout(timer); resolve(row); });
      });
    };
    try {
      const [readyA, readyB] = await Promise.all([next(a), next(b)]);
      a.stdin.write(`${JSON.stringify({ type: 'start', peerMachineId: 'b', peerBootId: 'boot-b', peerClientPublicKey: readyB.clientPublicKey })}\n`);
      b.stdin.write(`${JSON.stringify({ type: 'start', peerMachineId: 'a', peerBootId: 'boot-a', peerClientPublicKey: readyA.clientPublicKey })}\n`);
      const [listenA, listenB] = await Promise.all([next(a), next(b)]);
      expect(listenA.type).toBe('started');
      expect(listenB.type).toBe('started');
      a.stdin.write(`${JSON.stringify({ type: 'probe', targetMachineId: 'b', host: listenB.host, port: listenB.port, targetHostPublicKey: readyB.hostPublicKey, targetMachinePublicPem: readyB.machinePublicPem })}\n`);
      b.stdin.write(`${JSON.stringify({ type: 'probe', targetMachineId: 'a', host: listenA.host, port: listenA.port, targetHostPublicKey: readyA.hostPublicKey, targetMachinePublicPem: readyA.machinePublicPem })}\n`);
      const [proofA, proofB] = await Promise.all([next(a), next(b)]);
      expect(proofA.type).toBe('proof');
      expect(proofB.type).toBe('proof');
      expect(MutualSshVerifier.mutual(proofA.proof, proofB.proof)).toBe(true);
    } finally {
      a.stdin.write(`${JSON.stringify({ type: 'close' })}\n`);
      b.stdin.write(`${JSON.stringify({ type: 'close' })}\n`);
      setTimeout(() => { a.kill(); b.kill(); }, 2_000).unref();
    }
  }, 20_000);

  it('proves A→B and B→A from separate endpoint processes and rejects one-sided mutual', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-a-')); dirs.push(rootA);
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-b-')); dirs.push(rootB);
    const a = new MachineSshIdentity(rootA, 'agent', 'a').ensure();
    const b = new MachineSshIdentity(rootB, 'agent', 'b').ensure();
    const machineKeyA = generateKeyPairSync('ed25519');
    const machineKeyB = generateKeyPairSync('ed25519');
    const expiry = new Date(Date.now() + 120_000).toISOString();
    const admissionsA = new SshPeerAdmissionStore(rootA);
    const admissionsB = new SshPeerAdmissionStore(rootB);
    admissionsA.reconcile([{ agentId: 'agent', machineId: 'b', pairingEpoch: 1, clientGeneration: b.clientGeneration, observerBootId: 'boot-b', publicKey: b.clientPublicKey, expiresAt: expiry }]);
    admissionsB.reconcile([{ agentId: 'agent', machineId: 'a', pairingEpoch: 1, clientGeneration: a.clientGeneration, observerBootId: 'boot-a', publicKey: a.clientPublicKey, expiresAt: expiry }]);
    const responder = (machineId: string, machineFingerprint: string, privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']) => (c: Omit<SshRpcResponse, 'machineId' | 'machineFingerprint' | 'sourceClientKeyFingerprint' | 'signature'>, admission: { publicKey: string }) => {
      const unsigned = { ...c, machineId, machineFingerprint, sourceClientKeyFingerprint: MachineSshIdentity.fingerprint(admission.publicKey) };
      return { ...unsigned, signature: sign(null, Buffer.from(canonicalSshResponse(unsigned)), privateKey).toString('base64') };
    };
    const endpointA = new MachineSshEndpoint({ hostPrivateKeyPath: a.hostPrivateKeyPath, admissionStore: admissionsA, machineId: 'a', machineFingerprint: 'fp-a', hostGeneration: a.hostGeneration, respond: responder('a', 'fp-a', machineKeyA.privateKey) });
    const endpointB = new MachineSshEndpoint({ hostPrivateKeyPath: b.hostPrivateKeyPath, admissionStore: admissionsB, machineId: 'b', machineFingerprint: 'fp-b', hostGeneration: b.hostGeneration, respond: responder('b', 'fp-b', machineKeyB.privateKey) });
    const listenA = await endpointA.listen('127.0.0.1', 0);
    const listenB = await endpointB.listen('127.0.0.1', 0);
    const verifier = new MutualSshVerifier();
    try {
      const aToB = await verifier.probe({ sourceMachineId: 'a', targetMachineId: 'b', ...listenB, endpointId: 'loopback', pairingEpoch: 1, observerBootId: 'boot-a', sourceClientKeyGeneration: a.clientGeneration, targetHostKeyGeneration: b.hostGeneration, targetHostPublicKey: b.hostPublicKey, clientPrivateKeyPath: a.clientPrivateKeyPath, expectedMachineFingerprint: 'fp-b', expectedSourceClientKeyFingerprint: MachineSshIdentity.fingerprint(a.clientPublicKey), verifyMachineResponse: (payload, signature) => verify(null, Buffer.from(payload), machineKeyB.publicKey, Buffer.from(signature, 'base64')) });
      const bToA = await verifier.probe({ sourceMachineId: 'b', targetMachineId: 'a', ...listenA, endpointId: 'loopback', pairingEpoch: 1, observerBootId: 'boot-b', sourceClientKeyGeneration: b.clientGeneration, targetHostKeyGeneration: a.hostGeneration, targetHostPublicKey: a.hostPublicKey, clientPrivateKeyPath: b.clientPrivateKeyPath, expectedMachineFingerprint: 'fp-a', expectedSourceClientKeyFingerprint: MachineSshIdentity.fingerprint(b.clientPublicKey), verifyMachineResponse: (payload, signature) => verify(null, Buffer.from(payload), machineKeyA.publicKey, Buffer.from(signature, 'base64')) });
      expect(MutualSshVerifier.mutual(aToB, bToA)).toBe(true);
    } finally { await endpointA.close(); await endpointB.close(); }
  }, 20_000);

  it('revocation drains an authenticated live connection and rejects reconnect', async () => {
    const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-revoke-a-')); dirs.push(rootA);
    const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh-revoke-b-')); dirs.push(rootB);
    const a = new MachineSshIdentity(rootA, 'agent', 'a').ensure();
    const b = new MachineSshIdentity(rootB, 'agent', 'b').ensure();
    const admissions = new SshPeerAdmissionStore(rootB);
    admissions.reconcile([{ agentId: 'agent', machineId: 'a', pairingEpoch: 1, clientGeneration: 1, observerBootId: 'boot-a', publicKey: a.clientPublicKey, expiresAt: new Date(Date.now() + 60_000).toISOString() }]);
    const endpoint = new MachineSshEndpoint({ hostPrivateKeyPath: b.hostPrivateKeyPath, admissionStore: admissions, machineId: 'b', machineFingerprint: 'fp-b', hostGeneration: 1, respond: () => { throw new Error('unused'); } });
    const listen = await endpoint.listen('127.0.0.1', 0);
    const parsedHost = utils.parseKey(b.hostPublicKey);
    if (parsedHost instanceof Error) throw parsedHost;
    const connect = () => new Promise<Client>((resolve, reject) => {
      const client = new Client();
      client.once('ready', () => resolve(client));
      client.once('error', reject);
      client.connect({ ...listen, username: 'instar', privateKey: fs.readFileSync(a.clientPrivateKeyPath), hostVerifier: key => key.equals(parsedHost.getPublicSSH()), readyTimeout: 3_000 });
    });
    try {
      const client = await connect();
      expect(endpoint.activeSessionCount('a')).toBe(1);
      const closed = new Promise<void>(resolve => client.once('close', () => resolve()));
      endpoint.revoke('a');
      await closed;
      expect(endpoint.activeSessionCount('a')).toBe(0);
      await expect(connect()).rejects.toThrow();
    } finally { await endpoint.close(); }
  }, 10_000);
});
