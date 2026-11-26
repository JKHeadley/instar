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
import { startVerifiedHostedRelay } from '../../src/hostedRelay/startup.js';
import { MachineIdentityManager, sign as signMachine } from '../../src/core/MachineIdentity.js';
import { redeemHostedRelaySetupCode } from '../../src/hostedRelay/setupReceipt.js';
import { createHostedRelayVerifiedDialer } from '../../src/hostedRelay/verifiedDialer.js';
import { startHostedRelayAgentSession } from '../../src/hostedRelay/agentSession.js';
import { createDisposableHostedRelay } from '../../src/hostedRelay/disposableRelay.js';
import { HostedRelayLeaseAdmission } from '../../src/hostedRelay/leaseAdmission.js';

it('connects a signed outbound control session to an end-to-end TLS client in a disposable service', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-relay-service-'));
  const db = new Database(path.join(root, 'relay.sqlite'));
  db.pragma('synchronous = FULL');
  const hostname = 'agent.relay.example', agentId = 'synthetic-agent';
  const identity = new MachineIdentityManager(root);
  const { machineId: holder } = await identity.generateIdentity({ name: 'Relay test holder' });
  const owner = generateKeyPairSync('ed25519');
  const machinePem = identity.getSigningPublicKeyPem(holder)!;
  const machineSign = (text: string) => signMachine(text, identity.loadSigningKey());
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
  const authority = {
    registration: (name: string) => authorized && name === hostname ? { agentId, assignment: lease.assignment, pinnedGenesis: genesis.id,
      entries: [genesis.entry, ownerKey.entry] } : undefined,
    committedLease: (id: string) => id === agentId ? current : undefined,
    verifyFirstOwnerProof: (proof: { proof: string }) => proof.proof === 'fixture',
  };
  const reader = createHostedRelayOwnerLeaseReader(authority);
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
    const relayTrust = { origin: 'https://localhost:' + launched.controlPort,
      spkiSha256: createHash('sha256').update(spki).digest('hex'), ca: controlCert };
    const dial = createHostedRelayVerifiedDialer(relayTrust);
    const agentPin = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
    const tlsEntry = signOwnerRecordEntry({
      kind: 'tls-key', agentId, parents: [ownerKey.id], signer: { type: 'machine', keyId: holder },
      body: { machineId: holder, fingerprint: agentPin, seq: 1 },
    }, machineSign);
    let holdsAuthority = true;
    const scope = { hostname, agentId, assignment: lease.assignment, pinnedGenesis: genesis.id };
    const startup = {
      enabled: true, stateDir: root, scope, signal: controller.signal, relay: relayTrust,
      agentTls: { cert, key: fs.readFileSync(keyPath) },
      evidence: {
        ...authority,
        registration: (name: string) => name === hostname ? { ...scope, entries: [genesis.entry, ownerKey.entry, tlsEntry.entry] } : undefined,
      },
      holdsLocalAuthority: () => holdsAuthority,
      handlePhoneRequest: vi.fn<import('node:http').RequestListener>((_req, res) => { res.end('scoped agent response'); }),
    };
    expect(await startVerifiedHostedRelay({ ...startup, enabled: false, stateDir: '/missing' })).toBeUndefined();
    expect(await startVerifiedHostedRelay({ ...startup, scope: { ...scope, assignment: '2'.repeat(64) } })).toBeUndefined();
    expect(await startVerifiedHostedRelay({ ...startup, evidence: authority })).toBeUndefined();
    expect(await startVerifiedHostedRelay({ ...startup, holdsLocalAuthority() { throw new Error('offline'); } })).toBeUndefined();
    const runtime = (await startVerifiedHostedRelay(startup))!;
    expect(runtime.available()).toBe(false);
    await expect(runtime.issuePairingCode()).rejects.toThrow('relay-unavailable');
    try {
      let answer: string | undefined;
      let verifiedClient: tls.TLSSocket | undefined;
      for (let attempt = 0; attempt < 20 && !answer; attempt++) {
        const client = tls.connect({ port: launched.clientPort, host: '127.0.0.1', servername: hostname, ca: cert });
        client.setTimeout(500, () => client.destroy(new Error('fixture TLS deadline')));
        try {
          await once(client, 'secureConnect');
          client.write('GET / HTTP/1.1\r\nHost: ' + hostname + '\r\n\r\n');
          answer = (await once(client, 'data'))[0].toString();
          client.setTimeout(0);
          verifiedClient = client;
          cleanups.push(() => client.destroy());
        } catch {
          client.destroy();
          await wait(20); // @silent-fallback-ok — the relay may be waiting for its first admitted offer
        }
      }
      expect(answer).toContain('scoped agent response');
      expect(startup.handlePhoneRequest).toHaveBeenCalledOnce();
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
      expect(runtime.available()).toBe(true);
      const issuing = runtime.issuePairingCode();
      await expect(runtime.issuePairingCode()).rejects.toThrow('relay-busy');
      const issued = await issuing;
      expect(issued).toEqual({ code: expect.any(String), expiresInSeconds: 600 });
      expect(await redeemHostedRelaySetupCode({ code: issued.code, routingDomain: 'relay.example',
        connectVerified: dial, signal: controller.signal }))
        .toEqual({ kind: 'relay-locator', hostname, origin: 'https://' + hostname });
      expect((await requestJson(phone.session, redeem, { code: issued.code })).status).toBe(404);
      const pendingCode = await runtime.issuePairingCode();

      const revoked = new Promise<void>(done => verifiedClient!.once('close', () => done()));
      verifiedClient!.on('error', error => expect((error as NodeJS.ErrnoException).code).toBe('ECONNRESET'));
      holdsAuthority = false;
      expect(runtime.available()).toBe(false);
      await expect(runtime.issuePairingCode()).rejects.toThrow('relay-unavailable');
      await expect(runtime.closed).resolves.toBe('lease-unavailable');
      await revoked;
      authorized = false;
      expect((await requestJson(phone.session, redeem, { code: pendingCode.code })).status).toBe(404);
      const pendingControl = net.connect(launched.controlPort, '127.0.0.1');
      cleanups.push(() => pendingControl.destroy());
      await once(pendingControl, 'connect');
      const pendingClosed = new Promise<void>(done => pendingControl.once('close', () => done()));
      pendingControl.on('error', error => expect((error as NodeJS.ErrnoException).code).toBe('ECONNRESET'));
      controller.abort();
      await launched.stop();
      await pendingClosed;
    } finally {
      controller.abort();
      await runtime.stop();
      await launched.stop();
    }


  } finally {
    relay.stop();
    for (const cleanup of cleanups.reverse()) cleanup();
    db.close();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'disposable relay fixture cleanup' });
  }
});
