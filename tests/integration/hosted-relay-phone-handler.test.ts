import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { request as httpsRequest } from 'node:https';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { expect, it } from 'vitest';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { deviceKeyHashOf, identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { startHostedRelayAgentTlsListener } from '../../src/hostedRelay/agentTlsListener.js';
import { createHostedRelayPhoneHandler } from '../../src/server/hostedRelayPhoneHandler.js';
import { MobilePairingService, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { makeDevice } from '../helpers/mobileDevice.js';

it('serves only the assignment-bound native phone status on a marked relay TLS connection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-relay-phone-'));
  const controller = new AbortController();
  const hostname = 'agent.relay.example';
  const assignment = 'a'.repeat(64);
  const { machineId } = await new MachineIdentityManager(root).generateIdentity({ name: 'Relay phone fixture' });
  const svc = new MobilePairingService({
    config: { projectName: 'relay-fixture', stateDir: root, authToken: 'fixture-token', developmentAgent: true,
      mobilePairing: { enabled: true, native: { enabled: true } } },
    stateDir: root, selfMachineId: machineId, holdsLease: () => true,
  } as unknown as MobilePairingDeps);
  try {
    svc.nativeOn = true;
    const ledger = new MobileDeviceKeyLedger({ stateDir: root, signer: loadMachineSigner(root)!, keyLookup: identityKeyLookup(root) });
    svc.keyLedger = ledger;
    const certPath = path.join(root, 'agent.pem');
    const keyPath = path.join(root, 'agent.key');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=' + hostname, '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 10_000 });
    const cert = fs.readFileSync(certPath);
    const key = fs.readFileSync(keyPath);
    const expectedSpkiSha256 = createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    const phone = makeDevice();
    const created = svc.devices.createPending({ deviceName: 'Fixture phone', label: null, publicKey: phone.publicKey, host: 'original.example' });
    if (!created.ok) throw new Error('phone fixture failed');
    const id = created.device.id;
    svc.devices.applyConfirm(id, { ok: true });
    let enrolledAssignment = assignment;
    let enrolledKeyHash = deviceKeyHashOf(phone.publicKey);
    const app = createHostedRelayPhoneHandler(svc, key => key === id ? { hostname, assignment: enrolledAssignment, keyHash: enrolledKeyHash } : undefined);
    await request(app).get('/mobile/device').set('Host', hostname).set('X-Forwarded-Host', hostname).expect(404);
    const listener = await startHostedRelayAgentTlsListener({
      hostname, assignment, cert, key, expectedSpkiSha256, signal: controller.signal, handlePhoneRequest: app,
    });
    let tick = 0;
    const send = (method: string, route: string, signingHost?: string) => new Promise<{ status?: number; body: string }>((resolve, reject) => {
      const time = String(Date.now() + ++tick);
      const headers = signingHost ? {
        Host: hostname, 'X-Instar-Device': id, 'X-Instar-Device-Time': time,
        'X-Instar-Device-Sig': phone.sign(canonicalString(id, signingHost, method, route, time, undefined)),
      } : { Host: hostname, Authorization: 'Bearer fixture-token' };
      const req = httpsRequest({ host: '127.0.0.1', port: listener.port, servername: hostname, ca: cert, headers,
        method, path: route, signal: AbortSignal.timeout(5000), agent: false }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', part => { body += part; });
        res.once('end', () => resolve({ status: res.statusCode, body }));
        res.once('error', reject);
      });
      req.once('error', reject);
      req.end();
    });
    expect((await send('GET', '/mobile/device')).status).toBe(401);
    expect((await send('GET', '/mobile/device', 'original.example')).status).toBe(401);
    expect((await send('GET', '/mobile/device?extra=1', hostname)).status).toBe(404);
    expect((await send('POST', '/mobile/pairing-codes/redeem', hostname)).status).toBe(404);
    expect((await send('GET', '/desktop/relay-pairing/capability', hostname)).status).toBe(404);
    svc.nativeOn = false;
    expect((await send('GET', '/mobile/device', hostname)).status).toBe(403);
    svc.nativeOn = true;
    svc.keyLedger = null;
    expect((await send('GET', '/mobile/device', hostname)).status).toBe(403);
    svc.keyLedger = ledger;
    const accepted = await send('GET', '/mobile/device', hostname);
    expect(accepted.status).toBe(200);
    expect(JSON.parse(accepted.body)).toMatchObject({ status: 'active', deviceName: 'Fixture phone' });
    enrolledAssignment = 'b'.repeat(64);
    expect((await send('GET', '/mobile/device', hostname)).status).toBe(401);
    enrolledAssignment = assignment;
    enrolledKeyHash = 'c'.repeat(64);
    expect((await send('GET', '/mobile/device', hostname)).status).toBe(401);
    enrolledKeyHash = deviceKeyHashOf(phone.publicKey);
    ledger.recordRevocation(svc.devices.get(id)!, new Date().toISOString());
    expect((await send('GET', '/mobile/device', hostname)).status).toBe(401);
    controller.abort();
    await listener.stop();
  } finally {
    controller.abort();
    svc.stop();
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'relay phone handler fixture cleanup' });
  }
});
