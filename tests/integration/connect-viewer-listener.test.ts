import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ConnectViewerAuthority } from '../../src/core/ConnectViewerAuthority.js';
import { startConnectViewerListener } from '../../src/server/connectViewerListener.js';

it('boots only on opt-in, enforces TLS and exact routing, and closes', async () => {
  expect(await startConnectViewerListener()).toBeUndefined();
  const dir = mkdtempSync(path.join(tmpdir(), 'connect-listener-'));
  try {
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const cert = readFileSync(path.join(dir, 'cert.pem'));
    const server = (await startConnectViewerListener({
      tls: { cert, key: readFileSync(path.join(dir, 'key.pem')) },
      authority: new ConnectViewerAuthority(),
    }))!;
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Expected a TCP listener');
      expect(address.address).toBe('127.0.0.1');
      const port = address.port;
      function post(route: string, servername = 'localhost', ca: Buffer | undefined = cert) {
        return new Promise<number>((resolve, reject) => {
          const req = https.request({
            host: '127.0.0.1', port, servername, ca, path: route,
            method: 'POST', agent: false, headers: { 'content-type': 'application/json' },
          }, res => {
            res.resume();
            resolve(res.statusCode!);
          });
          req.once('error', reject);
          req.end('{}');
        });
      }
      const route = '/desktop/connect/viewer/enroll';
      await expect(post(route, 'unrelated.test')).rejects.toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
      await expect(post(route)).resolves.toBe(400);
      await expect(post(route + '/')).resolves.toBe(404);
      await expect(post(route.toUpperCase())).resolves.toBe(404);
      await expect(post('/health')).resolves.toBe(404);
      await expect(post(route + '?extra=1')).resolves.toBe(404);
      for (let i = 0; i < 25; i++) await expect(post(route)).resolves.toBe(400);
      await expect(post(route)).resolves.toBe(429);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      expect(server.listening).toBe(false);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
