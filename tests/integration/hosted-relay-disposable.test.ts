import { createHash, generateKeyPairSync, sign, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http2 from 'node:http2';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import readline from 'node:readline';
import { setTimeout as wait } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { FencedLease } from '../../src/core/FencedLease.js';
import { signOwnerRecordEntry } from '../../src/core/ownerRecord.js';
import { createHostedRelayOwnerLeaseReader } from '../../src/hostedRelay/ownerLeaseReader.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { launchDisposableHostedRelay } from '../../src/hostedRelay/disposableLauncher.js';
import { runHostedRelayReconnect } from '../../src/hostedRelay/reconnect.js';
import { createHostedRelayVerifiedDialer } from '../../src/hostedRelay/verifiedDialer.js';
import { startHostedRelayAgentSession } from '../../src/hostedRelay/agentSession.js';
import { createDisposableHostedRelay } from '../../src/hostedRelay/disposableRelay.js';
import { HostedRelayLeaseAdmission } from '../../src/hostedRelay/leaseAdmission.js';

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
  let authorized = true;
  const reader = createHostedRelayOwnerLeaseReader({
    registration: name => authorized && name === hostname ? { agentId, assignment: lease.assignment, pinnedGenesis: genesis.id,
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

    const arrival = Promise.withResolvers<void>();
    outbound.on('stream', (_stream, headers) => { if (headers[':path'] === '/relay/v1/offer') arrival.resolve(); });
    let signedControl: string | undefined;
    const session = await startHostedRelayAgentSession({
      session: agent, lease,
      sign(text) { signedControl = machineSign(text); return signedControl; },
      openLocalTls: () => {
        const upstream = net.connect(agentPort, '127.0.0.1');
        cleanups.push(() => upstream.destroy());
        return upstream;
      },
    });
    await arrival.promise;
    const client = tls.connect({ port: relayPort, host: '127.0.0.1', servername: hostname, ca: cert });
    cleanups.push(() => client.destroy());
    expect((await once(client, 'data'))[0].toString()).toBe('direct agent certificate');
    const closed = once(client, 'close');
    session.stop();
    await closed;

    const deniedAgent = http2.connect('http://127.0.0.1:' + outboundPort);
    cleanups.push(() => deniedAgent.destroy());
    const deniedStream = deniedAgent.request({ ':method': 'POST', ':path': '/relay/v1/control' }, { endStream: false });
    const deniedReader = readline.createInterface({ input: deniedStream });
    cleanups.push(() => deniedReader.close());
    const denied = deniedReader[Symbol.asyncIterator]();
    const deniedChallenge = JSON.parse((await denied.next()).value!);
    deniedStream.write(JSON.stringify({ ...lease, challenge: deniedChallenge.nonce, signature: signedControl }) + '\n');
    expect(JSON.parse((await denied.next()).value!)).toEqual({ type: 'refused' });

    const broken = http2.connect('http://127.0.0.1:' + outboundPort);
    cleanups.push(() => broken.destroy());
    const originalRequest = broken.request.bind(broken);
    vi.spyOn(broken, 'request').mockImplementation((headers, options) => {
      if (headers?.[':path'] === '/relay/v1/offer') throw new Error('fixture offer creation failure');
      return originalRequest(headers, options);
    });
    const openLocalTls = vi.fn(() => undefined);
    await expect(startHostedRelayAgentSession({ session: broken, lease, sign: machineSign, openLocalTls }))
      .rejects.toThrow('hosted-relay-agent-unavailable');
    expect(openLocalTls).not.toHaveBeenCalled();

    const accepted = once(tcp, 'connection');
    const waiting = net.connect(relayPort, '127.0.0.1');
    cleanups.push(() => waiting.destroy());
    await Promise.all([accepted, once(waiting, 'connect')]);
    const stopped = once(waiting, 'close');
    relay.stop();
    await stopped;

    const controlCertificate = path.join(root, 'control.pem'), controlKey = path.join(root, 'control.key');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', controlKey, '-out', controlCertificate], { stdio: 'ignore', timeout: 10000 });
    const controlCert = fs.readFileSync(controlCertificate);
    const spki = new X509Certificate(controlCert).publicKey.export({ type: 'spki', format: 'der' });
    const launched = await launchDisposableHostedRelay({ leases: gate, cert: controlCert, key: fs.readFileSync(controlKey) });
    const controller = new AbortController();
    const dial = createHostedRelayVerifiedDialer({ origin: 'https://localhost:' + launched.controlPort,
      spkiSha256: createHash('sha256').update(spki).digest('hex'), ca: controlCert });
    let holderSession: http2.ClientHttp2Session | undefined;
    const run = runHostedRelayReconnect({
      scope: lease, signal: controller.signal, currentLease: () => lease, sign: machineSign,
      async connectVerified(signal) {
        const connection = await dial(signal);
        holderSession = connection.session;
        return connection;
      },
      openLocalTls: () => net.connect(agentPort, '127.0.0.1'),
    });
    try {
      let answer: string | undefined;
      let verifiedClient: tls.TLSSocket | undefined;
      for (let attempt = 0; attempt < 20 && !answer; attempt++) {
        const client = tls.connect({ port: launched.clientPort, host: '127.0.0.1', servername: hostname, ca: cert });
        client.setTimeout(500, () => client.destroy(new Error('fixture TLS deadline')));
        try {
          answer = (await once(client, 'data'))[0].toString();
          client.setTimeout(0);
          verifiedClient = client;
          cleanups.push(() => client.destroy());
        } catch {
          client.destroy();
          await wait(20); // @silent-fallback-ok — the relay may be waiting for its first admitted offer
        }
      }
      expect(answer).toBe('direct agent certificate');
      const phone = await dial(controller.signal);
      cleanups.push(() => phone.session.destroy());
      const issue = '/relay/v1/rendezvous/issue', redeem = '/relay/v1/rendezvous/redeem';
      async function requestJson(session: http2.ClientHttp2Session, path: string, input?: object) {
        const stream = session.request({ ':method': 'POST', ':path': path });
        const response = once(stream, 'response');
        stream.end(input && JSON.stringify(input));
        const [headers] = await response;
        const parts: Buffer[] = [];
        for await (const part of stream) parts.push(part);
        expect(headers['cache-control']).toBe('no-store');
        return { status: headers[':status'], value: JSON.parse(Buffer.concat(parts).toString()) };
      }
      expect((await requestJson(phone.session, issue)).status).toBe(403);
      const issued = await requestJson(holderSession!, issue);
      expect(issued).toEqual({ status: 201, value: { code: expect.any(String), expiresInSeconds: 600 } });
      expect(await requestJson(phone.session, redeem, { code: issued.value.code }))
        .toEqual({ status: 200, value: { hostname } });
      expect((await requestJson(phone.session, redeem, { code: issued.value.code })).status).toBe(404);
      const pendingCode = await requestJson(holderSession!, issue);

      const revoked = new Promise<void>(done => verifiedClient!.once('close', () => done()));
      verifiedClient!.on('error', error => expect((error as NodeJS.ErrnoException).code).toBe('ECONNRESET'));
      authorized = false;
      await revoked;
      expect((await requestJson(phone.session, redeem, { code: pendingCode.value.code })).status).toBe(404);
      const pendingControl = net.connect(launched.controlPort, '127.0.0.1');
      cleanups.push(() => pendingControl.destroy());
      await once(pendingControl, 'connect');
      const pendingClosed = new Promise<void>(done => pendingControl.once('close', () => done()));
      pendingControl.on('error', error => expect((error as NodeJS.ErrnoException).code).toBe('ECONNRESET'));
      controller.abort();
      await expect(run).resolves.toBe('stopped');
      await launched.stop();
      await pendingClosed;
    } finally {
      controller.abort();
      await run;
      await launched.stop();
    }


  } finally {
    relay.stop();
    for (const cleanup of cleanups.reverse()) cleanup();
    db.close();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'disposable relay fixture cleanup' });
  }
});
