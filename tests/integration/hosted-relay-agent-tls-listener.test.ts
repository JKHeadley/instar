import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { once } from 'node:events';
import { connect } from 'node:net';
import { get } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { startHostedRelayAgentTlsListener } from '../../src/hostedRelay/agentTlsListener.js';

it('binds a pinned agent certificate only on loopback and refuses a mismatched request authority', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-agent-tls-'));
  const abort = new AbortController();
  const hostname = 'agent.relay.example';
  try {
    const certPath = path.join(root, 'cert.pem');
    const keyPath = path.join(root, 'key.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=' + hostname, '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 10_000 });
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    const expectedSpkiSha256 = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
    const handlePhoneRequest = vi.fn<import('node:http').RequestListener>((_req, res) => { res.end('scoped phone response'); });
    const options = { hostname, cert, key, expectedSpkiSha256, handlePhoneRequest, signal: abort.signal };
    await expect(startHostedRelayAgentTlsListener({ ...options, expectedSpkiSha256: '0'.repeat(64) }))
      .rejects.toThrow('relay-agent-certificate-mismatch');
    const listener = await startHostedRelayAgentTlsListener(options);
    async function request(host: string, servername: string) {
      return new Promise<{ status?: number; body: string }>((resolve, reject) => {
        const req = get({ host: '127.0.0.1', port: listener.port, servername, ca: cert, headers: { Host: host }, agent: false,
          checkServerIdentity: (_name, peer) => peer.raw.equals(new X509Certificate(cert).raw) ? undefined : new Error('wrong fixture certificate'),
        }, res => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', chunk => { body += chunk; });
          res.once('end', () => resolve({ status: res.statusCode, body }));
          res.once('error', reject);
        });
        req.once('error', reject);
      });
    }
    expect(await request(hostname, hostname)).toEqual({ status: 200, body: 'scoped phone response' });
    expect(await request('other.relay.example', hostname)).toEqual({ status: 421, body: '' });
    expect(await request(hostname, 'other.relay.example')).toEqual({ status: 421, body: '' });
    expect(handlePhoneRequest).toHaveBeenCalledOnce();
    const pending = connect(listener.port, '127.0.0.1');
    await once(pending, 'connect');
    const closed = new Promise<void>(resolve => pending.once('close', () => resolve()));
    abort.abort();
    await listener.stop();
    await closed;
    await expect(request(hostname, hostname)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  } finally {
    abort.abort();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'relay agent TLS fixture cleanup' });
  }
});
