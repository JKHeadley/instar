/** HTTP pipeline for several routes per agent (docs/specs/mobile-multi-route.md §4.2, §4.3). */
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { authMiddleware } from '../../src/server/middleware.js';
import { MobilePairingService, mountPublicMobilePairingRoutes, createMobilePairingRouter, deviceAuthenticator, type MobilePairingDeps } from '../../src/server/mobilePairingRoutes.js';
import { canonicalString } from '../../src/core/MobileDeviceKeys.js';
import type { TailscaleExec } from '../../src/core/MobileOwnNames.js';
import { makeDevice } from '../helpers/mobileDevice.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig } from '../../src/core/types.js';

const CF = 'echo.example.dev';
const TS = 'studio.tail1234.ts.net';
const PORT = 4042;
const dirs: string[] = [];
const services: MobilePairingService[] = [];
afterAll(() => {
  for (const s of services) s.stop();
  for (const d of dirs) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/mobile-multi-route.test.ts' });
});

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmr-int-'));
  dirs.push(dir);
  const config = {
    projectName: 'echo', projectDir: dir, stateDir: dir, port: PORT, authToken: 'tok-1', developmentAgent: true,
    tunnel: { enabled: true, type: 'named', token: 'x', hostname: CF },
  } as unknown as InstarConfig;
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody: Buffer }).rawBody = buf; } }));
  const dms: string[] = [];
  // Every self-probe reaches this same app with the probed name as Host, as the local fronts deliver it.
  const fetchFn = (async (url: string) => {
    const u = new URL(url);
    const r = await request(app).get(u.pathname + u.search).set('Host', u.hostname);
    return { ok: r.status === 200, status: r.status, json: async () => r.body } as unknown as Response;
  }) as unknown as typeof fetch;
  const exec: TailscaleExec = async (args) => args[0] === 'status'
    ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: `${TS}.` }, CertDomains: [TS] })
    : JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [`${TS}:443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${PORT}` } } } } });
  const deps: MobilePairingDeps = {
    config, stateDir: dir, tunnel: () => ({ lifecycleState: { lastState: 'active', activeProvider: 'cloudflare-named' } }), selfMachineId: 'm_self', fetchFn,
    ownerDM: async (text) => { dms.push(text); return 1; }, holdsLease: () => true, tailscaleExec: exec,
  };
  const svc = new MobilePairingService(deps);
  services.push(svc);
  mountPublicMobilePairingRoutes(app, svc);
  app.use(authMiddleware(() => config.authToken, 'echo', undefined, deviceAuthenticator(svc)));
  app.use(createMobilePairingRouter(svc, deps));
  app.get('/sessions', (_req, res) => { res.json([]); });
  return { app, svc, dms };
}

function signed(app: express.Express, dev: ReturnType<typeof makeDevice>, id: string, method: 'GET' | 'POST', p: string, host: string, body?: unknown, sendHost = host) {
  const raw = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const time = String(Date.now());
  const sig = dev.sign(canonicalString(id, host, method, p, time, raw));
  const r = method === 'GET' ? request(app).get(p) : request(app).post(p).set('Content-Type', 'application/json');
  r.set('Host', sendHost).set('X-Instar-Device', id).set('X-Instar-Device-Time', time).set('X-Instar-Device-Sig', sig);
  return raw ? r.send(raw.toString()) : r;
}

async function pairActive(ctx: ReturnType<typeof setup>) {
  const dev = makeDevice();
  const m = await request(ctx.app).post('/mobile/pairing-codes').set('Authorization', 'Bearer tok-1').send({});
  expect(m.status).toBe(200);
  // Minting proved the tunnel name as an own name at once.
  expect(ctx.svc.ownNames!.listed().map((n) => n.host)).toContain(CF);
  const r = await request(ctx.app).post('/mobile/pairing-codes/redeem').set('Host', CF).send({ code: m.body.code, deviceName: 'iPhone', devicePublicKey: dev.publicKey });
  const id = r.body.deviceId as string;
  const code = /is (\d{3}) (\d{3})\./.exec(ctx.dms[0])!.slice(1).join('');
  expect((await signed(ctx.app, dev, id, 'POST', '/mobile/device/confirm', CF, { code })).body.status).toBe('active');
  await ctx.svc.ownNames!.tick(); // proves the Tailscale name too
  return { dev, id };
}

describe('mobile multi-route', () => {
  it('the ping echoes the Host and the arrival class', async () => {
    const { app } = setup();
    const r = await request(app).get('/mobile/pairing-codes/ping?n=' + 'a'.repeat(20)).set('Host', `${TS}:443`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ host: TS, arrival: 'local-tls' });
    expect(typeof r.body.h).toBe('string');
  });

  it('with multi-route off the ping answer is exactly as before', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mmr-off-'));
    dirs.push(dir);
    const config = { projectName: 'echo', projectDir: dir, stateDir: dir, port: PORT, authToken: 'tok-1', developmentAgent: true, mobilePairing: { multiRoute: { enabled: false } } } as unknown as InstarConfig;
    const svc = new MobilePairingService({ config, stateDir: dir });
    services.push(svc);
    const app = express();
    mountPublicMobilePairingRoutes(app, svc);
    const r = await request(app).get('/mobile/pairing-codes/ping?n=' + 'a'.repeat(20));
    expect(Object.keys(r.body)).toEqual(['h']);
    expect(svc.ownNames).toBeNull();
  });

  it('one device record is accepted on the Tailscale name and on the Cloudflare name', async () => {
    const ctx = setup();
    const { dev, id } = await pairActive(ctx);
    expect(ctx.svc.devices.list()).toHaveLength(1);
    expect((await signed(ctx.app, dev, id, 'GET', '/sessions', TS)).status).toBe(200);
    expect((await signed(ctx.app, dev, id, 'GET', '/sessions', CF)).status).toBe(200);
    expect((await signed(ctx.app, dev, id, 'GET', '/sessions', TS, undefined, `${TS}:443`)).status).toBe(200);
  });

  it('a foreign host is refused', async () => {
    const ctx = setup();
    const { dev, id } = await pairActive(ctx);
    const r = await signed(ctx.app, dev, id, 'GET', '/sessions', 'other-machine.example.dev');
    expect(r.status).toBe(401);
    expect(r.body.error).toBe('device-unauthorized');
  });

  it('a request captured on one name is not accepted on a second name', async () => {
    const ctx = setup();
    const { dev, id } = await pairActive(ctx);
    // Signed for the Cloudflare name, delivered on the Tailscale name.
    const r = await signed(ctx.app, dev, id, 'GET', '/sessions', CF, undefined, TS);
    expect(r.status).toBe(401);
  });

  it('GET /mobile/routes through production auth: device-signed only, Tailscale first', async () => {
    const ctx = setup();
    const { dev, id } = await pairActive(ctx);
    const r = await signed(ctx.app, dev, id, 'GET', '/mobile/routes', TS);
    expect(r.status).toBe(200);
    expect(r.body.machineId).toBe('m_self');
    expect(r.body.version).toBe(ctx.svc.ownNames!.version);
    expect(r.body.routes.map((x: { kind: string; origin: string }) => `${x.kind} ${x.origin}`)).toEqual([`tailscale https://${TS}`, `cloudflare https://${CF}`]);
    expect(r.body.routes[0]).toMatchObject({ lastProbeOk: true });
    expect(typeof r.body.routes[0].firstVerifiedAt).toBe('string');
    const bearer = await request(ctx.app).get('/mobile/routes').set('Authorization', 'Bearer tok-1');
    expect(bearer.status).toBe(403);
  });
});
