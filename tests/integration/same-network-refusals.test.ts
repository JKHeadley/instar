/**
 * The home listener's refusal log over the real HTTP pipeline (builder #63): a phone's refused requests
 * on the same-network listener (real TLS 1.3, the agent's own certificate, a stand-in phone that pins the
 * scanned hash) are recorded with route, status, reason code and device id prefix only, and the owner's
 * computer reads them back through GET /mobile/same-network/refusals (bearer, from this computer only).
 */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, DEVICE_ALLOWLIST, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { SameNetworkListener } from '../../src/server/sameNetworkListener.js';
import { SAME_NETWORK_REFUSALS_FILE } from '../../src/server/sameNetworkRefusals.js';
import { sameNetworkGate, homeAddressInUse } from '../../src/server/phoneSetupRoutes.js';
import type { NetworkObservation } from '../../src/core/SameNetworkNetwork.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { pinnedRequest, signedHeaders } from '../helpers/pinnedPhone.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const PIN = '482915';
const HOME: NetworkObservation = { kind: 'observed', network: { iface: 'wlan0', router: '192.168.1.1', address: '192.168.1.20', range: '192.168.1.0/24' } };
const dirs: string[] = [];
const cleanups: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const c of cleanups) await c();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/same-network-refusals.test.ts' });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'sn-ref-'));
  dirs.push(dir);
  const config = {
    projectName: 'Wintest', projectDir: dir, stateDir: dir, port: 4321, authToken: 'tok-1', developmentAgent: true, dashboardPin: PIN,
    mobilePairing: { multiRoute: { enabled: false } },
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const deps: MobilePairingDeps = { config, stateDir: dir, selfMachineId: 'm_self', holdsLease: () => true, telegramOwnerPresent: () => false, ownerDM: async () => 7 };
  const svc = new MobilePairingService(deps);
  const listener: SameNetworkListener = new SameNetworkListener({
    stateDir: dir, agentName: 'Wintest', machineName: 'DESKTOP-1', mainPort: 4321, app, port: 0, bindHost: '127.0.0.1', wsl: false, announce: false,
    observe: async () => HOME, inUse: () => homeAddressInUse(svc),
    gate: sameNetworkGate({ device: (id) => svc.devices.get(id), deviceRoute: (m, p) => DEVICE_ALLOWLIST.some((r) => r.method === m && r.re.test(p)), ownHost: () => (listener.listening() ? listener.host() : null) }),
  });
  svc.sameNetwork = listener;
  cleanups.push(async () => { await listener.stop(); svc.stop(); });
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'Wintest', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps, { config, resolvePeerUrls: () => [] } as unknown as Parameters<typeof createMobilePairingRouter>[2]));
  return { app, svc, listener, dir };
}
const bearer = (q: request.Test) => q.set('Authorization', 'Bearer tok-1');

describe('the home listener\'s refusal log', () => {
  it('records what the home listener refused, without secrets, and the computer reads it back', async () => {
    const ctx = setup();
    const s = await bearer(request(ctx.app).post('/mobile/phone-setup')).send({ pin: PIN });
    expect(s.status).toBe(200);
    const q = new URLSearchParams(String(s.body.link).split('#')[1]);
    const host = q.get('h')!; const pin = q.get('k')!; const code = q.get('c')!;
    const port = Number(host.split(':')[1]);
    const dev = makeDevice();
    const r = await pinnedRequest({ port, pin, method: 'POST', path: '/mobile/pairing-codes/redeem', body: JSON.stringify({ code, deviceName: 'Phone', devicePublicKey: dev.publicKey, pinnedKeyHash: pin }) });
    expect(r.status).toBe(200);
    const deviceId = String(r.json.deviceId);

    // The gate: a computer-only route on the home listener, with a secret-looking query.
    const g = await pinnedRequest({ port, pin, method: 'GET', path: `/mobile/phone-setup/${s.body.setupId}?pin=${PIN}` });
    expect(g.status).toBe(404);
    // Behind the gate: the waiting phone signs a route it may not use yet, then sends a bad signature.
    const signed = await pinnedRequest({ port, pin, method: 'GET', path: '/mobile/device', headers: signedHeaders(dev, deviceId, host, 'GET', '/mobile/device') });
    const bad = await pinnedRequest({ port, pin, method: 'GET', path: '/mobile/device', headers: { ...signedHeaders(dev, deviceId, host, 'GET', '/mobile/device'), 'X-Instar-Device-Sig': 'AAAA' } });
    expect(bad.status).toBeGreaterThanOrEqual(400);

    const read = await bearer(request(ctx.app).get('/mobile/same-network/refusals'));
    expect(read.status).toBe(200);
    const entries = read.body.refusals as Array<Record<string, unknown>>;
    expect(entries.find((e) => e.route === '/mobile/phone-setup/:id')).toMatchObject({ kind: 'request', status: 404, reason: 'not-found', method: 'GET' });
    const badEntry = entries.find((e) => e.route === '/mobile/device' && e.status === bad.status && e.reason === (typeof bad.json.error === 'string' && /^[a-z][a-z0-9-]*$/.test(bad.json.error) ? bad.json.error : `http-${bad.status}`));
    expect(badEntry).toMatchObject({ kind: 'request', device: deviceId.slice(0, 8), from: '127.0.0.1' });
    if (signed.status >= 400) expect(entries.some((e) => e.route === '/mobile/device' && e.status === signed.status)).toBe(true);
    // Newest first, and a limit is honoured.
    expect(entries[0].status).toBe(bad.status);
    expect((await bearer(request(ctx.app).get('/mobile/same-network/refusals?limit=1'))).body.refusals).toHaveLength(1);

    // Kept on disk without the setup id, the PIN, the signature or the full device id.
    await ctx.listener.stop();
    const text = fs.readFileSync(path.join(ctx.dir, SAME_NETWORK_REFUSALS_FILE), 'utf8');
    for (const secret of [String(s.body.setupId), PIN, deviceId, 'AAAA', code]) expect(text).not.toContain(secret);
  });

  it('is for this computer only: a forwarded request or no token is refused', async () => {
    const ctx = setup();
    expect((await request(ctx.app).get('/mobile/same-network/refusals')).status).toBe(401);
    expect((await bearer(request(ctx.app).get('/mobile/same-network/refusals')).set('X-Forwarded-For', '203.0.113.9')).status).toBe(403);
    const ok = await bearer(request(ctx.app).get('/mobile/same-network/refusals'));
    expect(ok.status).toBe(200);
    expect(ok.body.refusals).toEqual([]);
  });
});
