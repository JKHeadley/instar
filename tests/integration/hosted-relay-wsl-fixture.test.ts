import { execFileSync, spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';
import { once } from 'node:events';
import fs from 'node:fs';
import { get } from 'node:https';
import { createServer, type AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { readLocalOwnerTicket } from '../../src/core/localOwnerTicket.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { redeemHostedRelaySetupCode } from '../../src/hostedRelay/setupReceipt.js';
import { createHostedRelayVerifiedDialer } from '../../src/hostedRelay/verifiedDialer.js';
import { localOwnerProofMessage } from '../../src/server/mobileLocalOwnerDevice.js';
import { makeDevice } from '../helpers/mobileDevice.js';

it('boots the disposable WSL fixture and accepts an enrolled client through the full relay path', async () => {
  const candidate = createServer();
  candidate.listen(0, '127.0.0.1');
  await once(candidate, 'listening');
  const { port } = candidate.address() as AddressInfo;
  await new Promise<void>(resolve => candidate.close(() => resolve()));
  const child = spawn(process.execPath, ['scripts/hosted-relay-wsl-fixture.mjs', String(port), '30'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  const stopped = once(child, 'exit');
  child.stderr.resume();
  try {
    const lines = createInterface({ input: child.stdout });
    let fixture: string | undefined;
    for await (const line of lines) {
      if (!line.startsWith('{"fixture":')) continue;
      fixture = JSON.parse(line).fixture;
      break;
    }
    expect(fixture).toBeDefined();
    const f = JSON.parse(fs.readFileSync(fixture!, 'utf8'));
    for (const [hostname, leafPath, caPath] of [
      [f.controlHostname, f.controlLeafPath, f.controlCaPath],
      [f.hostname, f.agentLeafPath, f.agentCaPath],
    ]) {
      const ca = new X509Certificate(fs.readFileSync(caPath));
      const leaf = new X509Certificate(fs.readFileSync(leafPath));
      expect(ca.ca).toBe(true);
      expect(leaf.ca).toBe(false);
      expect(leaf.verify(ca.publicKey)).toBe(true);
      if (process.platform === 'darwin') {
        execFileSync('/usr/bin/security', ['verify-cert', '-q', '-p', 'ssl', '-s', hostname, '-c', leafPath, '-r', caPath],
          { stdio: 'pipe', timeout: 5000 });
      }
    }
    const host = new URL(f.localAgentOrigin).host;
    const device = makeDevice();
    const ticket = readLocalOwnerTicket(f.root + '/.instar')!.ticket;
    const timeMs = String(Date.now());
    const enrollment = await fetch(f.localAgentOrigin + '/mobile/local-owner-device', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ticket, publicKey: device.publicKey, timeMs,
        proof: device.sign(localOwnerProofMessage(host, device.publicKey, ticket, timeMs)), label: 'fixture' }),
    });
    expect(enrollment.status).toBe(200);
    const { deviceId } = await enrollment.json();
    async function signed(method: string, route: string, body?: string) {
      const time = String(Date.now());
      return fetch(f.localAgentOrigin + route, {
        method, body, headers: {
          'Content-Type': 'application/json', 'X-Instar-Device': deviceId, 'X-Instar-Device-Time': time,
          'X-Instar-Device-Sig': device.sign(canonicalString(deviceId, host, method, route, time, body ? Buffer.from(body) : undefined)),
        },
      });
    }
    expect(await (await signed('GET', '/desktop/relay-pairing/capability')).json()).toEqual({ version: 1, available: true });
    const issued = await signed('POST', '/desktop/relay-pairing/issue', '{}');
    expect(issued.status).toBe(201);
    const { code } = await issued.json();
    const connectVerified = createHostedRelayVerifiedDialer({
      origin: 'https://localhost:' + f.controlPort, ca: fs.readFileSync(f.controlCaPath), spkiSha256: f.controlSpkiSha256,
    });
    const redeem = () => redeemHostedRelaySetupCode({ code, routingDomain: 'relay.example', connectVerified, signal: AbortSignal.timeout(5000) });
    expect((await redeem())?.hostname).toBe(f.hostname);
    expect(await redeem()).toBeUndefined();
    function throughRelay(route: string) {
      return new Promise<number | undefined>((resolve, reject) => {
        const req = get({ host: '127.0.0.1', port: f.tlsPort, servername: f.hostname, ca: fs.readFileSync(f.agentCaPath),
          headers: { Host: f.hostname }, path: route, signal: AbortSignal.timeout(5000), agent: false,
          checkServerIdentity(name, cert) {
            const spki = new X509Certificate(cert.raw).publicKey.export({ type: 'spki', format: 'der' });
            if (createHash('sha256').update(spki).digest('hex') !== f.agentSpkiSha256) return new Error('wrong agent key');
            return checkServerIdentity(name, cert);
          },
        }, res => { res.resume(); res.once('end', () => resolve(res.statusCode)); });
        req.once('error', reject);
      });
    }
    await expect(throughRelay(f.fixturePath)).resolves.toBe(200);
    await expect(throughRelay('/mobile/device')).resolves.toBe(404);
    child.kill('SIGTERM');
    expect(await stopped).toEqual([0, null]);
    expect(fs.existsSync(f.root)).toBe(false);
    await expect(fetch(f.localAgentOrigin + '/health')).rejects.toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await stopped;
  }
}, 40_000);
