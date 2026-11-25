import express from 'express';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { expect, it, vi } from 'vitest';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createDesktopRelayPairingRoutes } from '../../src/server/desktopRelayPairingRoutes.js';
import { authMiddleware } from '../../src/server/middleware.js';
import { deviceAuthenticator, MobilePairingService, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { makeDevice } from '../helpers/mobileDevice.js';

it('allows only native local-owner signatures on the disposable relay listener', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-relay-routes-'));
  const host = '127.0.0.1:4747';
  const authToken = 'fixture-auth';
  const { machineId } = await new MachineIdentityManager(dir).generateIdentity({ name: 'Relay route test' });
  const svc = new MobilePairingService({
    config: { projectName: 'relay-test', stateDir: dir, authToken, developmentAgent: true, mobilePairing: { enabled: true, native: { enabled: true } } },
    stateDir: dir, holdsLease: () => true, selfMachineId: machineId,
  } as unknown as MobilePairingDeps);
  try {
    svc.nativeOn = true;
    svc.keyLedger = new MobileDeviceKeyLedger({ stateDir: dir, signer: loadMachineSigner(dir)!, keyLookup: identityKeyLookup(dir) });
    const owner = makeDevice();
    const created = svc.devices.createActiveLocalOwner({
      id: randomUUID(), label: 'Windows test', host, machineId,
      publicKey: owner.publicKey, approvedAt: new Date().toISOString(),
    });
    if (!created.ok) throw new Error('owner fixture rejected');
    const phone = makeDevice();
    const other = svc.devices.createPending({ deviceName: 'Phone', label: null, publicKey: phone.publicKey, host });
    if (!other.ok) throw new Error('phone fixture rejected');
    svc.devices.applyConfirm(other.device.id, { ok: true });

    let available = false;
    let revokeDuringIssuance = false;
    const code = 'a'.repeat(32);
    const issuePairingCode = vi.fn(async () => {
      if (!available) throw new Error('relay-unavailable');
      if (revokeDuringIssuance) svc.devices.revoke(created.device.id, new Date().toISOString());
      return { code, expiresInSeconds: 600, internal: 'never exposed' };
    });
    function app(enabled: boolean) {
      const server = express();
      server.use(express.json({ verify: (req, _res, raw) => { Object.assign(req, { rawBody: raw }); } }));
      server.use(authMiddleware(() => authToken, 'relay-test', undefined, deviceAuthenticator(svc, { desktopRelayLoopback: enabled })));
      server.use(createDesktopRelayPairingRoutes(svc, () => ({ available: () => available, issuePairingCode })));
      return server;
    }
    const server = app(true);
    const capability = '/desktop/relay-pairing/capability';
    const issue = '/desktop/relay-pairing/issue';
    let tick = 0;
    function signed(method: 'GET' | 'POST', route: string, body?: string, device = owner, id = created.device.id, listener = server) {
      const time = String(Date.now() + ++tick);
      const signature = device.sign(canonicalString(id, host, method, route, time, body === undefined ? undefined : Buffer.from(body)));
      const r = (method === 'GET' ? request(listener).get(route) : request(listener).post(route))
        .set('Host', host).set('X-Instar-Device', id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', signature);
      return body === undefined ? r : r.set('Content-Type', 'application/json').send(body);
    }

    await request(server).get(capability).set('Host', host).set('Authorization', 'Bearer ' + authToken).expect(401);
    await signed('GET', capability, undefined, phone, other.device.id).expect(401);
    await signed('GET', capability, undefined, owner, created.device.id, app(false)).expect(403);
    await signed('GET', capability).set('X-Forwarded-For', '127.0.0.1').expect(401);
    await signed('GET', capability).set('Host', 'localhost:4747').expect(401);
    await signed('GET', capability).expect(200, { version: 1, available: false });
    await signed('POST', issue, '{"extra":true}').expect(400, { error: 'invalid-request' });
    await signed('POST', issue, '{}').expect(409, { error: 'relay-unavailable' });
    available = true;
    await signed('GET', capability).expect(200, { version: 1, available: true });
    await signed('POST', issue, '{}').expect('Cache-Control', 'no-store').expect(201, { code, expiresInSeconds: 600 });
    revokeDuringIssuance = true;
    await signed('POST', issue, '{}').expect(401, { error: 'unauthenticated' });
    expect(issuePairingCode).toHaveBeenCalledTimes(3);
  } finally {
    svc.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'desktop relay pairing route fixture cleanup' });
  }
});
