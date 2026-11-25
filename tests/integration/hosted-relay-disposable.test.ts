import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http2 from 'node:http2';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { FencedLease } from '../../src/core/FencedLease.js';
import { signOwnerRecordEntry } from '../../src/core/ownerRecord.js';
import { createHostedRelayOwnerLeaseReader } from '../../src/hostedRelay/ownerLeaseReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createDisposableHostedRelay } from '../../src/hostedRelay/disposableRelay.js';
import { HostedRelayLeaseAdmission, hostedRelayLeaseMessage } from '../../src/hostedRelay/leaseAdmission.js';

it('connects a signed outbound control session to an end-to-end TLS client in a disposable service', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-relay-service-'));
  const db = new Database(path.join(root, 'relay.sqlite'));
  db.pragma('synchronous = FULL');
  const hostname = 'agent.relay.example', agentId = 'synthetic-agent', holder = 'm_holder';
  const keys = generateKeyPairSync('ed25519'), owner = generateKeyPairSync('ed25519');
  const machinePem = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const machineSign = (text: string) => sign(null, Buffer.from(text), keys.privateKey).toString('base64');
  const genesis = signOwnerRecordEntry({ agentId, kind: 'genesis', parents: [], signer: { type: 'machine', keyId: holder },
    body: { machineId: holder, publicKey: machinePem, level: 'basic', agentProducible: true } }, machineSign);
  const ownerKey = signOwnerRecordEntry({ agentId, kind: 'add-owner-key', parents: [genesis.id],
    signer: { type: 'owner-key', keyId: 'o_phone' }, body: { keyId: 'o_phone', label: 'fixture',
      publicKey: owner.publicKey.export({ type: 'spki', format: 'pem' }).toString(), proof: 'fixture' } },
  text => sign(null, Buffer.from(text), owner.privateKey).toString('base64'));
  const expiresAt = Date.now() + 60_000;
  const lease = { hostname, assignment: '1'.repeat(64), holder, epoch: 1, expiresAt };
  const draft = { holder, epoch: 1, nonce: 1, acquiredAt: new Date().toISOString(), expiresAt: new Date(expiresAt).toISOString() };
  const current = { ...draft, signature: machineSign(FencedLease.canonicalize(draft)) };
  const reader = createHostedRelayOwnerLeaseReader({
    registration: name => name === hostname ? { agentId, assignment: lease.assignment, pinnedGenesis: genesis.id,
      entries: [genesis.entry, ownerKey.entry] } : undefined,
    committedLease: id => id === agentId ? current : undefined,
    verifyFirstOwnerProof: proof => proof.proof === 'fixture',
  });
  const gate = new HostedRelayLeaseAdmission(db, reader);
  const relay = createDisposableHostedRelay(gate);
  const cleanups: (() => void)[] = [];
  async function port(server: Pick<net.Server, 'listen' | 'address' | 'close' | 'once' | 'on' | 'removeListener'>) {
    cleanups.push(() => server.close());
    const ready = once(server, 'listening');
    server.listen(0, '127.0.0.1');
    await ready;
    return (server.address() as AddressInfo).port;
  }
  try {
    const certPath = path.join(root, 'cert.pem'), keyPath = path.join(root, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=' + hostname, '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 10000 });
    const cert = fs.readFileSync(certPath);
    const agentPort = await port(tls.createServer({ key: fs.readFileSync(keyPath), cert }, socket => {
      cleanups.push(() => socket.destroy());
      socket.write('direct agent certificate');
    }));
    const outbound = http2.createServer().on('stream', relay.acceptOutbound);
    const outboundPort = await port(outbound);
    const tcp = net.createServer(relay.acceptClient);
    const relayPort = await port(tcp);
    const agent = http2.connect('http://127.0.0.1:' + outboundPort);
    cleanups.push(() => agent.destroy());
    const request = (name: string) => agent.request({ ':method': 'POST', ':path': '/relay/v1/' + name }, { endStream: false });
    const early = request('offer');
    expect((await once(early, 'response'))[0][':status']).toBe(403);
    early.close();

    const control = request('control');
    const reader = readline.createInterface({ input: control });
    cleanups.push(() => reader.close());
    const lines = reader[Symbol.asyncIterator]();
    const challenge = JSON.parse((await lines.next()).value!);
    expect(challenge.type).toBe('challenge');
    const signature = machineSign(hostedRelayLeaseMessage(lease, challenge.nonce));
    const claim = JSON.stringify({ ...lease, challenge: challenge.nonce, signature });
    control.write(claim.slice(0, 45));
    control.write(claim.slice(45) + '\n');
    expect(JSON.parse((await lines.next()).value!)).toEqual({ type: 'admitted' });

    const seen = once(outbound, 'stream');
    const offered = request('offer');
    offered.on('response', headers => {
      if (headers[':status'] !== 200) return;
      const upstream = net.connect(agentPort, '127.0.0.1');
      cleanups.push(() => upstream.destroy());
      upstream.on('error', () => offered.destroy());
      upstream.pipe(offered).pipe(upstream);
    });
    // Wait for the offer to arrive at the dedicated listener before opening the TLS client.
    await seen;
    const client = tls.connect({ port: relayPort, host: '127.0.0.1', servername: hostname, ca: cert });
    cleanups.push(() => client.destroy());
    expect((await once(client, 'data'))[0].toString()).toBe('direct agent certificate');
    const closed = once(client, 'close');
    control.end();
    await closed;

    const deniedAgent = http2.connect('http://127.0.0.1:' + outboundPort);
    cleanups.push(() => deniedAgent.destroy());
    const deniedStream = deniedAgent.request({ ':method': 'POST', ':path': '/relay/v1/control' }, { endStream: false });
    const deniedReader = readline.createInterface({ input: deniedStream });
    cleanups.push(() => deniedReader.close());
    const denied = deniedReader[Symbol.asyncIterator]();
    const deniedChallenge = JSON.parse((await denied.next()).value!);
    deniedStream.write(JSON.stringify({ ...lease, challenge: deniedChallenge.nonce, signature }) + '\n');
    expect(JSON.parse((await denied.next()).value!)).toEqual({ type: 'refused' });

    const accepted = once(tcp, 'connection');
    const waiting = net.connect(relayPort, '127.0.0.1');
    cleanups.push(() => waiting.destroy());
    await Promise.all([accepted, once(waiting, 'connect')]);
    const stopped = once(waiting, 'close');
    relay.stop();
    await stopped;

  } finally {
    relay.stop();
    for (const cleanup of cleanups.reverse()) cleanup();
    db.close();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'disposable relay fixture cleanup' });
  }
});
