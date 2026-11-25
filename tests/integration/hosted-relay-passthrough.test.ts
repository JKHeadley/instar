import { generateKeyPairSync, sign } from 'node:crypto';
import Database from 'better-sqlite3';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net, { type AddressInfo, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { PassThrough, type Duplex } from 'node:stream';
import { afterEach, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { HostedRelayLeaseAdmission, hostedRelayLeaseMessage, type HostedRelayLease } from '../../src/hostedRelay/leaseAdmission.js';
import { HostedRelayStreamCustody } from '../../src/hostedRelay/streamCustody.js';
import { routeHostedRelaySocket } from '../../src/hostedRelay/tlsPassthrough.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
async function listen(server: Server) {
  cleanups.push(() => server.close());
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  return (server.address() as AddressInfo).port;
}

it('passes TLS through to the agent and leaves direct access working when the relay declines a route', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-tls-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'relay TLS fixture cleanup' }));
  const certificate = path.join(root, 'agent.pem'), key = path.join(root, 'agent.key');
  const hostname = 'test-agent.relay.example';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=' + hostname, '-keyout', key, '-out', certificate], { stdio: 'ignore', timeout: 10000 });
  const cert = fs.readFileSync(certificate);
  const large = Buffer.alloc(512 * 1024, 0x61);
  const agent = await listen(tls.createServer({ key: fs.readFileSync(key), cert }, socket => {
    cleanups.push(() => socket.destroy());
    socket.once('data', data => socket.end(data.toString() === 'large' ? large : Buffer.concat([Buffer.from('agent:'), data])));
  }));
  const names: string[] = [];
  const relay = await listen(net.createServer(socket => {
    cleanups.push(() => socket.destroy());
    routeHostedRelaySocket(socket, name => {
      names.push(name);
      return name === hostname ? net.connect(agent, '127.0.0.1') : undefined;
    });
  }));
  const request = async (port: number, servername = hostname) => {
    const client = tls.connect({ port, host: '127.0.0.1', servername, ca: cert });
    cleanups.push(() => client.destroy());
    await once(client, 'secureConnect');
    const response = once(client, 'data');
    client.write('private fixture text');
    return (await response)[0].toString();
  };
  expect(await request(relay)).toBe('agent:private fixture text');
  await expect(request(relay, 'unknown.relay.example')).rejects.toThrow();
  expect(await request(agent)).toBe('agent:private fixture text');
  const slow = tls.connect({ port: relay, host: '127.0.0.1', servername: hostname, ca: cert });
  cleanups.push(() => slow.destroy());
  await once(slow, 'secureConnect');
  slow.write('large');
  slow.pause();
  const responseParts: Buffer[] = [];
  slow.on('data', data => responseParts.push(data));
  const ended = once(slow, 'end');
  slow.resume();
  await ended;
  expect(Buffer.concat(responseParts)).toEqual(large);
  expect(names).toEqual([hostname, 'unknown.relay.example', hostname]);
});

it('closes displaced relay streams and accepts the next signed holder while direct TLS stays available', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-takeover-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'relay takeover fixture cleanup' }));
  const certificate = path.join(root, 'agent.pem'), key = path.join(root, 'agent.key');
  const hostname = 'takeover.relay.example';
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=' + hostname, '-keyout', key, '-out', certificate], { stdio: 'ignore', timeout: 10000 });
  const cert = fs.readFileSync(certificate), tlsKey = fs.readFileSync(key);
  const targets = await Promise.all(['first machine', 'next machine'].map(label =>
    listen(tls.createServer({ key: tlsKey, cert }, socket => {
      cleanups.push(() => socket.destroy());
      socket.write(label);
    }))));
  const writers = [generateKeyPairSync('ed25519'), generateKeyPairSync('ed25519')];
  let current: HostedRelayLease = { hostname, assignment: '1'.repeat(64), holder: 'machine-one', epoch: 1, expiresAt: Date.now() + 60_000 };
  const db = new Database(path.join(root, 'relay.sqlite'));
  db.pragma('synchronous = FULL');
  cleanups.push(() => db.close());
  const gate = new HostedRelayLeaseAdmission(db, name => name === hostname ? {
    ...current, publicKeyPem: writers[current.epoch - 1].publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  } : undefined);
  const custody = new HostedRelayStreamCustody(gate);
  cleanups.push(() => custody.stop());
  const reasons: string[] = [];
  function attach(openStream?: () => Duplex) {
    const challenge = gate.challenge();
    const writer = current.epoch - 1;
    const signature = sign(null, Buffer.from(hostedRelayLeaseMessage(current, challenge.nonce)), writers[writer].privateKey).toString('base64');
    return custody.attach({ ...current, challenge: challenge.nonce, signature }, challenge, {
      openStream: openStream ?? (() => net.connect(targets[writer], '127.0.0.1')),
      disconnect: reason => reasons.push(reason),
    });
  }
  const relay = await listen(net.createServer(client => {
    cleanups.push(() => client.destroy());
    routeHostedRelaySocket(client, name => custody.openStream(name));
  }));
  async function clientAt(port: number) {
    const client = tls.connect({ port, host: '127.0.0.1', servername: hostname, ca: cert });
    cleanups.push(() => client.destroy());
    const [hello] = await once(client, 'data');
    return { client, hello: hello.toString() };
  }
  const first = attach();
  expect(first).toBeTypeOf('function');
  const old = await clientAt(relay);
  expect(old.hello).toBe('first machine');
  const closed = once(old.client, 'close');
  current = { ...current, holder: 'machine-two', epoch: 2 };
  expect(attach()).toBeTypeOf('function');
  await closed;
  expect(reasons).toEqual(['displaced']);
  first?.();
  expect((await clientAt(relay)).hello).toBe('next machine');
  expect((await clientAt(targets[0])).hello).toBe('first machine');

  let factoryCalls = 0;
  expect(attach(() => {
    factoryCalls++;
    custody.openStream(hostname);
    return new PassThrough();
  })).toBeTypeOf('function');
  expect(custody.openStream(hostname)).toBeDefined();
  expect(factoryCalls).toBe(64);
  expect(custody.openStream(hostname)).toBeUndefined();
});
