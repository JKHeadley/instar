import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, expect, it } from 'vitest';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { identityKeyLookup, loadMachineSigner } from '../../src/core/AppRecordSignatures.js';
import { MobileDeviceKeyLedger } from '../../src/core/MobileDeviceKeyLedger.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { MobilePairingService, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { createSignedLocalHistoryIntake, SIGNED_LOCAL_HISTORY_PREFIX, type SignedLocalHistoryIntakeService }
  from '../../src/server/signedLocalHistoryIntake.js';
import { makeDevice } from '../helpers/mobileDevice.js';

const host = 'synthetic-history.example.test';
const applyPath = SIGNED_LOCAL_HISTORY_PREFIX + '/apply';
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

async function fixture() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signed-history-intake-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'signed history fixture' }));
  const identity = new MachineIdentityManager(stateDir);
  await identity.generateIdentity({ name: 'Synthetic intake machine' });
  const owner = { id: 'synthetic-owner', name: 'Synthetic Owner', permissions: ['owner'], channels: [], preferences: {} };
  fs.writeFileSync(path.join(stateDir, 'users.json'), JSON.stringify([owner]));
  const config = { projectName: 'synthetic-intake', stateDir, authToken: 'test-bearer', developmentAgent: true,
    mobilePairing: { enabled: true, native: { enabled: true }, multiRoute: { enabled: false } }, users: [owner] } as never;
  const pairing = new MobilePairingService({ config, stateDir, holdsLease: () => true } as MobilePairingDeps);
  pairing.nativeOn = true;
  pairing.keyLedger = new MobileDeviceKeyLedger({ stateDir, signer: loadMachineSigner(stateDir)!, keyLookup: identityKeyLookup(stateDir) });
  cleanups.push(() => pairing.stop());
  const phone = makeDevice();
  const enrolled = pairing.devices.createPending({ publicKey: phone.publicKey, host, userId: owner.id,
    role: 'owner', deviceName: 'Synthetic owner phone', label: null });
  if (!enrolled.ok) throw new Error('synthetic enrollment refused');
  pairing.devices.applyConfirm(enrolled.device.id, { ok: true });
  pairing.keyLedger.reconcile(pairing.devices);
  const app = express();
  let selected: SignedLocalHistoryIntakeService | undefined;
  app.use(createSignedLocalHistoryIntake({ pairing, service: () => selected, wireBytes: 8192 }));
  app.get('/unrelated', (_req, res) => res.status(204).end());
  let lastTime = 0;
  const send = (body: Buffer, signedBytes = body, url = applyPath, contentType = 'application/octet-stream') => {
    const time = String(lastTime = Math.max(lastTime + 1, Date.now()));
    return request(app).post(url).set('Host', host).set('Content-Type', contentType).set('X-Instar-Device', enrolled.device.id)
      .set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', phone.sign(canonicalString(enrolled.device.id, host, 'POST', url, time, signedBytes)))
      .send(body);
  };
  return { app, send, select(service: SignedLocalHistoryIntakeService) { selected = service; }, deviceId: enrolled.device.id };
}

it('is dark with no service and authenticates the exact signed bytes before dispatch', async () => {
  const f = await fixture();
  const bytes = crypto.randomBytes(32);
  expect((await f.send(bytes)).status).toBe(503);
  let dispatches = 0;
  f.select({ async withExchange(work) { await work(); return true; }, dispatch(input) {
    dispatches++;
    expect(input.pathname).toBe(applyPath);
    expect(input.body.equals(bytes)).toBe(true);
    expect(input.device).toMatchObject({ deviceId: f.deviceId, ownerUserId: 'synthetic-owner' });
    return { status: 202, type: 'application/octet-stream', body: Buffer.from('synthetic receipt') };
  } });
  expect((await request(f.app).post(applyPath).set('Authorization', 'Bearer test-bearer')
    .set('Content-Type', 'application/octet-stream').send(bytes)).status).toBe(403);
  expect((await f.send(bytes, crypto.randomBytes(32))).status).toBe(401);
  expect((await f.send(bytes, bytes, applyPath.toUpperCase())).status).toBe(404);
  expect((await f.send(bytes, bytes, applyPath, 'text/plain')).status).toBe(400);
  expect((await f.send(Buffer.alloc(8193))).status).toBe(400);
  const reply = await f.send(bytes);
  expect(reply.status).toBe(202);
  expect(reply.body).toEqual(Buffer.from('synthetic receipt'));
  expect(dispatches).toBe(1);
  expect((await request(f.app).get('/unrelated')).status).toBe(204);
});

it('keeps one exchange until an abandoned signed dispatch settles and clears borrowed bytes', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const cleanupEntered = Promise.withResolvers<void>(), cleanupRelease = Promise.withResolvers<void>();
  let signal: AbortSignal | undefined, borrowed: Buffer | undefined;
  f.select({ async withExchange(work) { await work(); return true; }, async dispatch(input) {
    signal = input.signal; borrowed = input.body;
    input.onDispose(async () => { cleanupEntered.resolve(); await cleanupRelease.promise; });
    entered.resolve();
    await release.promise;
    return { status: 200, type: 'application/octet-stream', body: Buffer.from('synthetic receipt') };
  } });
  const bytes = crypto.randomBytes(32);
  const sent = f.send(bytes);
  void sent.then(() => {}, () => {});
  try {
    await entered.promise;
    const closed = new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    sent.abort();
    await closed;
    expect((await f.send(bytes)).status).toBe(429);
    expect(borrowed?.equals(bytes)).toBe(true);
    release.resolve();
    await cleanupEntered.promise;
    expect((await f.send(bytes)).status).toBe(429);
  } finally {
    release.resolve(); cleanupRelease.resolve();
  }
  await new Promise(resolve => setImmediate(resolve));
  expect(borrowed?.equals(Buffer.alloc(bytes.length))).toBe(true);
  expect((await f.send(bytes)).status).toBe(200);
});
