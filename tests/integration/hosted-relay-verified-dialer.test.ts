import { createHash, X509Certificate } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http2 from 'node:http2';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createHostedRelayVerifiedDialer } from '../../src/hostedRelay/verifiedDialer.js';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function listen(server: net.Server) {
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  cleanups.push(() => server.close());
  await ready;
  return (server.address() as AddressInfo).port;
}

function fixtureCertificate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-relay-dial-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'relay dial fixture cleanup' }));
  const cert = path.join(root, 'cert.pem'), key = path.join(root, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=localhost', '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10000 });
  const certificate = fs.readFileSync(cert), privateKey = fs.readFileSync(key);
  const spki = new X509Certificate(certificate).publicKey.export({ type: 'spki', format: 'der' });
  return { cert: certificate, key: privateKey, spkiSha256: createHash('sha256').update(spki).digest('hex') };
}

it('requires CA trust, exact hostname and relay key pin before giving the caller an HTTP/2 session', async () => {
  const { cert, key, spkiSha256 } = fixtureCertificate();
  const server = http2.createSecureServer({ cert, key });
  let requests = 0;
  server.on('stream', stream => { requests++; stream.respond({ ':status': 204 }, { endStream: true }); });
  const port = await listen(server);
  const origin = 'https://localhost:' + port;
  const signal = new AbortController().signal;
  const create = (override = {}) => createHostedRelayVerifiedDialer({ origin, spkiSha256, ca: cert, ...override });
  await expect(create({ spkiSha256: '0'.repeat(64) })(signal)).rejects.toThrow('certificate-or-connection');
  await expect(create({ ca: undefined })(signal)).rejects.toThrow('certificate-or-connection');
  await expect(create({ origin: 'https://127.0.0.1:' + port })(signal)).rejects.toThrow('certificate-or-connection');
  expect(requests).toBe(0);

  const dial = new AbortController();
  const connection = await create()(dial.signal);
  dial.abort();
  cleanups.push(() => connection.session.destroy());
  const stream = connection.session.request({ ':path': '/fixture' });
  expect((await once(stream, 'response'))[0][':status']).toBe(204);
  expect(requests).toBe(1);
  connection.session.destroy();
  await connection.closed;
});

it('refuses HTTPS peers without HTTP/2 and disposes a dial cancelled before TLS completes', async () => {
  const { cert, key, spkiSha256 } = fixtureCertificate();
  const plain = tls.createServer({ cert, key, ALPNProtocols: ['http/1.1'] }, socket => {
    cleanups.push(() => socket.destroy());
  });
  const plainPort = await listen(plain);
  const signal = new AbortController().signal;
  const create = (port: number) => createHostedRelayVerifiedDialer({ origin: 'https://localhost:' + port, spkiSha256, ca: cert });
  await expect(create(plainPort)(signal)).rejects.toThrow('hosted-relay-dial');

  const listening = net.createServer();
  const port = await listen(listening);
  const accepted = once(listening, 'connection');
  const abort = new AbortController();
  const outcome = create(port)(abort.signal);
  const [peer] = await accepted;
  cleanups.push(() => peer.destroy());
  const closed = once(peer, 'close');
  peer.resume();
  abort.abort();
  await expect(outcome).rejects.toThrow('hosted-relay-dial-aborted');
  await closed;
});

it('refuses insecure or non-origin configuration', () => {
  for (const origin of ['http://relay.example', 'https://relay.example/offer', 'https://user@relay.example']) {
    expect(() => createHostedRelayVerifiedDialer({ origin, spkiSha256: 'a'.repeat(64) })).toThrow('hosted-relay-dial-config');
  }
});
